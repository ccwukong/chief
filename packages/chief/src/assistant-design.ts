import { validateWorkflow } from "./workflow/load.ts";
import { nodeSchema } from "./workflow/schema.ts";
import { describeCron } from "./util/cron.ts";

/**
 * The assistant in the designer (task 9.65): it builds and changes the workflow on the canvas as
 * the conversation goes. The agent still has no tools. It is given the canvas as text and, when a
 * change is asked for, ends its reply with the complete workflow in a `chief-workflow` block. chief
 * checks that block like any workflow and hands it to the page, which puts it on the canvas; the
 * designer's own autosave stores it, so there is one way a workflow is written.
 *
 * Nothing in here knows what a workflow is for.
 */

/** A change the assistant made: the canvas before and after, and what differs, in words. */
export interface WorkflowChange { workflow: string; before: any; after: any; summary: string[] }
/** Choices the assistant offers the person; the panel adds a free-text entry of its own. */
export interface AssistantOptions { question: string; options: string[] }

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** The definition without the canvas layout: the agent neither sees nor sets positions. */
export function withoutLayout(def: any): any {
  const d = clone(def) ?? {};
  if (Array.isArray(d.nodes)) for (const n of d.nodes) if (n && typeof n === "object") delete n.position;
  return d;
}

/** One text per workflow, whatever the layout and the spelling of defaults: used to tell whether the canvas changed. */
export function canonical(def: any): string {
  const bare = withoutLayout(def);
  const v = validateWorkflow(clone(bare));
  return JSON.stringify(v.ok ? withoutLayout(v.workflow) : bare);
}

const BLOCK = (tag: string) => new RegExp("```" + tag + "[^\\n]*\\n([\\s\\S]*?)\\n```", "g");

/** Take the `chief-workflow`, `chief-options` and `chief-schedule` blocks out of a reply. The last of each counts. */
export function readReply(text: string): { text: string; workflow?: unknown; workflowError?: string; options?: AssistantOptions; schedule?: ScheduleProposal; scheduleError?: string } {
  const out: ReturnType<typeof readReply> = { text };
  const wf = [...text.matchAll(BLOCK("chief-workflow"))].at(-1);
  if (wf) {
    try {
      out.workflow = JSON.parse(wf[1]);
      if (!out.workflow || typeof out.workflow !== "object" || Array.isArray(out.workflow)) { out.workflow = undefined; out.workflowError = "the chief-workflow block must hold one JSON object"; }
    } catch (e: any) { out.workflowError = `the chief-workflow block is not valid JSON: ${e.message}`; }
  }
  const op = [...text.matchAll(BLOCK("chief-options"))].at(-1);
  if (op) {
    try {
      const o = JSON.parse(op[1]);
      const options = (Array.isArray(o) ? o : o?.options ?? []).filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => x.trim()).slice(0, 6);
      if (options.length) out.options = { question: typeof o?.question === "string" ? o.question.trim() : "", options };
    } catch { /* options that cannot be read are left out; the answer still stands */ }
  }
  const sc = [...text.matchAll(BLOCK("chief-schedule"))].at(-1);
  if (sc) {
    const read = readScheduleBlock(sc[1]);
    if (read.proposal) out.schedule = read.proposal;
    else out.scheduleError = read.error!;
  }
  out.text = text.replace(BLOCK("chief-workflow"), "").replace(BLOCK("chief-options"), "").replace(BLOCK("chief-schedule"), "").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

/**
 * What the assistant asked to change about a workflow's schedules. It is a request, not a write: chief
 * checks it against the workflow (and the cron parser) and the page sends it to `/api/schedules`, the
 * same endpoint the Schedules form uses. The agent still has no tools — this is how it asks.
 */
export interface ScheduleProposal {
  action: "create" | "update" | "delete";
  /** The workflow to schedule; left out means the one on the canvas. */
  workflow?: string;
  /** The schedule to change or delete, for `update` and `delete`. */
  id?: number;
  cron?: string;
  inputs?: Record<string, unknown>;
  enabled?: boolean;
}

/** The shape of a `chief-schedule` block, checked as text. The workflow and cron are checked later, with the store. */
export function readScheduleBlock(json: string): { proposal?: ScheduleProposal; error?: string } {
  let v: any;
  try { v = JSON.parse(json); } catch (e: any) { return { error: `the chief-schedule block is not valid JSON: ${e.message}` }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "the chief-schedule block must hold one JSON object" };
  const action = v.action;
  if (action !== "create" && action !== "update" && action !== "delete") return { error: 'a chief-schedule block needs `action`: "create", "update" or "delete"' };
  if (v.workflow !== undefined && (typeof v.workflow !== "string" || !v.workflow.trim())) return { error: "`workflow` must be the name of a workflow" };
  if (v.inputs !== undefined && (!v.inputs || typeof v.inputs !== "object" || Array.isArray(v.inputs))) return { error: "`inputs` must be one JSON object" };
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") return { error: "`enabled` must be true or false" };
  if (action === "create") {
    if (typeof v.cron !== "string" || !v.cron.trim()) return { error: "a new schedule needs `cron`: a five-field cron expression" };
  } else if (action === "delete") {
    // Nothing else: a delete names a schedule and that is all it does, so a block carrying a `cron` too is a mistake
    // worth saying rather than ignoring.
    if (!Number.isInteger(v.id) || v.id < 1) return { error: "deleting a schedule needs its `id`, as shown in the list of this workflow's schedules" };
    if (v.cron !== undefined || v.inputs !== undefined || v.enabled !== undefined) return { error: 'a `delete` carries only `id` (and `workflow` if it is not the one in view)' };
  } else {
    if (!Number.isInteger(v.id) || v.id < 1) return { error: "changing a schedule needs its `id`, as shown in the list of this workflow's schedules" };
    if (v.cron !== undefined && (typeof v.cron !== "string" || !v.cron.trim())) return { error: "`cron` must be a five-field cron expression" };
    if (v.cron === undefined && v.enabled === undefined && v.inputs === undefined) return { error: "an update must change something: `cron`, `inputs` or `enabled`" };
  }
  return { proposal: { action, workflow: typeof v.workflow === "string" ? v.workflow.trim() : undefined, id: v.id, cron: typeof v.cron === "string" ? v.cron.trim() : undefined, inputs: v.inputs, enabled: v.enabled } };
}

/** Every step that can carry these fields: the top-level steps, a map's inner step, and compensations. */
function parts(def: any): { where: string; node: any }[] {
  const out: { where: string; node: any }[] = [];
  for (const n of Array.isArray(def?.nodes) ? def.nodes : []) {
    if (!n || typeof n !== "object") continue;
    out.push({ where: String(n.id), node: n });
    if (n.compensate) out.push({ where: `${n.id} (compensation)`, node: n.compensate });
    if (n.node && typeof n.node === "object") {
      out.push({ where: `${n.id} (inner step)`, node: n.node });
      if (n.node.compensate) out.push({ where: `${n.id} (inner step's compensation)`, node: n.node.compensate });
    }
  }
  return out;
}

/**
 * Check a workflow the assistant proposed. On top of the usual check: it may not touch what a
 * person decides in the designer from the agent CLI's own lists (model, agent CLI) or approves
 * there (a script's sandbox).
 */
export function checkProposal(before: any, raw: unknown): { ok: boolean; errors: string[]; warnings: string[]; workflow?: any } {
  const v = validateWorkflow(clone(raw));
  const errors = [...v.errors];
  const had = parts(before);
  const sandboxes = new Set(had.filter((p) => p.node.sandbox).map((p) => JSON.stringify(p.node.sandbox)));
  const models = new Set(had.map((p) => p.node.model).filter(Boolean));
  const agents = new Set([before?.agent, ...had.map((p) => p.node.agent)].filter(Boolean));
  for (const p of parts(raw)) {
    if (p.node.sandbox && typeof p.node.sandbox === "object" && !sandboxes.has(JSON.stringify(p.node.sandbox))) errors.push(`step "${p.where}": \`sandbox\` (network, write, env) is granted and approved by the person in the step's panel; leave it out or exactly as it was`);
    if (p.node.model && !models.has(p.node.model)) errors.push(`step "${p.where}": \`model\` is chosen by the person from the agent CLI's list; leave it out, or as it was`);
    if (p.node.agent && !agents.has(p.node.agent)) errors.push(`step "${p.where}": \`agent\` (the agent CLI) is chosen by the person; leave it out, or as it was`);
  }
  if ((raw as any)?.agent && !agents.has((raw as any).agent)) errors.push("`agent` (the workflow's agent CLI) is chosen by the person; leave it out, or as it was");
  // The format between steps is the assistant's to get right: a step that reads a field its producer's schema does not name is sent back.
  errors.push(...v.warnings.filter((w) => w.includes("which the output schema of")));
  if (errors.length) return { ok: false, errors, warnings: v.warnings };
  return { ok: true, errors: [], warnings: v.warnings, workflow: withoutLayout(v.workflow) };
}

/** What differs between two definitions, in a few short lines. */
export function summarizeChange(before: any, after: any): string[] {
  const out: string[] = [];
  const b = withoutLayout(before), a = withoutLayout(after);
  const bn = new Map<string, any>((b.nodes ?? []).map((n: any) => [n.id, n])), an = new Map<string, any>((a.nodes ?? []).map((n: any) => [n.id, n]));
  if (!bn.size && an.size) out.push(`New workflow "${a.name}"`);
  else if ((b.name ?? "") !== (a.name ?? "")) out.push(`Renamed to "${a.name}"`);
  const added = [...an.keys()].filter((k) => !bn.has(k));
  const removed = [...bn.keys()].filter((k) => !an.has(k));
  // Compared as chief reads them, so that a default written out is not a change.
  const norm = (n: any) => { const p = nodeSchema.safeParse(n); return JSON.stringify(p.success ? p.data : n); };
  const same = (x: any, y: any) => norm(x) === norm(y);
  const changed = [...an.keys()].filter((k) => bn.has(k) && !same(bn.get(k), an.get(k)));
  if (added.length) out.push(`Added: ${added.join(", ")}`);
  if (removed.length) out.push(`Removed: ${removed.join(", ")}`);
  if (changed.length) out.push(`Changed: ${changed.join(", ")}`);
  const edge = (e: any) => (typeof e === "string" ? e.split("->").map((s: string) => s.trim()).join(" → ") : `${e.from} → ${e.to}`);
  const be = new Set<string>((b.edges ?? []).map(edge)), ae = new Set<string>((a.edges ?? []).map(edge));
  const connected = [...ae].filter((e) => !be.has(e)), cut = [...be].filter((e) => !ae.has(e));
  if (connected.length) out.push(`Connected: ${connected.join(", ")}`);
  if (cut.length) out.push(`Disconnected: ${cut.join(", ")}`);
  const settings = (["description", "budget", "inputs", "agent"] as const).filter((k) => JSON.stringify(b[k] ?? (k === "inputs" ? {} : null)) !== JSON.stringify(a[k] ?? (k === "inputs" ? {} : null)));
  if (settings.length) out.push(`Workflow settings: ${settings.join(", ")}`);
  return out;
}

// ── what the agent is told ─────────────────────────────────────────────────

/**
 * What the assistant may do about schedules, in both modes: the designer and the panel opened elsewhere.
 * Shared so the two cannot describe the same block differently (task 15.32).
 */
export const SCHEDULE_INSTRUCTIONS = [
  "## Schedules",
  "A workflow can start itself on a cron schedule. The list below gives each workflow's schedules with their ids; use those ids. To add or change one, end your reply with a fenced block whose first line is ```chief-schedule holding one JSON object, and chief writes it straight away:",
  '- New: {"action": "create", "cron": "0 9 * * 1-5", "inputs": {}} — five fields, minutes first, in the machine\'s own time zone. It belongs to the workflow this conversation is about; name that workflow in `workflow` when the conversation is not about one in particular.',
  '- Change: {"action": "update", "id": 3, "cron": "30 18 * * *"} — any of `cron`, `inputs`, or `enabled` (false pauses it, true starts it again). The id must belong to the workflow this conversation is about; to change another workflow\'s schedule, name that workflow in `workflow` and only do it when the person asked for it by name.',
  '- Delete: {"action": "delete", "id": 3} — it stops firing and its settings go with it. Runs it already started are kept.',
  "These are the things you can carry out: everything else you explain or put on the canvas. Say the time in words in your reply (\"every weekday at 09:00\") as well as giving the expression, so the person can check it at a glance, and never send this block when the person is only asking about a schedule.",
  "A person may quote a schedule as `#3`: that is the `id` in the list, and it is what they mean. The `inputs` are the JSON the run is started with — the same values the Schedules form asks for — so write them out in full when adding a schedule that needs them: a schedule whose workflow would be refused for a missing input is refused when it is written.",
  "",
];

/**
 * The workflow language, and the discipline of the data between steps.
 *
 * Shared, not the designer's alone: a person who describes a workflow from anywhere in the panel expects one — the
 * panel on a run's page, or on chief as a whole — and the agent cannot write a valid one without being told the
 * format. That is what went wrong on 2026-11-23: asked from outside the designer, it answered *"chief hasn't given me
 * a format for workflow changes in this conversation"*, which was true, and then described a design to build by hand.
 */
/**
 * What to do when a description is too thin to build. Shared by both modes, because the report on 2026-11-23 could have
 * come from either: *"the first response should suggest me how to improve my description, or provide some recommendations
 * rather than asking me to directly do it the manual way"*.
 */
export const ASK_WHEN_THIN = [
  "- **When the request is too thin to build, ask — do not hand over a design to build by hand.** Two or three sentences that do not say where the data comes from, what the output should contain, who approves it or when it runs are not enough for a workflow; a workflow built on guesses is worse than a question. Say what you understood in one line, then ask the smallest number of questions that would let you build it, with `chief-options` when the answers are a short choice (which service the data comes from, who approves, how often, what the result is for). One round of questions, not an interrogation. Never answer a thin request with a workflow described in prose and an instruction to copy it.",
];

export const WORKFLOW_FORMAT = [
  "## The workflow format",
  "A workflow is: `name` (lower-case letters, digits and dashes), optional `description`, optional `budget` ({\"warn-usd\": number, \"max-usd\": number}), optional `inputs` (one JSON object with a section per step id: {\"collector\": {\"team\": \"…\"}}), `nodes` (the steps) and `edges` (the arrows: [{\"from\": \"a\", \"to\": \"b\"}], b runs after a; no cycles). Steps nothing points to run first; steps without a path between them may run side by side.",
  "Every step has an `id` (lower-case letters, digits and dashes, unique) and a `type`:",
  "- `agent`: runs an agent CLI once with `prompt`. Optional: `mcp` (the MCP servers it may use: leave it out for all of them, [] for none, or a list of names from the list below), `context` (\"previous\" by default: it is given the results of the steps whose arrows point to it; \"all\": of every earlier step; \"none\"), `output-schema` (the shape its result must have, as {\"summary\": \"string\", \"items\": [{\"title\": \"string\", \"score\": \"number\"}]}; types are string, number, boolean), `tools` (\"none\" by default, \"read-only\" or \"default\": the CLI's built-in file and shell tools), `irreversible` (true when it writes something that cannot be undone; chief then asks before running it), `timeout` (\"10m\").",
  "- `gate`: the run stops and asks the person. `kind` \"ask\" with `prompt` (what to ask, in plain words; an agent builds the form from it and the result of the step before) covers almost everything. The fixed forms: \"approve\" (`value`: what is approved, may be edited), \"select\" (`from`: a list to tick from), \"input\" (`summary`, optional `options`); these take `message` (text shown), not `prompt`.",
  "- `map`: repeats one inner step for every item of a list: `over` (\"{{nodes.<id>.output.<list field>}}\"), `mode` (\"sequential\" or \"parallel\"), `max-parallel`, `on-error` (\"fail\" or \"continue\"), and `node` (an agent or script step without arrows of its own; its prompt reads the item as {{item}} or {{item.<field>}}).",
  "- `script`: runs a local script in a sandbox: `run` (the file, in the workflow's folder), optional `interpreter`, `args`, `input`. Add one only for a file the person names; you cannot create it.",
  "Placeholders in prompts and other text fields, always with two braces: {{inputs.<step id>.<name>}} is a workflow input; {{nodes.<id>.output}} is everything an earlier step returned, {{nodes.<id>.output.<field>}} one field of it (give that step an `output-schema` naming the field), {{nodes.<id>.reply}} the text it wrote besides its result. A step can only refer to a step that runs before it (there must be a path of arrows). A step is given the results of the steps pointing to it anyway, so a placeholder is for putting a result at a particular place or reading a step further back.",
  "",
  "## The data format between steps",
  "A step's result is the only thing the steps after it get from it, so its format is a contract between the step that produces it and every step that reads it, and designing that contract is your job unless the person has done it by hand. For each agent step whose result later steps use: give it an `output-schema` that holds what ALL of its readers need, no more. Name fields plainly; use a list of objects when the readers go through items (and a map's `over` reads that list); keep the same field name for the same thing across the workflow. Then write each reader against it: {{nodes.<id>.output.<field>}} for a named field. One schema per producing step serves all its readers; when you change a schema, change every reader in the same reply. chief checks this: a placeholder that reads a field the producer's schema does not name is refused.",
  "Asked to design or review the formats for the whole workflow, go through every connection: what does the reader need, does the producer's schema promise it, is anything promised that nobody reads. Leave a schema the person wrote as it is unless it cannot serve a reader; say so when you change one. A step whose result nobody reads by field needs no schema.",
  "What cannot have a schema: a gate's result is fixed by its kind (input: text, option; approve: approved, value, text; select: selected, unselected, mode; ask: one field per question, with selected / unselected for a list); a script returns whatever it prints; a map returns the list of its items' results.",
  "",
];

export const DESIGN_INSTRUCTIONS = [
  "You are chief bot, chief's assistant. chief is a local tool that runs automated workflows made of steps. The person is in chief's designer, with a workflow on a canvas, and talks to you while they build it. Your job is to build and change that workflow when they want it changed — and to answer whatever they ask, about the workflow, about chief, or about anything else.",
  "",
  "## What you answer",
  "- Answer the question that was asked, in the language it was asked in. A question about the canvas is about the canvas; a question about something else (a fact, some research, an explanation, an opinion) gets an ordinary answer from what you know. Do not refuse a question because it is not about this workflow, and do not turn every answer into a suggestion about the workflow.",
  "- Answering from what you know is allowed and expected. What you may not do is pretend to have looked something up, run something, or read a file: you have no tools (below). Say when the answer depends on something you cannot see.",
  "- Build or change the canvas only when the person asks for that, or clearly agrees to it. A question is a question: do not change the workflow to answer one, and do not attach a workflow block to an answer nobody asked to be a change. When they ask for a change, make it — that is the point of being here.",
  "- Reply in a few short sentences, in the language of the person. Say what you changed and why, or answer the question. Do not repeat the workflow in prose.",
  "- To change the canvas, end your reply with the COMPLETE workflow as one JSON object in a fenced block whose first line is ```chief-workflow. Complete means every step and every connection, including the ones you did not touch, copied exactly as they are: what you leave out is removed. Send no block when nothing should change (a question, an explanation, a clarification you are waiting for).",
  "- Change what was asked and nothing else. Do not reword prompts, rename steps or drop fields the person did not ask you to touch.",
  "- Prompts are yours to write and rewrite: a step's `prompt` is plain language for another agent, and writing a good one is most of the job. Make it specific: what to look at, what to produce, what not to do.",
  "- When the request leaves a real choice open (which of several designs, which data, where a person should be asked), or when you see an improvement worth making that was not asked for, do not guess: make the part that is clear, and offer the choice. End your reply with a block whose first line is ```chief-options holding {\"question\": \"…\", \"options\": [\"…\", \"…\"]}: two to four short options, each a complete instruction you can carry out as it is written. The person picks one or types something else, so do not add an \"other\" option yourself. Offer options only when they help; most replies need none.",
  "- You have no tools. You cannot run the workflow, read files or reach any service, and you must not pretend to. You cannot write script files either.",
  /**
   * The rule the report on 2026-11-23 was really about: a thin description is a question to ask, not a design to hand
   * over. The answer it complained about said *"chief hasn't given me a format … so below is a design you can build in
   * the designer"* — the person got homework instead of a workflow, and the useful reply was two questions.
   */
  "",
  ...SCHEDULE_INSTRUCTIONS,
  ...ASK_WHEN_THIN,
  ...WORKFLOW_FORMAT,
  "Each step is its own agent session: steps share stored results, not a conversation. chief adds the instructions about returning JSON and reporting changes made, so prompts need not ask for them.",
  "Leave these alone, exactly as they are and never on a new step: `model` and `agent` (the person picks them from the agent CLI's lists), and a script's `sandbox` (the person grants and approves it). When asked for one of them, say where it is set: the step's panel in the designer.",
].join("\n");

export const DESIGN_REMINDER = "Reply as before: a few sentences; when the canvas should change, the COMPLETE workflow in a ```chief-workflow block at the end; when a schedule should be added or changed, a ```chief-schedule block; options in a ```chief-options block only when a choice is really open.";

/** The canvas as the agent is shown it. */
export function describeCanvas(v: { definition: any; version: number | null; baseDir: string | null; servers: { name: string; status: string }[]; taken: string[]; schedules?: { id: number; cron: string; inputs: any; enabled: boolean }[] }): string {
  const def = withoutLayout(v.definition);
  const out: string[] = ["# The canvas right now", ""];
  const steps = Array.isArray(def.nodes) ? def.nodes.length : 0;
  if (!steps) out.push(`The canvas is empty${def.name ? `; the workflow is to be named "${def.name}"` : " and the workflow has no name yet: choose a short one that says what it does"}. The first step you send creates the workflow.`);
  else {
    out.push(`Workflow "${def.name || "(no name yet)"}"${v.version != null ? `, saved as version ${v.version}` : ", not saved yet"}${v.baseDir ? `. Its folder: ${v.baseDir}` : ""}.`);
    const check = validateWorkflow(clone(def));
    if (!check.ok) out.push("", "As it is, chief does not accept it as a workflow (the last valid version stays in use until this is fixed):", ...check.errors.map((e) => `- ${e}`));
    else if (check.warnings.length) out.push("", "chief's check has these remarks:", ...check.warnings.map((e) => `- ${e}`));
    out.push("", "```json", JSON.stringify(def, null, 2), "```");
  }
  out.push("", "## MCP servers the agent CLI reports for this workflow's folder", "");
  out.push(v.servers.length ? v.servers.map((s) => `- ${s.name} (${s.status})`).join("\n") : "None are known. Leave `mcp` out of new steps.");
  // A schedule is written by the page after the reply, so the agent is given what exists — with the ids it
  // needs to change or pause one — and its own cron expression in words, from the engine's only parser.
  out.push("", "## Schedules of this workflow", "");
  if (!v.schedules || !v.schedules.length) out.push("None. A schedule is how this workflow starts by itself.");
  else for (const s of v.schedules) out.push(`- #${s.id}: \`${s.cron}\` (${describeCron(s.cron)}), ${s.enabled ? "enabled" : "paused"}${s.inputs && Object.keys(s.inputs).length ? `, inputs ${JSON.stringify(s.inputs)}` : ""}`);
  const others = v.taken.filter((n) => n !== def.name);
  if (others.length) out.push("", `Workflow names already in use (a new or renamed workflow needs another): ${others.join(", ")}.`);
  return out.join("\n");
}

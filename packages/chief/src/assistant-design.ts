import { validateWorkflow } from "./workflow/load.ts";
import { nodeSchema } from "./workflow/schema.ts";

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

/** Take the `chief-workflow` and `chief-options` blocks out of a reply. The last one of each counts. */
export function readReply(text: string): { text: string; workflow?: unknown; workflowError?: string; options?: AssistantOptions } {
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
  out.text = text.replace(BLOCK("chief-workflow"), "").replace(BLOCK("chief-options"), "").replace(/\n{3,}/g, "\n\n").trim();
  return out;
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

export const DESIGN_INSTRUCTIONS = [
  "You are the assistant in chief, a local tool that runs automated workflows made of steps. The person is in chief's designer, looking at a workflow on a canvas, and talks to you to build or change it. You answer questions about it and, when a change is wanted, you make the change: chief puts the workflow you send on the canvas at once.",
  "",
  "## How to reply",
  "- Reply in a few short sentences, in the language of the person. Say what you changed and why, or answer the question. Do not repeat the workflow in prose.",
  "- To change the canvas, end your reply with the COMPLETE workflow as one JSON object in a fenced block whose first line is ```chief-workflow. Complete means every step and every connection, including the ones you did not touch, copied exactly as they are: what you leave out is removed. Send no block when nothing should change (a question, an explanation, a clarification you are waiting for).",
  "- Change what was asked and nothing else. Do not reword prompts, rename steps or drop fields the person did not ask you to touch.",
  "- Prompts are yours to write and rewrite: a step's `prompt` is plain language for another agent, and writing a good one is most of the job. Make it specific: what to look at, what to produce, what not to do.",
  "- When the request leaves a real choice open (which of several designs, which data, where a person should be asked), or when you see an improvement worth making that was not asked for, do not guess: make the part that is clear, and offer the choice. End your reply with a block whose first line is ```chief-options holding {\"question\": \"…\", \"options\": [\"…\", \"…\"]}: two to four short options, each a complete instruction you can carry out as it is written. The person picks one or types something else, so do not add an \"other\" option yourself. Offer options only when they help; most replies need none.",
  "- You have no tools. You cannot run the workflow, read files or reach any service, and you must not pretend to. You cannot write script files either.",
  "",
  "## The workflow format",
  "A workflow is: `name` (lower-case letters, digits and dashes), optional `description`, optional `budget` ({\"warn-usd\": number, \"max-usd\": number}), optional `inputs` (one JSON object with a section per step id: {\"collector\": {\"team\": \"…\"}}), `nodes` (the steps) and `edges` (the arrows: [{\"from\": \"a\", \"to\": \"b\"}], b runs after a; no cycles). Steps nothing points to run first; steps without a path between them may run side by side.",
  "Every step has an `id` (lower-case letters, digits and dashes, unique) and a `type`:",
  "- `agent`: runs an agent CLI once with `prompt`. Optional: `mcp` (the MCP servers it may use: leave it out for all of them, [] for none, or a list of names from the list below), `context` (\"previous\" by default: it is given the results of the steps whose arrows point to it; \"all\": of every earlier step; \"none\"), `output-schema` (the shape its result must have, as {\"summary\": \"string\", \"items\": [{\"title\": \"string\", \"score\": \"number\"}]}; types are string, number, boolean), `tools` (\"none\" by default, \"read-only\" or \"default\": the CLI's built-in file and shell tools), `irreversible` (true when it writes something that cannot be undone; chief then asks before running it), `compensate` ({\"prompt\": \"how to undo, using {{output.side_effects}}\"}), `timeout` (\"10m\").",
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
  "Each step is its own agent session: steps share stored results, not a conversation. chief adds the instructions about returning JSON and reporting changes made, so prompts need not ask for them.",
  "Leave these alone, exactly as they are and never on a new step: `model` and `agent` (the person picks them from the agent CLI's lists), and a script's `sandbox` (the person grants and approves it). When asked for one of them, say where it is set: the step's panel in the designer.",
].join("\n");

export const DESIGN_REMINDER = "Reply as before: a few sentences; when the canvas should change, the COMPLETE workflow in a ```chief-workflow block at the end; options in a ```chief-options block only when a choice is really open.";

/** The canvas as the agent is shown it. */
export function describeCanvas(v: { definition: any; version: number | null; baseDir: string | null; servers: { name: string; status: string }[]; taken: string[] }): string {
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
  const others = v.taken.filter((n) => n !== def.name);
  if (others.length) out.push("", `Workflow names already in use (a new or renamed workflow needs another): ${others.join(", ")}.`);
  return out.join("\n");
}

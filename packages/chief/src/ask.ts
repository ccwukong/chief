import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAdapter } from "./adapters/index.ts";
import { EngineError } from "./engine/engine.ts";
import { log } from "./log.ts";
import { defaultWorkspace } from "./paths.ts";
import type { Store } from "./store/store.ts";
import type { MessageRow, NodeRunRow, RunRow } from "./store/types.ts";
import { mergeInputs } from "./workflow/inputs.ts";
import { canonical, checkProposal, describeCanvas, DESIGN_INSTRUCTIONS, DESIGN_REMINDER, readReply, SCHEDULE_INSTRUCTIONS, summarizeChange, type AssistantOptions, type ScheduleProposal, type WorkflowChange } from "./assistant-design.ts";
import { addSchedule, checkSchedule, setSchedule } from "./ops.ts";
import { describeCron, minuteKey, nextRun } from "./util/cron.ts";

/**
 * Ask about a run (task 9.62): a person asks a question about one run and an agent answers it from
 * the run's own record. The agent is given no tools and no MCP servers, so it can only read what
 * chief hands it here, and it cannot run or change anything: it explains and suggests. Everything
 * is written to the run's record like any other exchange with a worker.
 *
 * Nothing in here knows what a workflow is for: the record is described the same way for every run.
 */

/** Kinds of the record rows that belong to the conversation about a run. They carry no step. */
export const ASK_KINDS = { question: "ask_question", prompt: "ask_prompt", answer: "ask_answer" } as const;
/** Record rows of these kinds are the conversation; everything else is the run's own record. */
const ASK_PREFIX = "ask_";

export interface AskTurn { id: number; ts: string; role: "user" | "assistant"; text: string; meta?: { adapter: string; model: string | null; cost_usd: number; resumed: boolean; error?: string | null } }

export interface AskResult {
  answer: string;
  adapter: string;
  model: string | null;
  session_id: string | null;
  cost_usd: number;
  /** The CLI session of the previous answer was continued (the run's record had not changed). */
  resumed: boolean;
  conversation: AskTurn[];
}

/** The agent CLI that answers: the workflow's, or the default from Settings. */
export function askAdapter(store: Store, run: RunRow): string {
  const own = run.definition?.agent;
  return typeof own === "string" && own && own !== "default" ? own : store.getSetting<string>("default-adapter", "claude-code");
}

/** The questions asked about a run and their answers, oldest first. */
export function askConversation(store: Store, runId: number): AskTurn[] {
  if (!store.getRun(runId)) throw new EngineError(`run ${runId} not found`);
  return store.messages(runId, { kinds: [ASK_KINDS.question, ASK_KINDS.answer] }).map((m) => m.kind === ASK_KINDS.question
    ? { id: m.id, ts: m.ts, role: "user" as const, text: m.content }
    : { id: m.id, ts: m.ts, role: "assistant" as const, text: m.content, meta: { adapter: m.meta?.adapter ?? "", model: m.meta?.model ?? null, cost_usd: m.meta?.cost_usd ?? 0, resumed: !!m.meta?.resumed, error: m.meta?.error ?? null } });
}

export async function askAboutRun(store: Store, runId: number, v: { question: string; model?: string }): Promise<AskResult> {
  const run = store.getRun(runId);
  if (!run) throw new EngineError(`run ${runId} not found`);
  const question = String(v.question ?? "").trim();
  if (!question) throw new EngineError("there is no question yet: type what you want to know about this run");
  const adapterName = askAdapter(store, run);
  const adapter = getAdapter(store, adapterName);
  const model = v.model || null;

  // A follow-up continues the previous answer's CLI session as long as the run's record has not
  // grown since (nothing ran, no gate was answered). Otherwise the agent gets the whole record
  // again, with the earlier questions and answers, in a fresh session.
  const recordSize = store.messageCount(runId, { excludeKindPrefix: ASK_PREFIX });
  const earlier = askConversation(store, runId);
  const last = store.messages(runId, { kinds: [ASK_KINDS.answer] }).at(-1);
  const canResume = !!last?.meta?.session_id && last.meta.adapter === adapterName && last.meta.record_messages === recordSize && !last.meta.error;

  store.addMessage(runId, { direction: "user", kind: ASK_KINDS.question, content: question, meta: { model } });

  const cwd = run.base_dir && existsSync(run.base_dir) ? run.base_dir : defaultWorkspace();
  mkdirSync(cwd, { recursive: true });
  const call = async (prompt: string, resume: string | null) => {
    let argv: string[] = [];
    const res = await adapter.run({
      prompt, resumeSessionId: resume, model: model ?? undefined, servers: [], allServers: store.mcpServers(adapterName, cwd), builtinTools: "none",
      cwd, timeoutMs: 5 * 60_000,
      onEvent: (e) => {
        if (e.type === "sent") { argv = e.argv; store.addMessage(runId, { direction: "in", kind: ASK_KINDS.prompt, content: e.prompt, meta: { argv: e.argv, command: e.argv.join(" "), adapter: adapterName, model, resume } }); }
      },
    });
    return { res, argv };
  };

  let resumed = canResume;
  let { res } = await call(resumed ? followUpPrompt(run, question) : fullPrompt(store, run, question, earlier), resumed ? last!.meta.session_id : null);
  if (res.error && resumed) {
    // The session is gone (the CLI forgot it, or it is another machine): start over with the whole record.
    resumed = false;
    ({ res } = await call(fullPrompt(store, run, question, earlier), null));
  }
  const text = res.text.trim();
  const error = res.error ?? (res.interrupted || res.cancelled ? "the agent was stopped" : !text ? "the agent returned nothing" : null);
  const cost = res.usage?.cost_usd ?? 0;
  store.addMessage(runId, {
    direction: "out", kind: ASK_KINDS.answer, content: text,
    meta: { adapter: adapterName, model, session_id: res.sessionId, usage: res.usage, cost_usd: cost, resumed, record_messages: recordSize, error },
  });
  if (error) throw new EngineError(`${adapterName} could not answer: ${error}`);
  log(`run ${runId}: question answered by ${adapterName}${model ? ` (${model})` : ""}${resumed ? ", session continued" : ""}, $${cost.toFixed(4)}`);
  return { answer: text, adapter: adapterName, model, session_id: res.sessionId, cost_usd: cost, resumed, conversation: askConversation(store, runId) };
}

// ── the prompts ────────────────────────────────────────────────────────────

const INSTRUCTIONS = [
  "You are the assistant in chief, a local tool that runs automated workflows made of steps: `agent` (an agent CLI given a prompt and MCP servers), `script` (a sandboxed local script), `gate` (the run stops and asks the person) and `map` (one inner step repeated over a list). Every step is its own agent session; steps share stored results, not a conversation.",
  "A person using chief asks you a question. Answer it from the record below and nothing else.",
  "",
  "How to answer:",
  "- Start with the answer in one or two sentences, then the evidence: name the step, quote the error text or the tool call that shows it. Keep the whole reply short: a few short paragraphs or a short list. Write in the language of the question.",
  "- Say only what the record shows. When it does not tell, say so plainly instead of guessing.",
  "- When something failed or stopped, explain what failed, the likely cause as far as the record shows it, and the next move in terms of what chief offers: change the failed step's model or prompt for this run (on the run page, or `chief runs set-model` / `chief runs set-prompt`) and press Resume, so that only that step and the ones after it run again; answer the waiting gate; fix the MCP server's connection in the agent CLI and Resume; fix the step in the designer, then Resume uses the new version; Run again (a new run with the same inputs); Revert (runs the steps' compensations); Cancel.",
  "- You have no tools and no access to anything but this text. Do not try to carry anything out, do not pretend to have looked anything up, and do not reply with a JSON block — with one exception, a schedule, below.",
  "",
  ...SCHEDULE_INSTRUCTIONS,
].join("\n");

function followUpPrompt(run: RunRow, question: string): string {
  return [`Follow-up question about run #${run.id} (the same run; its record has not changed since your last answer). Answer it the same way, from the record you were given.`, "", question].join("\n");
}

function fullPrompt(store: Store, run: RunRow, question: string, earlier: AskTurn[]): string {
  const parts = [INSTRUCTIONS, "", "## The question", "", question, "", describeRun(store, run)];
  if (earlier.length) {
    parts.push("", "## Earlier questions and answers in this conversation", "");
    for (const t of earlier) parts.push(t.role === "user" ? `Person: ${t.text}` : `You: ${clip(t.text, LIMIT.answer)}`, "");
  }
  return parts.join("\n");
}

// ── the run's record, described for the agent ──────────────────────────────

/** Characters kept per piece. The rest is cut with a marker, so the agent knows it is not seeing all of it. */
const LIMIT = { prompt: 3000, result: 3000, reply: 1500, trail: 800, trailRows: 24, answer: 1500, inputs: 2000, total: 160_000 };

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…[cut: ${s.length - n} more characters not shown]` : s;
}
const j = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2));

function describeRun(store: Store, run: RunRow): string {
  const wf = store.getWorkflow(run.workflow_id);
  const out: string[] = ["## Run", "", `Run #${run.id} of workflow "${wf?.name ?? run.workflow_id}" (version ${run.workflow_version}). Status: ${run.status}.`];
  if (run.error) out.push(`Run error: ${run.error}`);
  out.push(`Created ${run.created_at}${run.started_at ? `, started ${run.started_at}` : ""}${run.finished_at ? `, finished ${run.finished_at}` : ""}. Cost so far $${(run.cost_usd ?? 0).toFixed(4)} (${run.tokens_in} tokens in, ${run.tokens_out} out).`);
  const def = run.definition ?? {};
  // The inputs the run ran with: its own values over the workflow's defaults.
  const inputs = mergeInputs(def.inputs, run.inputs);
  if (inputs && Object.keys(inputs).length) out.push("Inputs the run ran with:", "```json", clip(j(inputs), LIMIT.inputs), "```");
  out.push("", "## The workflow's steps, as drawn", "");
  for (const n of def.nodes ?? []) {
    const inner = n.type === "map" ? n.node : n;
    const bits = [n.type === "map" ? `map over ${j(n.over)} (${n.mode ?? "sequential"}), inner step: ${inner?.type ?? "?"}` : n.type];
    if (n.type === "gate") bits.push(`kind ${n.kind}`);
    if (inner?.model) bits.push(`model ${inner.model}`);
    if (inner?.agent) bits.push(`agent CLI ${inner.agent}`);
    if (Array.isArray(inner?.mcp)) bits.push(`MCP servers: ${inner.mcp.length ? inner.mcp.join(", ") : "none"}`);
    if (inner?.tools) bits.push(`built-in tools: ${j(inner.tools)}`);
    if (inner?.context) bits.push(`context: ${inner.context}`);
    if (n.irreversible || inner?.irreversible) bits.push("marked irreversible (asks before running)");
    out.push(`- ${n.id}: ${bits.join("; ")}`);
  }
  const edges = (def.edges ?? []).map((e: any) => (typeof e === "string" ? e : `${e.from} -> ${e.to}`));
  if (edges.length) out.push(`Connections: ${edges.join(", ")}`);

  // The record, grouped by step attempt.
  const byNodeRun = new Map<number, MessageRow[]>();
  for (const m of store.messages(run.id)) if (m.node_run_id != null) (byNodeRun.get(m.node_run_id) ?? byNodeRun.set(m.node_run_id, []).get(m.node_run_id)!).push(m);
  const gates = store.gates({ runId: run.id });
  const nodeRuns = store.nodeRuns(run.id);
  out.push("", "## What ran, in order", "");
  if (!nodeRuns.length) out.push("Nothing has run yet.");
  for (const n of nodeRuns) out.push(...describeStep(n, byNodeRun.get(n.id) ?? [], gates.filter((g) => g.node_run_id === n.id)), "");
  const started = new Set(nodeRuns.map((n) => n.node_id));
  const notStarted = (def.nodes ?? []).filter((n: any) => !started.has(n.id)).map((n: any) => n.id);
  if (notStarted.length) out.push(`Steps that have not started: ${notStarted.join(", ")}.`);

  const loose = gates.filter((g) => g.node_run_id == null || !nodeRuns.some((n) => n.id === g.node_run_id));
  if (loose.length) {
    out.push("", "## Gates that belong to no step (a budget stop, for example)", "");
    for (const g of loose) out.push(`- gate ${g.id} (${g.kind}, ${g.reason}): ${g.status}. Asked: ${clip(j(g.payload), LIMIT.reply)}${g.answer != null ? `\n  Answered: ${clip(j(g.answer), LIMIT.reply)}` : ""}`);
  }

  const effects = store.sideEffects({ runId: run.id });
  if (effects.length) {
    out.push("", "## Side effects the steps reported (writes to other systems)", "");
    for (const e of effects) out.push(`- ${e.kind} ${e.ref ?? ""} ${e.url ?? ""}${e.irreversible ? " [irreversible]" : ""}${e.reverted_at ? " [reverted]" : ""}${e.how_to_undo ? ` (how to undo: ${e.how_to_undo})` : ""}`.replace(/\s+/g, " "));
  }

  const NOTE = /repair|truncat|budget|engine_error|step_changed|denied|interrupt|cancel|pause|resume|revert|rerun|mcp/;
  const events = store.events(run.id, 0, 5000).filter((e) => NOTE.test(e.type)).slice(-40);
  if (events.length) {
    out.push("", "## Events of note", "");
    for (const e of events) out.push(`- ${e.ts} ${e.type}${e.node_run_id != null ? ` (step attempt ${e.node_run_id})` : ""}: ${clip(j(e.payload), 400).replace(/\n/g, " ")}`);
  }

  let text = out.join("\n");
  if (text.length > LIMIT.total) text = `${text.slice(0, LIMIT.total)}\n…[the record is longer than can be shown here: ${text.length - LIMIT.total} more characters were left out]`;
  return text;
}

function describeStep(n: NodeRunRow, msgs: MessageRow[], gates: ReturnType<Store["gates"]>): string[] {
  const label = `${n.node_id}${n.item_index != null ? `[item ${n.item_index}]` : ""}`;
  const u = n.usage;
  const head = [`### Step ${label} (${n.node_type}${n.phase === "compensate" ? ", compensation" : ""}, attempt ${n.attempt}): ${n.status}`];
  const facts: string[] = [];
  if (n.started_at) facts.push(`started ${n.started_at}`);
  if (n.finished_at) facts.push(`finished ${n.finished_at}`);
  if (u?.model) facts.push(`model ${u.model}`);
  if (u) facts.push(`cost $${(u.cost_usd ?? 0).toFixed(4)}`);
  if (facts.length) head.push(facts.join(", ") + ".");
  if (n.error) head.push(`Error: ${n.error}`);

  const sent = msgs.find((m) => ["prompt", "stdin", "gate_question"].includes(m.kind));
  if (sent) head.push("", sent.kind === "prompt" ? "Prompt sent to the agent (cut to its start):" : sent.kind === "stdin" ? "What the script was given on stdin:" : "What the person was asked:", clip(sent.content, LIMIT.prompt));
  for (const g of gates) if (g.status !== "waiting") head.push(`The person answered the gate (${g.kind}): ${clip(j(g.answer), LIMIT.reply)}`); else head.push(`This gate is still waiting for the person (${g.kind}, ${g.reason}).`);

  // Tool use, in short: how many calls, which tools.
  const tools = msgs.filter((m) => m.kind === "tool_use");
  if (tools.length) {
    const counts = new Map<string, number>();
    for (const t of tools) counts.set(t.meta?.name ?? "?", (counts.get(t.meta?.name ?? "?") ?? 0) + 1);
    const failed = msgs.filter((m) => m.kind === "tool_result" && m.meta?.is_error).length;
    head.push("", `Tool calls: ${tools.length} (${[...counts].map(([k, v]) => `${k} ×${v}`).join(", ")})${failed ? `, ${failed} returned an error` : ""}.`);
  }
  const denied = msgs.filter((m) => /denied|permission/.test(m.kind));
  for (const d of denied) head.push(`Permission denied: ${clip(d.content, 300)}`);

  if (n.output != null) head.push("", "Result (what is passed on to the next steps):", clip(j(n.output), LIMIT.result));
  const reply = typeof n.state?.reply === "string" ? n.state.reply : "";
  if (reply.trim()) head.push("", "Text the step wrote besides its result:", clip(reply, LIMIT.reply));
  const stderr = msgs.filter((m) => m.kind === "stderr").at(-1);
  if (stderr?.content.trim()) head.push("", "stderr:", clip(stderr.content, LIMIT.trail));

  // A step that did not complete: its last recorded activity, so that the cause can be seen.
  if (n.status !== "completed") {
    const trail = msgs.filter((m) => ["tool_use", "tool_result", "agent_text", "result", "stdout"].includes(m.kind)).slice(-LIMIT.trailRows);
    if (trail.length) {
      head.push("", `Last recorded activity (${trail.length} of ${msgs.length} entries):`);
      for (const m of trail) {
        const what = m.kind === "tool_use" ? `tool call ${m.meta?.name ?? ""}` : m.kind === "tool_result" ? `tool result${m.meta?.is_error ? " (error)" : ""}` : m.kind;
        head.push(`- [${m.ts.slice(11, 19)}] ${what}: ${clip(m.content, LIMIT.trail).replace(/\n/g, "\n  ")}`);
      }
    }
  }
  return head;
}

// ── the assistant (task 9.64): the chat panel's one conversation, about chief as a whole ──────

export interface AssistantTurn {
  id: number; ts: string; role: "user" | "assistant"; text: string;
  meta?: {
    adapter: string; model: string | null; cost_usd: number; resumed: boolean; run_id: number | null; error?: string | null;
    /** The workflow that was on the designer's canvas when this was asked (task 9.65). */
    workflow?: string | null;
    /** The change the assistant made to that workflow, if any. */
    change?: WorkflowChange | null;
    /** Why a change the assistant tried to make was not accepted. */
    change_error?: string | null;
    /** The schedule it asked chief to write, if any: the page sends it to `/api/schedules`. */
    schedule?: ScheduleChange | null;
    /** Why a schedule it asked for was not accepted. */
    schedule_error?: string | null;
    /** Choices the assistant offers for the next message. */
    options?: AssistantOptions | null;
  };
}

/** A schedule the assistant asked for, checked against the store: what the page should write, and what it is in words. */
export interface ScheduleChange {
  action: "create" | "update";
  workflow: string;
  /** The schedule to change, for an update; null for a new one (the page learns the id when it is written). */
  id: number | null;
  cron?: string;
  inputs?: Record<string, unknown>;
  enabled?: boolean;
  /** What it will do, in words, so the panel and the log say the same thing. */
  description: string;
}

export interface AssistantResult { answer: string; adapter: string; model: string | null; session_id: string | null; cost_usd: number; resumed: boolean; run_id: number | null; workflow: string | null; change: WorkflowChange | null; change_error: string | null; schedule: ScheduleChange | null; schedule_error: string | null; options: AssistantOptions | null; conversation: AssistantTurn[] }

/** The conversation held in the chat panel, oldest first (the prompts sent are kept but not shown). */
export function assistantConversation(store: Store): AssistantTurn[] {
  return store.assistantMessages({ roles: ["user", "assistant"] }).map((m) => m.role === "user"
    ? { id: m.id, ts: m.ts, role: "user" as const, text: m.content, meta: { adapter: "", model: null, cost_usd: 0, resumed: false, run_id: m.meta?.run_id ?? null, workflow: m.meta?.workflow ?? null } }
    : { id: m.id, ts: m.ts, role: "assistant" as const, text: m.content, meta: { adapter: m.meta?.adapter ?? "", model: m.meta?.model ?? null, cost_usd: m.meta?.cost_usd ?? 0, resumed: !!m.meta?.resumed, run_id: m.meta?.run_id ?? null, error: m.meta?.error ?? null, workflow: m.meta?.workflow ?? null, change: m.meta?.change ?? null, change_error: m.meta?.change_error ?? null, schedule: m.meta?.schedule ?? null, schedule_error: m.meta?.schedule_error ?? null, options: m.meta?.options ?? null } });
}

/** How many of the latest exchanges a fresh session is reminded of. */
const HISTORY = 10;

/** The designer's canvas, sent along with a question asked there: the working copy, valid or not. */
export interface CanvasInput { definition: unknown; base_dir?: string | null }

/**
 * Answer a question asked in the chat panel. The agent is given an overview of chief (workflows,
 * recent runs, waiting gates) and, when the page shows a run, that run's full record. A follow-up
 * continues the previous CLI session as long as nothing has happened since (same page, no new
 * event, the run's record unchanged); otherwise a fresh session is given everything again, with
 * the latest exchanges of the conversation. The agent has no tools.
 *
 * Asked in the designer (`workflow`, task 9.65), the agent is given the canvas instead and may
 * answer with a changed workflow, which is checked here and returned as `change` for the page to
 * put on the canvas. Nothing is written to the workflow here: the designer's autosave does that.
 * It may also ask for a schedule (`chief-schedule`), which is written here through the same
 * operations the Schedules page uses: a schedule is not a draft, and the answer records what was
 * written (task 15.33).
 */
export async function assistantAnswer(store: Store, v: { question: string; model?: string; runId?: number | null; workflow?: CanvasInput | null }): Promise<AssistantResult> {
  const question = String(v.question ?? "").trim();
  if (!question) throw new EngineError("there is no question yet: type what you want to know");
  const canvas = v.workflow ? canvasOf(v.workflow) : null;
  const run = !canvas && v.runId != null ? store.getRun(v.runId) : null;
  if (!canvas && v.runId != null && !run) throw new EngineError(`run ${v.runId} not found`);
  const runId = run?.id ?? null;
  const own = canvas?.definition.agent;
  const adapterName = run ? askAdapter(store, run) : typeof own === "string" && own && own !== "default" ? own : store.getSetting<string>("default-adapter", "claude-code");
  const adapter = getAdapter(store, adapterName);
  const model = v.model || null;
  const workflowName = canvas ? String(canvas.definition.name ?? "") : null;

  const fingerprint = canvas
    ? JSON.stringify({ design: canonical(canvas.definition) })
    : JSON.stringify({ run: runId, record: run ? store.messageCount(run.id, { excludeKindPrefix: ASK_PREFIX }) : null, event: store.lastEventId(), runs: store.countRuns() });
  const last = store.assistantMessages({ roles: ["assistant"], limit: 1 })[0];
  // A schedule it just wrote is why a session is not continued: the new schedule's id is one the
  // conversation has never seen, so the next question starts from a prompt that lists it.
  const canResume = !!last?.meta?.session_id && last.meta.adapter === adapterName && last.meta.fingerprint === fingerprint && !last.meta.error && !last.meta.schedule;
  const history = assistantConversation(store).slice(-HISTORY * 2);

  store.addAssistantMessage({ role: "user", content: question, meta: { run_id: runId, model, workflow: workflowName } });

  const folder = canvas?.baseDir ?? run?.base_dir ?? null;
  const cwd = folder && existsSync(folder) ? folder : defaultWorkspace();
  mkdirSync(cwd, { recursive: true });
  const call = (prompt: string, resume: string | null) => adapter.run({
    prompt, resumeSessionId: resume, model: model ?? undefined, servers: [], allServers: store.mcpServers(adapterName, cwd), builtinTools: "none",
    cwd, timeoutMs: 5 * 60_000,
    onEvent: (e) => { if (e.type === "sent") store.addAssistantMessage({ role: "prompt", content: e.prompt, meta: { argv: e.argv, command: e.argv.join(" "), adapter: adapterName, model, resume, run_id: runId, workflow: workflowName } }); },
  });
  const full = () => canvas ? designPrompt(store, canvas, adapterName, question, history) : assistantPrompt(store, run, question, history);

  let resumed = canResume;
  let res = await call(resumed ? (canvas ? designFollowUp(question) : assistantFollowUp(run, question)) : full(), resumed ? last!.meta.session_id : null);
  if (res.error && resumed) { resumed = false; res = await call(full(), null); }
  let cost = res.usage?.cost_usd ?? 0;
  const replies = [res.text];

  // A schedule it asked for is checked and written in either mode — the designer's canvas, or the panel
  // opened on a run or on chief as a whole (task 15.32): scheduling is authoring, and a person who asks
  // "can you schedule this?" from the run list should not be told no. The workflow it belongs to is the
  // canvas in the designer, and must be named anywhere else.
  const canvasName = canvas ? workflowName : null;
  // In the designer the agent may also send a whole workflow. One correction is asked for when either the
  // workflow or the schedule is not acceptable.
  let text = res.text.trim();
  let change: WorkflowChange | null = null;
  let changeError: string | null = null;
  let schedule: ScheduleChange | null = null;
  let scheduleError: string | null = null;
  let options: AssistantOptions | null = null;
  if (!res.error) {
    let reply = readReply(text);
    let checked = canvas && reply.workflow ? checkProposal(canvas.definition, reply.workflow) : null;
    let problems = canvas ? (reply.workflowError ? [reply.workflowError] : checked && !checked.ok ? checked.errors : []) : [];
    let sched = checkScheduleReply(store, canvasName, reply, !!canvas);
    let schedProblems = reply.scheduleError ? [reply.scheduleError] : sched.error ? [sched.error] : [];
    if ((problems.length || schedProblems.length) && res.sessionId) {
      // Kept, because if the correction does not come the reason it was refused is what the person needs
      // to see — "no corrected schedule was sent" on its own says nothing about what was wrong.
      const workflowReasons = problems;
      const scheduleReasons = schedProblems;
      const want = [workflowReasons.length ? "the complete corrected workflow in a ```chief-workflow block" : null, scheduleReasons.length ? "the corrected schedule in a ```chief-schedule block" : null].filter(Boolean).join(" and ");
      const again = await call(["chief did not accept that, so nothing was changed:", ...[...workflowReasons, ...scheduleReasons].map((p) => `- ${p}`), "", `Send your reply again with ${want}.`].join("\n"), res.sessionId);
      cost += again.usage?.cost_usd ?? 0;
      replies.push(again.text);
      if (!again.error && again.text.trim()) {
        res = again;
        reply = readReply(again.text.trim());
        checked = canvas && reply.workflow ? checkProposal(canvas.definition, reply.workflow) : null;
        // A problem it was asked to fix and did not send again is still that problem.
        problems = canvas ? (reply.workflowError ? [reply.workflowError] : checked && !checked.ok ? checked.errors : workflowReasons.length && !reply.workflow ? workflowReasons : []) : [];
        sched = checkScheduleReply(store, canvasName, reply, !!canvas);
        schedProblems = reply.scheduleError ? [reply.scheduleError] : sched.error ? [sched.error] : scheduleReasons.length && !reply.schedule ? scheduleReasons : [];
      }
    }
    text = reply.text;
    options = reply.options ?? null;
    if (problems.length) changeError = problems.join("\n");
    else if (canvas && checked?.ok && canonical(checked.workflow) !== canonical(canvas.definition)) {
      change = { workflow: checked.workflow.name, before: canvas.definition, after: checked.workflow, summary: summarizeChange(canvas.definition, checked.workflow) };
      if (!text) text = "Done.";
    }
    if (schedProblems.length) scheduleError = schedProblems.join("\n");
    else if (sched.change) {
      // Written here, through the same operation the Schedules page calls: a schedule the person asked for
      // in the chat is not a draft on a canvas, and the answer then records what was really written.
      try {
        schedule = writeSchedule(store, sched.change);
        if (!text) text = schedule.action === "create" ? "Scheduled." : "Changed the schedule.";
      } catch (e: any) { scheduleError = e.message; }
    }
  }

  const error = res.error ?? (res.interrupted || res.cancelled ? "the agent was stopped" : !text && !changeError && !scheduleError ? "the agent returned nothing" : null);
  store.addAssistantMessage({
    role: "assistant", content: text,
    meta: {
      adapter: adapterName, model, session_id: res.sessionId, usage: res.usage, cost_usd: cost, resumed, run_id: runId, error,
      // What the canvas is expected to be after this answer: the next question continues the session while it still is.
      fingerprint: canvas ? JSON.stringify({ design: canonical(change ? change.after : canvas.definition) }) : fingerprint,
      ...(canvas ? { workflow: change?.workflow ?? workflowName, change, change_error: changeError, schedule, schedule_error: scheduleError, options, replies } : { schedule, schedule_error: scheduleError, replies }),
    },
  });
  if (error) throw new EngineError(`${adapterName} could not answer: ${error}`);
  log(`assistant: question answered by ${adapterName}${model ? ` (${model})` : ""}${runId != null ? ` about run ${runId}` : ""}${canvas ? ` in the designer (${workflowName || "new workflow"})${change ? `, canvas changed: ${change.summary.join("; ")}` : changeError ? ", a change was not accepted" : ""}` : ""}${schedule ? `, schedule ${schedule.action === "create" ? "created" : "changed"}: ${schedule.description}` : scheduleError ? ", a schedule was not accepted" : ""}${resumed ? ", session continued" : ""}, $${cost.toFixed(4)}`);
  return { answer: text, adapter: adapterName, model, session_id: res.sessionId, cost_usd: cost, resumed, run_id: runId, workflow: canvas ? change?.workflow ?? workflowName : null, change, change_error: changeError, schedule, schedule_error: scheduleError, options, conversation: assistantConversation(store) };
}

function canvasOf(w: CanvasInput): { definition: any; baseDir: string | null } {
  const d = w.definition;
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new EngineError("`workflow.definition` must be the workflow on the canvas, as a JSON object");
  return { definition: d, baseDir: typeof w.base_dir === "string" && w.base_dir.trim() ? resolve(w.base_dir.trim()) : null };
}

function designFollowUp(question: string): string {
  return ["Follow-up (the canvas is as you last saw or left it).", "", question, "", DESIGN_REMINDER].join("\n");
}

/**
 * Check a schedule the assistant asked for: the workflow exists, the expression parses and the inputs are
 * enough — the same check the Schedules form gets — and, for a change, that the id belongs to this workflow.
 * Returns what the page should write, or why it cannot.
 */
function checkScheduleReply(store: Store, canvasName: string | null, reply: { schedule?: ScheduleProposal }, inDesigner = true): { change: ScheduleChange | null; error: string | null } {
  const p = reply.schedule;
  if (!p) return { change: null, error: null };
  try {
    if (p.action === "create") {
      // The canvas's workflow unless another is named. Outside the designer nothing is implied, so the
      // block has to say which workflow — the panel is not looking at one.
      const name = p.workflow ?? canvasName;
      if (!name) throw new EngineError(inDesigner ? "this workflow has no name yet: name it before scheduling it" : "say which workflow to schedule, by its name");
      if (!p.workflow && !inDesigner) throw new EngineError("say which workflow to schedule, by its name");
      const wf = store.getWorkflow(name);
      if (!wf) throw new EngineError(`workflow "${name}" not found`);
      const checked = checkSchedule(store, name, p.cron!, p.inputs ?? {});
      return { change: { action: "create", workflow: wf.name, id: null, cron: checked.cron, inputs: p.inputs ?? {}, description: cronPhrase(checked.cron) }, error: null };
    }
    const row = store.schedule(p.id!);
    if (!row) throw new EngineError(`schedule ${p.id} not found`);
    // Which workflow this is about: the one named, or the one on the canvas. Changing a schedule of
    // another workflow is only done when that workflow is named, so a conversation about this canvas
    // cannot quietly reach into a different one.
    const target = p.workflow ?? canvasName;
    if (target && target !== row.workflow_name) throw new EngineError(`schedule ${p.id} belongs to "${row.workflow_name}", not "${target}"`);
    // The pair it will become is what is checked, not just the field that changed: a new expression with
    // the old inputs may need an input the old one did not.
    const checked = checkSchedule(store, row.workflow_name, p.cron ?? row.cron, p.inputs ?? row.inputs ?? {});
    const enabled = p.enabled ?? !!row.enabled;
    return {
      change: { action: "update", workflow: row.workflow_name, id: row.id, cron: p.cron !== undefined ? checked.cron : undefined, inputs: p.inputs, enabled: p.enabled, description: `${cronPhrase(checked.cron)}, ${enabled ? "enabled" : "paused"}` },
      error: null,
    };
  } catch (e: any) {
    return { change: null, error: e.message };
  }
}

/** An expression in words and when it next fires, so a reply can be checked at a glance. */
function cronPhrase(cron: string): string {
  const next = nextRun(cron);
  return `${describeCron(cron)}${next ? ` (next ${minuteKey(next)})` : ""}`;
}

/** Write a schedule the assistant asked for, through the same operations the Schedules page uses, and return it with its id. */
function writeSchedule(store: Store, c: ScheduleChange): ScheduleChange {
  const row = c.action === "create"
    ? addSchedule(store, c.workflow, c.cron!, c.inputs ?? {})
    : setSchedule(store, c.id!, {
      ...(c.cron !== undefined ? { cron: c.cron } : {}),
      ...(c.inputs !== undefined ? { inputs: c.inputs } : {}),
      ...(c.enabled !== undefined ? { enabled: c.enabled } : {}),
    });
  return { ...c, id: row.id };
}

function designPrompt(store: Store, canvas: { definition: any; baseDir: string | null }, adapterName: string, question: string, history: AssistantTurn[]): string {
  const name = typeof canvas.definition.name === "string" ? canvas.definition.name : "";
  const stored = name ? store.getWorkflow(name) : null;
  // The folder its steps run in: the one typed, the stored one, or the default one for its name (as the designer's server list does).
  const set = store.getSetting<string | null>("workspace-dir", null);
  const workspace = resolve(set ? set.replace(/^~(?=$|\/)/, homedir()) : defaultWorkspace());
  const folder = canvas.baseDir ?? stored?.base_dir ?? (name ? join(workspace, name) : workspace);
  // What the CLI reported there; chief keeps no server list of its own.
  const rows = store.mcpServers(adapterName, resolve(folder));
  const servers = (rows.length ? rows : store.mcpServers(adapterName, workspace)).map((s) => ({ name: s.name, status: String(s.config?.status ?? "unknown") }));
  const parts = [DESIGN_INSTRUCTIONS, "", "## What the person says", "", question, "", describeCanvas({ definition: canvas.definition, version: stored?.version ?? null, baseDir: folder, servers, taken: store.listWorkflows().map((w) => w.name), schedules: name ? store.schedules().filter((s) => s.workflow_name === name).map((s) => ({ id: s.id, cron: s.cron, inputs: s.inputs, enabled: !!s.enabled })) : [] })];
  if (history.length) {
    parts.push("", "## Earlier in this conversation", "");
    for (const t of history) parts.push(t.role === "user" ? `Person: ${t.text}` : `You: ${clip(t.text, LIMIT.answer)}${t.meta?.change ? `\n(You changed the canvas: ${t.meta.change.summary.join("; ")})` : ""}${t.meta?.schedule ? `\n(You scheduled: ${t.meta.schedule.description})` : ""}${t.meta?.options ? `\n(You offered: ${t.meta.options.options.join(" | ")})` : ""}`, "");
  }
  return parts.join("\n");
}

function assistantFollowUp(run: RunRow | null, question: string): string {
  return [`Follow-up question (nothing has changed in chief since your last answer${run ? `; the person is still looking at run #${run.id}` : ""}). Answer it the same way, from what you were given.`, "", question].join("\n");
}

function assistantPrompt(store: Store, run: RunRow | null, question: string, history: AssistantTurn[]): string {
  const parts = [INSTRUCTIONS, "", "## The question", "", run ? `(The person is looking at the page of run #${run.id}.)` : "(The person is not looking at a particular run.)", "", question, "", describeOverview(store, run?.id ?? null)];
  if (run) parts.push("", "# The run the person is looking at", "", describeRun(store, run));
  if (history.length) {
    parts.push("", "## Earlier questions and answers in this conversation", "");
    for (const t of history) parts.push(t.role === "user" ? `Person${t.meta?.run_id != null ? ` (on run #${t.meta.run_id})` : ""}: ${t.text}` : `You: ${clip(t.text, LIMIT.answer)}`, "");
  }
  return parts.join("\n");
}

/** Chief as a whole, in short: the workflows, the recent runs and the gates waiting for the person. */
function describeOverview(store: Store, openRunId: number | null): string {
  const out: string[] = ["# Chief right now", "", "## Workflows", ""];
  const workflows = store.listWorkflows();
  if (!workflows.length) out.push("No workflows yet.");
  for (const w of workflows) {
    const steps = (w.definition?.nodes ?? []).map((n: any) => `${n.id} (${n.type})`);
    out.push(`- ${w.name} (version ${w.version}): ${steps.length ? steps.join(", ") : "no steps"}`);
  }
  // Each workflow's schedules, with the ids the schedule block needs: without them "pause the daily one"
  // cannot be carried out from this panel, which is where people ask (task 15.32).
  const all = store.schedules();
  out.push("", "## Schedules", "");
  if (!all.length) out.push("None yet. A schedule is how a workflow starts by itself.");
  for (const w of workflows) {
    const mine = all.filter((s) => s.workflow_name === w.name);
    if (!mine.length) continue;
    out.push(`- ${w.name}:`, ...mine.map((s) => `  - #${s.id}: \`${s.cron}\` (${describeCron(s.cron)}), ${s.enabled ? "enabled" : "paused"}${s.inputs && Object.keys(s.inputs).length ? `, inputs ${JSON.stringify(s.inputs)}` : ""}`));
  }
  const total = store.countRuns();
  const runs = store.listRuns(20);
  out.push("", `## Runs (the newest ${runs.length} of ${total})`, "");
  if (!runs.length) out.push("No runs yet.");
  for (const r of runs) out.push(`- run #${r.id}${r.id === openRunId ? " (the one on show)" : ""}: ${r.workflow_name} v${r.workflow_version}, ${r.status}, created ${r.created_at}, $${(r.cost_usd ?? 0).toFixed(4)}${r.error ? `, error: ${clip(r.error, 300).replace(/\n/g, " ")}` : ""}`);
  const waiting = store.gates({ status: "waiting" });
  out.push("", "## Gates waiting for the person", "");
  if (!waiting.length) out.push("None.");
  for (const g of waiting) out.push(`- gate ${g.id} in run #${g.run_id}${g.node_id ? ` at step ${g.node_id}` : ""} (${g.kind}, ${g.reason}): ${clip(j(g.payload?.message ?? g.payload?.title ?? g.payload), 300).replace(/\n/g, " ")}`);
  return out.join("\n");
}

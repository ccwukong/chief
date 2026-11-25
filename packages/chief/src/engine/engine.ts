import { availableAdapters, resolveServers } from "../adapters/index.ts";
import { providerChosenOff } from "../providers.ts";
import { agentFolder } from "../paths.ts";
import { resolveSandbox, sandboxStatus } from "../sandbox/sandbox.ts";
import type { Store } from "../store/store.ts";
import type { GateRow, RunRow } from "../store/types.ts";
import { TERMINAL_NODE, TERMINAL_RUN } from "../store/types.ts";
import { isAlive, killOrphan } from "../util/proc.ts";
import { executableNodes, predecessors, topoOrder } from "../workflow/load.ts";
import type { Workflow } from "../workflow/schema.ts";
import { buildScope, event, getRun, now, type Ctx } from "./context.ts";
import { defaultAdapter, execNode, widenedScripts } from "./runners.ts";
import { mkdirSync } from "node:fs";
import { mergeInputs, missingInputs, missingInputsMessage, missingRequired, requiredFieldsMessage } from "../workflow/inputs.ts";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export class EngineError extends Error {}

const makeCtx = (store: Store, run: RunRow): Ctx => ({
  store, runId: run.id, def: run.definition as Workflow, baseDir: run.base_dir ?? process.cwd(), changes: 0, retryFailed: false,
});

/**
 * Checks that depend on this machine rather than on the definition alone:
 * MCP servers known, sandbox backend present, sandbox paths legal, widened scripts approved.
 */
export function preflight(store: Store, wf: Workflow, baseDir: string, workflowId: number | null): { errors: string[]; warnings: string[] } {
  const errors: string[] = [], warnings: string[] = [];
  const ctxLike = { def: wf, store } as Ctx;
  const sb = sandboxStatus();
  for (const { top, node } of executableNodes(wf)) {
    const specs: any[] = [node, ...(node.compensate ? [{ ...node.compensate, type: node.compensate.run ? "script" : "agent", mcp: node.compensate.mcp ?? node.mcp, sandbox: node.compensate.sandbox ?? node.sandbox, cwd: node.cwd, agent: node.agent }] : [])];
    const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : resolve(baseDir, p));
    for (const spec of specs) {
      if (spec.type === "agent") {
        const adapter = defaultAdapter(ctxLike, spec);
        if (!availableAdapters().includes(adapter)) { errors.push(`node "${top.id}": unknown agent adapter "${adapter}" (available: ${availableAdapters().join(", ")})`); continue; }
        // A provider turned off in Settings is not offered anywhere; a workflow that still names one
        // says why, instead of failing at the CLI (task 15.14).
        if (providerChosenOff(store, adapter)) { errors.push(`node "${top.id}": the agent CLI "${adapter}" is turned off in Settings (Providers)`); continue; }
        errors.push(...resolveServers(store, adapter, spec.mcp, agentFolder(spec, baseDir)).errors.map((e) => `node "${top.id}": ${e}`));
      } else {
        if (!sb.available) errors.push(`node "${top.id}": script nodes are disabled: ${sb.reason}`);
        errors.push(...resolveSandbox(spec.sandbox, spec.cwd ? expand(spec.cwd) : baseDir).errors.map((e) => `node "${top.id}": sandbox: ${e}`));
      }
    }
  }
  for (const w of widenedScripts(wf, baseDir)) {
    if (!w.hash) { errors.push(`node "${w.nodeId}": script not found: ${w.path}`); continue; }
    const approved = workflowId == null ? null : store.getApproval(workflowId, w.key);
    if (approved !== w.hash) errors.push(`node "${w.nodeId}": widens the sandbox (${describeWidening(w.sandbox)}) and is not approved for the current script; run \`chief workflow approve ${wf.name}\``);
  }
  return { errors: [...new Set(errors)], warnings };
}

export const describeWidening = (sb: any) =>
  [sb?.network ? "network" : null, sb?.write?.length ? `write: ${sb.write.join(", ")}` : null, sb?.env?.length ? `env: ${sb.env.join(", ")}` : null].filter(Boolean).join("; ");

/** Create a run. The caller then calls `driveRun`. */
export function startRun(store: Store, workflowName: string, inputs: Record<string, unknown> = {}, budget: { "warn-usd"?: number; "max-usd"?: number } | null = null, parentRunId: number | null = null, startFrom: string | null = null, fromInputSet: { id: number; name: string } | null = null): RunRow {
  const wf = store.getWorkflow(workflowName);
  if (!wf) throw new EngineError(`workflow "${workflowName}" not found`);
  // One place, so every way in is covered: the API, `chief run`, a rerun and a schedule. A schedule of an archived
  // workflow is already skipped by the scheduler, but a rerun must not quietly revive one (task 15.2).
  if (wf.archived_at) throw new EngineError(`workflow "${wf.name}" is archived. Unarchive it to run it.`);
  const pre = preflight(store, wf.definition, wf.base_dir ?? process.cwd(), wf.id);
  if (pre.errors.length) throw new EngineError(`cannot run "${wf.name}":\n- ${pre.errors.join("\n- ")}`);
  // The inputs the workflow refers to must all have a value before anything starts, and so must the fields it declares as required (15.119).
  const merged = mergeInputs(wf.definition.inputs, inputs);
  const required = missingRequired(wf.definition, merged);
  if (required.length) throw new EngineError(requiredFieldsMessage(`run "${wf.name}"`, required));
  const missing = missingInputs(wf.definition, merged);
  if (missing.length) throw new EngineError(missingInputsMessage(`run "${wf.name}"`, missing, merged));
  // The working directory is created when a run first needs it (the designer does not create it while a path is being typed).
  if (wf.base_dir) { try { mkdirSync(wf.base_dir, { recursive: true }); } catch { /* a node that needs it reports the problem */ } }
  const run = store.createRun(wf, inputs, budget && Object.keys(budget).length ? budget : null, parentRunId, startFrom, fromInputSet);
  store.addEvent(run.id, "run_created", { workflow: wf.name, version: wf.version, inputs, ...(fromInputSet ? { input_set_id: fromInputSet.id, input_set_name: fromInputSet.name } : {}) });
  store.addMessage(run.id, { direction: "user", kind: "run_input", content: JSON.stringify(merged, null, 2), meta: { workflow: wf.name, version: wf.version, budget } });
  return run;
}

/**
 * Run a run again: a new run of the same workflow, as the workflow is now, with the inputs the
 * earlier run ran with (its own values over the defaults it had then) and its budget. The earlier
 * run is left as it is. The caller then calls `driveRun`.
 *
 * `from` starts the new run **at that step** instead of at the beginning: everything upstream of it is taken from the
 * earlier run's own result and not run again. A workflow is mostly the steps before the one that is wrong, so that is the
 * difference between re-reading what has already been read (tokens, minutes) and not (asked 2026-11-23: *"a full rerun of
 * a workflow run everytime is waste of token and time, can we have an option to run from a certain step onwards only?"*).
 *
 * What the new run gets from the old one:
 * - **Its results, as `{{nodes.<id>.output}}`**: `buildScope` reads them through `parent_run_id`, so a step's result is the
 *   one recorded by the old run, attributed to the old run, and nothing is faked in the new run's own record.
 * - **Nothing to prove it ran**: a step after it can only refer to a step that runs before it (there is a path of arrows),
 *   and every one of those completed in the old run — otherwise the step it asks to start from could never have run.
 */
export function rerunRun(store: Store, runId: number, from?: string | null): RunRow {
  const old = store.getRun(runId);
  if (!old) throw new EngineError(`run ${runId} not found`);
  const wf = store.getWorkflow(old.workflow_id);
  if (!wf) throw new EngineError(`the workflow of run ${runId} no longer exists`);
  const startedAt = from ? String(from) : "";
  if (startedAt) {
    const order = topoOrder(wf.definition);
    if (!order.includes(startedAt)) throw new EngineError(`step "${startedAt}" is not a step of "${wf.name}" in version ${wf.version}`);
    // Every step before it must have a **completed** attempt in the earlier run: the new run is given those results, and a
    // result that is not there is not something to guess at.
    const missing = order.slice(0, order.indexOf(startedAt)).filter((id) => {
      const nr = old.definition && store.latestNodeRun(old.id, id);
      return nr?.status !== "completed";
    });
    if (missing.length) throw new EngineError(`cannot start at "${startedAt}": ${missing.join(", ")} ${missing.length === 1 ? "did" : "did"} not complete in run ${old.id}. Start from ${missing[0]} or earlier.`);
  }
  const inputs = mergeInputs(old.definition?.inputs, old.inputs);
  const run = startRun(store, wf.name, inputs, old.budget, old.id, startedAt || null);
  store.addEvent(run.id, "run_rerun", { of: old.id, workflow_version: wf.version, earlier_version: old.workflow_version, from: startedAt || null });
  store.addMessage(run.id, {
    direction: "system", kind: "rerun",
    content: startedAt
      ? `Run ${old.id} run again starting at step "${startedAt}": the steps before it keep the results they returned in run ${old.id} and are not run again.${wf.version !== old.workflow_version ? ` On the workflow as it is now (version ${wf.version}; run ${old.id} used version ${old.workflow_version}).` : ""}`
      : `Run ${old.id} run again, with the inputs it ran with${wf.version !== old.workflow_version ? `, on the workflow as it is now (version ${wf.version}; run ${old.id} used version ${old.workflow_version})` : ""}.`,
    meta: { of: old.id, from: startedAt || null },
  });
  return run;
}

function cancelNow(ctx: Ctx, reason = "cancelled") {
  for (const nr of ctx.store.nodeRuns(ctx.runId)) {
    if (!TERMINAL_NODE.includes(nr.status)) ctx.store.updateNodeRun(nr.id, { status: "cancelled", finished_at: now() });
  }
  ctx.store.cancelGates(ctx.runId);
  ctx.store.updateRun(ctx.runId, { status: "cancelled", requested_action: null, finished_at: now(), error: reason });
  event(ctx, "run_cancelled", { reason });
}

/** One pass over the DAG in dependency order: every node whose predecessors completed gets a chance to move. */
/**
 * Steps kept from the run this one continues (`parent_run_id`): everything before the step a partial rerun starts at.
 * Computed once per pass from the parent's own record, so a step in the set is never executed here and its result comes
 * from `buildScope`, which reads the parent's completed attempts.
 */
function keptFromParent(ctx: Ctx): string[] {
  const parentId = getRun(ctx).parent_run_id;
  if (!parentId) return [];
  const parent = ctx.store.getRun(parentId);
  if (!parent) return [];
  // The step the run starts at is recorded when the run is created (`start_from`): not inferred from which steps have
  // attempts, which the first pass changes (found by running it — see 010-run-start-from). Everything before that step came
  // from the parent, and only where the parent completed it.
  const start = getRun(ctx).start_from;
  if (!start) return [];
  const order = topoOrder(ctx.def);
  const at = order.indexOf(start);
  if (at <= 0) return [];
  return order.slice(0, at).filter((id) => ctx.store.latestNodeRun(parentId, id)?.status === "completed");
}

async function pass(ctx: Ctx) {
  // Only a partial rerun keeps steps: see `keptFromParent`.
  const keptIds = keptFromParent(ctx);
  const kept = new Set(keptIds);
  // Said on the step the run starts at, in the run's own record: which step's results are the earlier run's is the first
  // thing a person reading this run needs to know, and it is not derivable from this run's attempts (this one has none for
  // them). Written once, on the first pass that gets there.
  if (keptIds.length && !ctx.store.nodeRuns(ctx.runId).some((r) => r.status !== "pending" && r.status !== "cancelled")) {
    const start = topoOrder(ctx.def).find((id) => !kept.has(id));
    if (start) ctx.store.addMessage(ctx.runId, {
      node_id: start, direction: "system", kind: "resumed_from",
      content: `This run starts at step "${start}". The results of ${keptIds.join(", ")} are run #${getRun(ctx).parent_run_id}'s and are not run again here.`,
      meta: { from: getRun(ctx).parent_run_id, kept: keptIds },
    });
  }
  for (const id of topoOrder(ctx.def)) {
    if (getRun(ctx).requested_action) return;
    if (kept.has(id)) continue;
    // A step is ready when every predecessor completed **either** in this run or, for a partial rerun, in the run this one
    // continues. Without the second half the run stops at once: the first step of a partial rerun has a predecessor that
    // completed in the parent and has no attempt here, so nothing was ever ready ("no node can make progress", found by
    // running it).
    const parent = getRun(ctx).parent_run_id;
    const done = (p: string) => ctx.store.latestNodeRun(ctx.runId, p)?.status === "completed" || (parent != null && kept.has(p) && ctx.store.latestNodeRun(parent, p)?.status === "completed");
    const ready = predecessors(ctx.def, id).every(done);
    if (!ready) continue;
    const node = ctx.def.nodes.find((n) => n.id === id)!;
    const nr = await execNode(ctx, node, buildScope(ctx));
    if (nr.status === "failed") return;
  }
}

function finalize(ctx: Ctx) {
  // A step a partial rerun kept has no attempt here: its result is the parent run's, and it counts as completed. Without
  // this the run ended "no node can make progress" with every step it did run completed, because `every(completed)` was
  // false on the kept one (found by running it).
  const parent = getRun(ctx).parent_run_id;
  const kept = new Set(keptFromParent(ctx));
  const tops = ctx.def.nodes.map((n) => ctx.store.latestNodeRun(ctx.runId, n.id)
    ?? (parent != null && kept.has(n.id) ? ctx.store.latestNodeRun(parent, n.id) : undefined));
  const failed = tops.find((t) => t?.status === "failed");
  if (failed) {
    ctx.store.updateRun(ctx.runId, { status: "failed", error: `node "${failed.node_id}": ${failed.error}`, finished_at: now() });
    return event(ctx, "run_failed", { node_id: failed.node_id, error: failed.error });
  }
  if (ctx.store.gates({ runId: ctx.runId, status: "waiting" }).length) {
    ctx.store.updateRun(ctx.runId, { status: "waiting_gate" });
    return event(ctx, "run_waiting", {});
  }
  if (tops.every((t) => t?.status === "completed")) {
    ctx.store.updateRun(ctx.runId, { status: "completed", finished_at: now(), error: null });
    return event(ctx, "run_completed", {});
  }
  if (ctx.store.nodeRuns(ctx.runId).some((n) => n.status === "interrupted")) {
    ctx.store.updateRun(ctx.runId, { status: "paused" });
    return event(ctx, "run_paused", {});
  }
  ctx.store.updateRun(ctx.runId, { status: "failed", error: "no node can make progress", finished_at: now() });
  event(ctx, "run_failed", { error: "no node can make progress" });
}

/**
 * Advance a run until it completes, fails, is paused or cancelled, or waits on a gate.
 * All state is in the database, so any process may call this; only one at a time owns a run.
 */
export async function driveRun(store: Store, runId: number, opts: { retryFailed?: boolean } = {}): Promise<RunRow> {
  if (!store.claimRun(runId, process.pid, isAlive)) return store.getRun(runId)!;
  try {
    let run = store.getRun(runId)!;
    if (!["pending", "running", "waiting_gate"].includes(run.status)) return run;
    const ctx = makeCtx(store, run);
    ctx.retryFailed = !!opts.retryFailed;
    if (run.status === "pending") event(ctx, "run_started", {});
    store.updateRun(runId, { status: "running", started_at: run.started_at ?? now() });
    for (;;) {
      run = getRun(ctx);
      if (run.requested_action === "cancel") { cancelNow(ctx); break; }
      if (run.requested_action === "pause") {
        store.updateRun(runId, { status: "paused", requested_action: null });
        event(ctx, "run_paused", {});
        break;
      }
      ctx.changes = 0;
      await pass(ctx);
      ctx.retryFailed = false;
      if (ctx.changes === 0 && !getRun(ctx).requested_action) { finalize(ctx); break; }
    }
  } finally {
    store.releaseRun(runId, process.pid);
  }
  // A feedback gate answered with "restart" queued a follow-up run.
  for (const child of store.childRuns(runId)) if (child.status === "pending") await driveRun(store, child.id);
  return store.getRun(runId)!;
}

const ownedElsewhere = (run: RunRow) => !!run.owner_pid && run.owner_pid !== process.pid && isAlive(run.owner_pid);
const ownedLive = (run: RunRow) => !!run.owner_pid && isAlive(run.owner_pid);

/** Pause: in-flight CLI processes get SIGINT and their nodes become `interrupted`, keeping the session id. */
export function requestPause(store: Store, runId: number): RunRow {
  const run = mustRun(store, runId);
  if (TERMINAL_RUN.includes(run.status) || run.status === "paused" || run.status === "reverting") throw new EngineError(`run ${runId} is ${run.status}; nothing to pause`);
  if (run.status === "running" && ownedLive(run)) store.updateRun(runId, { requested_action: "pause" });
  else { store.updateRun(runId, { status: "paused", requested_action: null }); store.addEvent(runId, "run_paused", {}); }
  return store.getRun(runId)!;
}

/** Resume a paused, interrupted or failed run. The caller then calls `driveRun` with the returned options. */
export function resumeRun(store: Store, runId: number): { run: RunRow; retryFailed: boolean } {
  const run = mustRun(store, runId);
  if (!["paused", "interrupted", "failed"].includes(run.status)) throw new EngineError(`run ${runId} is ${run.status}; only paused, interrupted or failed runs can be resumed`);
  if (ownedElsewhere(run)) throw new EngineError(`run ${runId} is still owned by process ${run.owner_pid}`);
  store.updateRun(runId, { status: "running", requested_action: null, error: null, finished_at: null });
  store.addEvent(runId, "run_resumed", { from: run.status });
  return { run: store.getRun(runId)!, retryFailed: run.status === "failed" };
}

export function requestCancel(store: Store, runId: number): RunRow {
  const run = mustRun(store, runId);
  if (TERMINAL_RUN.includes(run.status)) throw new EngineError(`run ${runId} is already ${run.status}`);
  if (run.status === "running" && ownedLive(run)) store.updateRun(runId, { requested_action: "cancel" });
  else cancelNow(makeCtx(store, run));
  return store.getRun(runId)!;
}

function validateAnswer(gate: GateRow, a: any): string | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return "the answer must be a JSON object";
  if (gate.kind === "ask") {
    const values = a.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) return "`values` must be an object with one entry per question";
    for (const f of gate.payload.fields as any[]) {
      const v = values[f.id];
      const missing = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
      if (missing) { if (f.required) return `"${f.id}" (${f.label}) needs an answer`; continue; }
      const inRange = (i: any) => Number.isInteger(i) && i >= 0 && i < f.options.length;
      if (f.type === "choose-many" && (!Array.isArray(v) || !v.every(inRange))) return `"${f.id}" must be a list of option numbers between 0 and ${f.options.length - 1}`;
      if (f.type === "choose-one" && !inRange(v)) return `"${f.id}" must be one option number between 0 and ${f.options.length - 1}`;
      if (f.type === "yes-no" && typeof v !== "boolean") return `"${f.id}" must be true or false`;
      if ((f.type === "text" || f.type === "long-text") && typeof v !== "string") return `"${f.id}" must be text`;
    }
    const unknown = Object.keys(values).filter((k) => !gate.payload.fields.some((f: any) => f.id === k));
    if (unknown.length) return `unknown question${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`;
  } else if (gate.kind === "select") {
    const modes: string[] = gate.payload.modes ?? [];
    const mode = a.mode ?? "one-by-one";
    if (!modes.includes(mode)) return `mode must be one of: ${modes.join(", ")}`;
    if (mode === "one-by-one" && (!Array.isArray(a.selected) || a.selected.some((i: any) => !Number.isInteger(i) || i < 0 || i >= gate.payload.items.length))) return "`selected` must be a list of item indexes";
    if (a["run-mode"] && !["sequential", "parallel"].includes(a["run-mode"])) return "`run-mode` must be sequential or parallel";
  } else if (gate.kind === "approve") {
    if (!["approve", "reject"].includes(a.decision)) return '`decision` must be "approve" or "reject"';
  } else {
    const options: string[] = gate.payload.options ?? [];
    if (a.option != null && options.length && !options.includes(a.option)) return `option must be one of: ${options.join(", ")}`;
    if (a.text != null && typeof a.text !== "string") return "`text` must be a string";
  }
  return null;
}

/** Record a gate answer. Returns whether the caller should drive the run (nobody else is). */
export function answerGate(store: Store, gateId: number, answer: any): { gate: GateRow; drive: boolean } {
  const gate = store.getGate(gateId);
  if (!gate) throw new EngineError(`gate ${gateId} not found`);
  if (gate.status !== "waiting") throw new EngineError(`gate ${gateId} is ${gate.status === "consumed" ? "already answered" : gate.status}`);
  const problem = validateAnswer(gate, answer);
  if (problem) throw new EngineError(`invalid answer for ${gate.kind} gate: ${problem}`);
  store.answerGate(gateId, answer);
  store.addEvent(gate.run_id, "gate_answered", { gate_id: gateId, kind: gate.kind, reason: gate.reason, answer }, gate.node_run_id);
  store.addMessage(gate.run_id, { node_run_id: gate.node_run_id, node_id: gate.node_id, direction: "user", kind: "gate_answer", content: JSON.stringify(answer, null, 2), meta: { gate_id: gateId, kind: gate.kind, reason: gate.reason } });
  const run = store.getRun(gate.run_id)!;
  return { gate: store.getGate(gateId)!, drive: run.status === "waiting_gate" && !ownedLive(run) };
}

/** Crash recovery: a `running` run whose owner process is gone becomes `interrupted`. */
export function recover(store: Store): number[] {
  const recovered: number[] = [];
  for (const run of store.runsByStatus(["running", "reverting"])) {
    // Called when a process starts, before it drives anything. A run that names this very process
    // as its owner was being driven by code that is gone: the dev server reloads inside the same
    // process when its source changes (node --watch), and a process id can be reused.
    if (run.owner_pid !== process.pid && ownedLive(run)) continue;
    for (const nr of store.nodeRuns(run.id)) {
      if (nr.status !== "running") continue;
      // The agent or script may have outlived the chief process that started it.
      if (nr.state?.child) killOrphan(nr.state.child);
      store.updateNodeRun(nr.id, { status: "interrupted" });
    }
    store.updateRun(run.id, { status: "interrupted", owner_pid: null, requested_action: null });
    store.addEvent(run.id, "run_interrupted", { reason: "owner process is gone" });
    recovered.push(run.id);
  }
  return recovered;
}

function mustRun(store: Store, id: number): RunRow {
  const run = store.getRun(id);
  if (!run) throw new EngineError(`run ${id} not found`);
  return run;
}

export { makeCtx, cancelNow, mustRun };

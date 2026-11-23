import { notifyGate } from "../notify.ts";
import type { Store } from "../store/store.ts";
import type { GateRow, MessageDirection, NodeRunRow, NodeRunStatus, RunRow, Usage } from "../store/types.ts";
import type { StopReason } from "../util/proc.ts";
import type { Workflow } from "../workflow/schema.ts";
import { renderString, renderValue, type RenderOptions } from "../workflow/template.ts";
import { mergeInputs } from "../workflow/inputs.ts";

/** Everything a runner needs for one run. Run state itself always lives in the database. */
export interface Ctx {
  store: Store;
  runId: number;
  def: Workflow;
  baseDir: string;
  /** Bumped on every node status change; a pass with no changes means the run is blocked or done. */
  changes: number;
  /** Set for the first pass after `resume` of a failed run: failed nodes get a new attempt. */
  retryFailed: boolean;
}

export const now = () => new Date().toISOString();

export const getRun = (ctx: Ctx): RunRow => ctx.store.getRun(ctx.runId)!;

export function shouldStop(ctx: Ctx): StopReason {
  return getRun(ctx).requested_action ?? null;
}

export function event(ctx: Ctx, type: string, payload: any = {}, nodeRunId: number | null = null) {
  ctx.store.addEvent(ctx.runId, type, payload, nodeRunId);
}

export function setStatus(ctx: Ctx, nr: NodeRunRow, status: NodeRunStatus, patch: Parameters<Store["updateNodeRun"]>[1] = {}) {
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  ctx.store.updateNodeRun(nr.id, {
    status,
    ...(status === "running" && !nr.started_at ? { started_at: now() } : {}),
    ...(terminal ? { finished_at: now() } : {}),
    ...patch,
  });
  ctx.changes++;
  event(ctx, `node_${status}`, { node_id: nr.node_id, item_index: nr.item_index, attempt: nr.attempt, phase: nr.phase, ...(patch.error ? { error: patch.error } : {}) }, nr.id);
}

/** Append to the run's full record (see `run_messages`). */
export function record(ctx: Ctx, nr: NodeRunRow | null, direction: MessageDirection, kind: string, content: string, meta?: any) {
  ctx.store.addMessage(ctx.runId, { node_run_id: nr?.id ?? null, node_id: nr?.node_id ?? null, direction, kind, content, meta });
}

export const fail = (ctx: Ctx, nr: NodeRunRow, error: string) => setStatus(ctx, nr, "failed", { error });

export function openGate(ctx: Ctx, v: { nodeRun?: NodeRunRow | null; kind: GateRow["kind"]; reason: GateRow["reason"]; payload: any }): GateRow {
  const gate = ctx.store.createGate({ run_id: ctx.runId, node_run_id: v.nodeRun?.id ?? null, node_id: v.nodeRun?.node_id ?? null, kind: v.kind, reason: v.reason, payload: v.payload });
  ctx.changes++;
  event(ctx, "gate_opened", { gate_id: gate.id, kind: gate.kind, reason: gate.reason, node_id: gate.node_id }, v.nodeRun?.id ?? null);
  record(ctx, v.nodeRun ?? null, "system", "gate_question", JSON.stringify(v.payload, null, 2), { gate_id: gate.id, kind: gate.kind, reason: gate.reason });
  notifyGate(ctx.store, gate, ctx.def.name);
  return gate;
}

/** Template scope: inputs, outputs of completed top-level nodes, plus node-local extras. */
export function buildScope(ctx: Ctx, extra: Record<string, unknown> = {}) {
  const run = getRun(ctx);
  // `output` is the step's JSON result; `reply` is what an agent wrote besides it.
  const nodes: Record<string, { output: any; reply: string }> = {};
  for (const n of ctx.def.nodes) {
    // A step of this run if it has run, otherwise — and only for a **partial rerun** — the result the earlier run recorded
    // (see rerunRun). The value is the earlier run's: it is not copied in, not attributed to this run, and the step's own
    // record here links to run #N, which is where the reader goes to see what it produced.
    const here = ctx.store.latestNodeRun(ctx.runId, n.id);
    const nr = here?.status === "completed" ? here : parentResult(ctx, n.id);
    if (nr?.status === "completed") nodes[n.id] = { output: nr.output, reply: typeof nr.state?.reply === "string" ? nr.state.reply : "" };
  }
  return {
    // The run's values over the workflow's defaults, merged level by level (a nested default survives a run input beside it).
    inputs: mergeInputs(ctx.def.inputs, run.inputs),
    nodes,
    ...extra,
  };
}

/** The attempt of the run this one continues (`parent_run_id`) for a step, when it completed there. */
function parentResult(ctx: Ctx, nodeId: string): NodeRunRow | null {
  const parentId = getRun(ctx).parent_run_id;
  if (!parentId) return null;
  const nr = ctx.store.latestNodeRun(parentId, nodeId);
  return nr?.status === "completed" ? nr : null;
}

function renderOpts(ctx: Ctx, nr: NodeRunRow | null): RenderOptions {
  return {
    maxValueChars: ctx.store.getSetting<number>("output-size-limit", 20_000),
    onTruncate: (ref, chars) => event(ctx, "output_truncated", { ref, chars, node_id: nr?.node_id }, nr?.id ?? null),
  };
}
export const render = (ctx: Ctx, nr: NodeRunRow | null, text: string, scope: any) => renderString(text, scope, renderOpts(ctx, nr));
export const renderAny = (ctx: Ctx, nr: NodeRunRow | null, value: unknown, scope: any) => renderValue(value, scope, renderOpts(ctx, nr));

/** Recompute the run's token and cost totals from its node runs. */
export function refreshTotals(ctx: Ctx) {
  let tin = 0, tout = 0, cost = 0;
  for (const nr of ctx.store.nodeRuns(ctx.runId)) {
    const u = nr.usage as Usage | null;
    if (!u) continue;
    tin += u.input_tokens + u.cache_read_tokens + u.cache_write_tokens;
    tout += u.output_tokens;
    cost += u.cost_usd;
  }
  ctx.store.updateRun(ctx.runId, { tokens_in: tin, tokens_out: tout, cost_usd: cost });
}

/** Budget for a run: the `default-budget` setting, overridden by the workflow, overridden by the run. */
export function effectiveBudget(store: Store, run: RunRow): { "warn-usd"?: number; "max-usd"?: number } {
  return { ...store.getSetting("default-budget", {}), ...(run.definition?.budget ?? {}), ...(run.budget ?? {}) };
}

/**
 * Budget check, called before any node starts work.
 * Returns true when the run must not spend more until the user answers the budget gate.
 */
export function budgetBlocked(ctx: Ctx): boolean {
  const run = getRun(ctx);
  const budget = effectiveBudget(ctx.store, run);
  const warn = budget["warn-usd"], max = budget["max-usd"];
  if (warn && run.cost_usd >= warn && !ctx.store.events(ctx.runId).some((e) => e.type === "budget_warning")) {
    event(ctx, "budget_warning", { cost_usd: run.cost_usd, "warn-usd": warn });
  }
  if (!max || run.cost_usd < max) return false;

  const gate = ctx.store.latestBudgetGate(ctx.runId);
  if (gate?.status === "waiting") return true;
  if (gate?.status === "answered") {
    ctx.store.consumeGate(gate.id);
    ctx.changes++;
    if (gate.answer?.decision === "approve") {
      const step = ctx.def.budget?.["max-usd"] ?? ctx.store.getSetting<any>("default-budget", {})["max-usd"] ?? max;
      // "Continue" must actually let the run continue: one more step above what is already spent.
      const next = typeof gate.answer.value === "number" ? gate.answer.value : Math.max(max, run.cost_usd) + step;
      ctx.store.updateRun(ctx.runId, { budget: { ...(run.budget ?? {}), "max-usd": next } });
      event(ctx, "budget_raised", { "max-usd": next });
      return run.cost_usd >= next ? budgetBlocked(ctx) : false;
    }
    ctx.store.updateRun(ctx.runId, { requested_action: "cancel" });
    event(ctx, "budget_stop", {});
    return true;
  }
  openGate(ctx, { kind: "approve", reason: "budget", payload: { message: `Budget reached: $${run.cost_usd.toFixed(4)} spent, limit $${max.toFixed(2)}. Continue or stop?`, cost_usd: run.cost_usd, "max-usd": max } });
  return true;
}

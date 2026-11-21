import type { Store } from "../store/store.ts";
import type { NodeRunRow, RunRow } from "../store/types.ts";
import { TERMINAL_NODE } from "../store/types.ts";
import { isAlive } from "../util/proc.ts";
import { topoOrder } from "../workflow/load.ts";
import type { Workflow } from "../workflow/schema.ts";
import { buildScope, event, now, type Ctx } from "./context.ts";
import { EngineError, makeCtx, mustRun } from "./engine.ts";
import { isWidened, runAgent, runScript } from "./runners.ts";

export interface ManualItem { node_id: string; item_index: number | null; kind: string; ref: string | null; url: string | null; how_to_undo: string | null; reason: string }
export interface RevertReport { run_id: number; compensated: string[]; reverted_effects: number; manual: ManualItem[]; skipped: string[] }

/** The executable definition (top-level or map inner node) a node run belongs to, and its top-level node id. */
function findNode(wf: Workflow, nodeId: string): { node: any; topId: string } | null {
  for (const top of wf.nodes) {
    if (top.id === nodeId) return { node: top, topId: top.id };
    if (top.type === "map" && top.node.id === nodeId) return { node: top.node, topId: top.id };
  }
  return null;
}

/**
 * Saga revert: walk completed node runs in reverse order and run each node's compensation.
 * Effects that cannot be undone automatically are reported as manual items.
 * With `to`, only nodes that come after that node are reverted.
 */
export async function revertRun(store: Store, runId: number, opts: { to?: string } = {}): Promise<RevertReport> {
  const run: RunRow = mustRun(store, runId);
  if (["pending", "running", "reverting", "reverted"].includes(run.status)) throw new EngineError(`run ${runId} is ${run.status}; it cannot be reverted now`);
  if (!store.claimRun(runId, process.pid, isAlive)) throw new EngineError(`run ${runId} is owned by another process`);
  const ctx: Ctx = makeCtx(store, run);
  const report: RevertReport = { run_id: runId, compensated: [], reverted_effects: 0, manual: [], skipped: [] };
  try {
    const order = topoOrder(ctx.def);
    if (opts.to && !order.includes(opts.to)) throw new EngineError(`node "${opts.to}" is not a top-level node of this workflow`);
    const after = opts.to ? new Set(order.slice(order.indexOf(opts.to) + 1)) : null;

    store.cancelGates(runId);
    for (const nr of store.nodeRuns(runId)) if (!TERMINAL_NODE.includes(nr.status)) store.updateNodeRun(nr.id, { status: "cancelled", finished_at: now() });
    store.updateRun(runId, { status: "reverting", requested_action: null });
    event(ctx, "revert_started", { to: opts.to ?? null });

    const targets = store.nodeRuns(runId)
      .filter((nr) => nr.phase === "forward" && !nr.compensated_at && (nr.node_type === "agent" || nr.node_type === "script"))
      // Completed nodes, plus unfinished ones that already reported writes.
      .filter((nr) => nr.status === "completed" || store.sideEffects({ nodeRunId: nr.id }).length > 0)
      .filter((nr) => { const f = findNode(ctx.def, nr.node_id); return !!f && (!after || after.has(f.topId)); })
      .sort((a, b) => (b.finished_at ?? "").localeCompare(a.finished_at ?? "") || b.id - a.id);

    for (const nr of targets) {
      const { node } = findNode(ctx.def, nr.node_id)!;
      const effects = store.sideEffects({ nodeRunId: nr.id }).filter((e) => !e.reverted_at);
      const label = nr.item_index == null ? nr.node_id : `${nr.node_id}[${nr.item_index}]`;
      const manual = (e: { kind: string; ref: string | null; url: string | null; how_to_undo: string | null }, reason: string) =>
        report.manual.push({ node_id: nr.node_id, item_index: nr.item_index, kind: e.kind, ref: e.ref, url: e.url, how_to_undo: e.how_to_undo, reason });

      if (!node.compensate) {
        for (const e of effects) manual(e, e.irreversible ? "irreversible" : "node has no compensation");
        if (!effects.length && node.type === "script" && isWidened(node.sandbox)) {
          manual({ kind: "script", ref: node.run, url: null, how_to_undo: null }, "script ran with widened sandbox permissions and has no compensation; check its effects");
        } else if (!effects.length) report.skipped.push(label);
        continue;
      }

      const cnr: NodeRunRow = store.createNodeRun({ run_id: runId, node_id: nr.node_id, node_type: node.compensate.run ? "script" : "agent", phase: "compensate", parent_node_run_id: nr.id, item_index: nr.item_index });
      const scope: any = buildScope(ctx, { item: nr.input?.item, output: nr.output, side_effects: effects.map(({ kind, ref, url, how_to_undo, irreversible }) => ({ kind, ref, url, how_to_undo, irreversible: !!irreversible })) });
      if (node.compensate.run) {
        await runScript(ctx, { id: nr.node_id, type: "script", run: node.compensate.run, interpreter: node.compensate.interpreter, timeout: node.compensate.timeout, cwd: node.cwd, sandbox: node.compensate.sandbox ?? node.sandbox, input: { output: scope.output, side_effects: scope.side_effects, item: scope.item ?? null } }, cnr, scope, `${nr.node_id}#compensate`);
      } else {
        await runAgent(ctx, { id: nr.node_id, type: "agent", prompt: node.compensate.prompt, mcp: node.compensate.mcp ?? node.mcp, model: node.compensate.model ?? node.model, agent: node.agent, cwd: node.cwd, tools: node.tools, timeout: node.compensate.timeout }, cnr, scope, "compensate");
      }
      const done = store.getNodeRun(cnr.id)!;
      if (done.status !== "completed") {
        for (const e of effects) manual(e, `compensation failed: ${done.error ?? done.status}`);
        if (!effects.length) manual({ kind: node.type, ref: label, url: null, how_to_undo: null }, `compensation failed: ${done.error ?? done.status}`);
        continue;
      }
      const failedRefs = new Map<string, string>((Array.isArray(done.output?.failed) ? done.output.failed : []).map((f: any) => [String(f?.ref), String(f?.reason ?? "could not be undone")]));
      for (const e of effects) {
        if (e.irreversible) manual(e, "irreversible");
        else if (e.ref != null && failedRefs.has(e.ref)) manual(e, failedRefs.get(e.ref)!);
        else { store.markReverted(e.id); report.reverted_effects++; }
      }
      store.updateNodeRun(nr.id, { compensated_at: now() });
      report.compensated.push(label);
    }

    store.updateRun(runId, { status: "reverted", finished_at: now() });
    event(ctx, "revert_report", report);
  } catch (e) {
    if (store.getRun(runId)!.status === "reverting") store.updateRun(runId, { status: "failed", error: `revert failed: ${(e as Error).message}` });
    throw e;
  } finally {
    store.releaseRun(runId, process.pid);
  }
  return report;
}

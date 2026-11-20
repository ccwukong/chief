/**
 * The run on its workflow's diagram: the same graph as the designer, read-only, with every step
 * coloured by its live status. Rendered from the run's definition and its node runs, so it
 * follows the run as the page refetches on each event.
 */
import { Background, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef } from "react";
import { useAppTheme } from "./theme";
import { autoLayout } from "./designer/model";

export type StepStatus = "pending" | "running" | "waiting_gate" | "interrupted" | "completed" | "failed" | "cancelled" | "reverting" | "reverted";

interface StepData extends Record<string, unknown> {
  nodeId: string; type: string; status: StepStatus; detail: string; attempt: number;
  progress: { done: number; total: number } | null;
}

const LABEL: Record<StepStatus, string> = {
  pending: "not reached", running: "in progress", waiting_gate: "waiting for you", interrupted: "interrupted",
  completed: "completed", failed: "failed", cancelled: "cancelled", reverting: "reverting", reverted: "reverted",
};
/** Border and background per status; the pulse of a step in progress is in styles.css. */
const STYLE: Record<StepStatus, string> = {
  pending: "border-slate-300 bg-surface text-slate-500 border-dashed",
  running: "border-blue-600 bg-blue-50 text-blue-900 diagram-running",
  waiting_gate: "border-amber-500 bg-amber-50 text-amber-900 diagram-waiting",
  interrupted: "border-purple-500 bg-purple-50 text-purple-900",
  completed: "border-green-600 bg-green-50 text-green-900",
  failed: "border-red-600 bg-red-50 text-red-900",
  cancelled: "border-slate-400 bg-slate-100 text-slate-500",
  reverting: "border-orange-500 bg-orange-50 text-orange-900 diagram-running",
  reverted: "border-orange-500 bg-orange-50 text-orange-900",
};
const MARK: Record<StepStatus, string> = { pending: "○", running: "◐", waiting_gate: "?", interrupted: "‖", completed: "✓", failed: "✕", cancelled: "–", reverting: "↶", reverted: "↶" };

function StepNode({ data }: NodeProps<Node<StepData>>) {
  const d = data;
  return (
    <div data-testid={`diagram-node-${d.nodeId}`} data-status={d.status} title={`${d.nodeId}: ${LABEL[d.status]} (click to open the step)`}
      className={`w-48 cursor-pointer rounded border-2 px-3 py-1.5 shadow-sm ${STYLE[d.status]}`}>
      <Handle type="target" position={Position.Top} className="!bg-slate-400" />
      <div className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wide opacity-70">
        <span>{d.type}</span>
        <span className="ml-auto normal-case tracking-normal" data-testid={`diagram-status-${d.nodeId}`}>{MARK[d.status]} {LABEL[d.status]}{d.attempt > 1 ? ` · try ${d.attempt}` : ""}</span>
      </div>
      <div className="truncate text-sm font-semibold">{d.nodeId}</div>
      {d.progress ? (
        <div className="mt-0.5" data-testid={`diagram-progress-${d.nodeId}`}>
          <div className="h-1.5 w-full overflow-hidden rounded bg-surface/70"><div className="h-full bg-current opacity-60" style={{ width: `${d.progress.total ? Math.round((100 * d.progress.done) / d.progress.total) : 0}%` }} /></div>
          <div className="text-2xs">{d.progress.done} of {d.progress.total} items done</div>
        </div>
      ) : <div className="truncate text-2xs opacity-70">{d.detail}</div>}
      <Handle type="source" position={Position.Bottom} className="!bg-slate-400" />
    </div>
  );
}
const nodeTypes = { step: StepNode };

/**
 * The status of a top-level step, from its node runs: its latest attempt, or its compensation once
 * a revert reached it (a compensation hangs under the attempt it undoes, or under a map's items).
 */
export function stepStatus(nodeRuns: any[], nodeId: string): { status: StepStatus; attempt: number; progress: { done: number; total: number } | null } {
  const fwd = nodeRuns.filter((n) => n.node_id === nodeId && n.parent_node_run_id == null && n.phase === "forward").sort((a, b) => a.id - b.id).at(-1);
  if (!fwd) return { status: "pending", attempt: 0, progress: null };
  const children = nodeRuns.filter((n) => n.parent_node_run_id === fwd.id && n.phase === "forward");
  const under = new Set([fwd.id, ...children.map((c) => c.id)]);
  const comp = nodeRuns.filter((n) => n.phase === "compensate" && under.has(n.parent_node_run_id)).sort((a, b) => a.id - b.id).at(-1);
  if (comp) return { status: comp.status === "completed" ? "reverted" : comp.status === "failed" ? "failed" : "reverting", attempt: fwd.attempt, progress: null };
  if (fwd.compensated_at) return { status: "reverted", attempt: fwd.attempt, progress: null };
  const progress = fwd.node_type === "map" ? { done: children.filter((c) => c.status === "completed").length, total: children.length } : null;
  return { status: fwd.status as StepStatus, attempt: fwd.attempt, progress };
}

const EDGE_COLOR: Record<string, string> = { done: "#16a34a", active: "#2563eb", idle: "#94a3b8" };

export function RunDiagram({ definition, nodeRuns, onOpen }: { definition: any; nodeRuns: any[]; onOpen: (nodeId: string) => void }) {
  const { nodes, edges } = useMemo(() => {
    const defNodes: any[] = definition?.nodes ?? [];
    const defEdges: { from: string; to: string }[] = definition?.edges ?? [];
    const pos = autoLayout(defNodes, defEdges);
    const status: Record<string, StepStatus> = {};
    const nodes: Node<StepData>[] = defNodes.map((n) => {
      const st = stepStatus(nodeRuns, n.id);
      status[n.id] = st.status;
      const inner = n.type === "map" ? n.node : n;
      const detail = n.type === "gate" ? `${n.kind} gate` : n.type === "map" ? `each item → ${inner?.type ?? "agent"}` : inner?.type === "script" ? inner.run ?? "script" : inner?.model ?? "agent";
      return { id: n.id, type: "step", position: pos[n.id], data: { nodeId: n.id, type: n.type, status: st.status, attempt: st.attempt, progress: st.progress, detail }, draggable: false, selectable: false, connectable: false };
    });
    const edges: Edge[] = defEdges.map((e) => {
      const from = status[e.from], to = status[e.to];
      // The arrow into the step that is working moves; arrows between completed steps are green; the rest wait.
      const kind = from === "completed" && (to === "running" || to === "waiting_gate" || to === "reverting") ? "active" : from === "completed" && to !== "pending" ? "done" : "idle";
      return { id: `${e.from}-${e.to}`, source: e.from, target: e.to, animated: kind === "active", className: `diagram-edge-${kind}`, style: { stroke: EDGE_COLOR[kind], strokeWidth: kind === "idle" ? 1.5 : 2.5 }, markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: EDGE_COLOR[kind] } };
    });
    return { nodes, edges };
  }, [definition, nodeRuns]);

  // The diagram is a picture, not a canvas: it cannot be dragged, scrolled or zoomed, so it can never be lost.
  // It is fitted to its box, and fitted again when the box changes size (the window, the sidebar).
  const flow = useRef<ReactFlowInstance<Node<StepData>, Edge> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // React Flow draws its dots, its edges and its controls itself, so it is told the theme by name.
  const theme = useAppTheme();
  const fit = () => { void flow.current?.fitView({ padding: 0.15, maxZoom: 1, minZoom: 0.1 }); };
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  useEffect(fit, [nodes.length]);

  return (
    <div className="card mb-5 p-0" data-testid="run-diagram">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs">
        <span className="font-semibold uppercase text-slate-500">Progress</span>
        <span className="text-slate-500">Click a step to open it.</span>
        <span className="ml-auto flex flex-wrap gap-x-3 text-slate-600" data-testid="diagram-legend">
          {(["pending", "running", "waiting_gate", "completed", "failed"] as StepStatus[]).map((s) => <span key={s}><span className={`mr-1 inline-block h-2.5 w-2.5 rounded-sm border ${STYLE[s].split(" ").slice(0, 2).join(" ")}`} />{LABEL[s]}</span>)}
        </span>
      </div>
      <div ref={box} className="h-72 border-t border-slate-100" data-testid="run-diagram-canvas">
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1, minZoom: 0.1 }} minZoom={0.1}
            colorMode={theme}
            onInit={(inst) => { flow.current = inst; }}
            nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
            panOnDrag={false} panOnScroll={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} preventScrolling={false}
            onNodeClick={(_e, n) => onOpen(n.id)} proOptions={{ hideAttribution: true }}>
            <Background />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}

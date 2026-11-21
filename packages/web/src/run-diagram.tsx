/**
 * The run on its workflow's diagram: the same graph as the designer, read-only, with every step
 * coloured by its live status. Rendered from the run's definition and its node runs, so it
 * follows the run as the page refetches on each event.
 */
import { Background, ControlButton, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeChange, type NodeProps, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAppTheme } from "./theme";
import { autoLayout } from "./designer/model";
import { Card } from "./components/ui/card";

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
  running: "border-primary bg-primary/10 text-primary diagram-running",
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

export function RunDiagram({ definition, nodeRuns, workflow, onOpen }: { definition: any; nodeRuns: any[]; workflow: string; onOpen: (nodeId: string) => void }) {
  // React Flow draws a node `visibility: hidden` until it has measured it, and it keeps a measurement
  // only while it sees the same node object: a new object for an id it knows starts unmeasured again.
  // These nodes are rebuilt from the run's record on every update (the page polls and follows the
  // run's events), so the sizes React Flow reports are kept here and handed back with each new node.
  // Without that, every update made the whole diagram invisible until something happened to resize a
  // node, and on a busy machine nothing ever did: the steps could not be clicked at all (E9.49-2).
  const measured = useRef(new Map<string, { width: number; height: number }>());
  const onNodesChange = useCallback((changes: NodeChange<Node<StepData>>[]) => {
    for (const c of changes) if (c.type === "dimensions" && c.dimensions) measured.current.set(c.id, c.dimensions);
  }, []);
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
      return { id: n.id, type: "step", position: pos[n.id], measured: measured.current.get(n.id), data: { nodeId: n.id, type: n.type, status: st.status, attempt: st.attempt, progress: st.progress, detail }, draggable: false, selectable: false, connectable: false };
    });
    const edges: Edge[] = defEdges.map((e) => {
      const from = status[e.from], to = status[e.to];
      // The arrow into the step that is working moves; arrows between completed steps are green; the rest wait.
      const kind = from === "completed" && (to === "running" || to === "waiting_gate" || to === "reverting") ? "active" : from === "completed" && to !== "pending" ? "done" : "idle";
      return { id: `${e.from}-${e.to}`, source: e.from, target: e.to, animated: kind === "active", className: `diagram-edge-${kind}`, style: { stroke: EDGE_COLOR[kind], strokeWidth: kind === "idle" ? 1.5 : 2.5 }, markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: EDGE_COLOR[kind] } };
    });
    return { nodes, edges };
  }, [definition, nodeRuns]);

  // The diagram is a canvas again: it can be dragged, zoomed and pinched, and a labelled fit control puts the
  // whole workflow back in the box. The one thing it must not do is get lost: it is fitted when it opens and
  // when its box changes size, until the person moves it themselves — after that their view is left alone,
  // because a poll that re-fits under their hands is worse than a view they chose (reported 2026-11-21:
  // "this canvas is still not zoomable and a user still can't move around the canvas, and there's no center
  // button"). Nodes stay undraggable: this is the run's record, not the designer.
  const flow = useRef<ReactFlowInstance<Node<StepData>, Edge> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  // React Flow draws its dots, its edges and its controls itself, so it is told the theme by name.
  const theme = useAppTheme();
  const fit = () => { void flow.current?.fitView({ padding: 0.15, maxZoom: 1, minZoom: 0.1 }); };
  /** Fit now and go back to following the box: the way back after panning or zooming away. */
  const recenter = () => { moved.current = false; fit(); };
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (!moved.current) fit(); });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (!moved.current) fit(); }, [nodes.length]);

  return (
    <Card className="mb-5" data-testid="run-diagram">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs">
        <span className="font-semibold uppercase text-slate-500">Progress</span>
        <span className="text-slate-500">Click a step to open it. Drag to move the diagram; double-click, pinch or the zoom controls to zoom.</span>
        <span className="ml-auto flex flex-wrap items-center gap-x-3 text-slate-600">
          {/* The run keeps the version it started with, so this opens the workflow as it is now — it does not
              change what runs already happened. Editing here would rewrite a record, which no run may do. */}
          <a data-testid="diagram-edit" href={`#/designer/${encodeURIComponent(workflow)}`}
            className="font-medium text-primary underline" title={`Open ${workflow} in the designer. This run keeps the version it started with`}>
            Edit workflow
          </a>
          <span data-testid="diagram-legend" className="flex flex-wrap gap-x-3">
            {(["pending", "running", "waiting_gate", "completed", "failed"] as StepStatus[]).map((s) => <span key={s}><span className={`mr-1 inline-block h-2.5 w-2.5 rounded-sm border ${STYLE[s].split(" ").slice(0, 2).join(" ")}`} />{LABEL[s]}</span>)}
          </span>
        </span>
      </div>
      <div ref={box} className="h-72 border-t border-slate-100" data-testid="run-diagram-canvas">
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1, minZoom: 0.1 }} minZoom={0.1}
            colorMode={theme}
            onNodesChange={onNodesChange}
            onInit={(inst) => { flow.current = inst; }}
            // A move the person made ends the auto-fit: their view is not re-fitted under their hands. A move
            // React Flow makes itself (a fit, an initial placement) arrives with no event, so it is not one.
            onMoveStart={(event) => { if (event) moved.current = true; }}
            nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
            // The wheel is left to the page: this diagram sits in a page that scrolls, and trapping the wheel in a
            // 288 px box makes the page below it unreachable. Pinch (ctrl+wheel), double-click and the zoom
            // controls zoom; dragging pans. Wheel-zoom and page-scroll cannot both own the wheel, and the page
            // wins — `preventScrolling={false}` alone is not enough while `zoomOnScroll` is on, because the zoom
            // handler calls preventDefault first (E9.57-1 caught that).
            panOnDrag zoomOnScroll={false} zoomOnPinch zoomOnDoubleClick preventScrolling={false}
            onNodeClick={(_e, n) => onOpen(n.id)} proOptions={{ hideAttribution: true }}>
            <Background />
            <Controls showFitView={false}>
              <ControlButton data-testid="diagram-fit" title="Fit the whole workflow in the diagram" aria-label="Fit the whole workflow in the diagram" onClick={recenter}>
                {/* The same arrows-out-of-a-frame as the designer's canvas: one control, one meaning. */}
                <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
                  <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  <rect x="5.5" y="5.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
                </svg>
              </ControlButton>
            </Controls>
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </Card>
  );
}

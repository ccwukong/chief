import {
  addEdge, Background, ControlButton, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { AGENT_NAME, api, get } from "../api";
import { SHOW_BUDGETS } from "../features";
import { useAppTheme } from "../theme";
import { autoLayout, cleanNode, newNode, placeNodes, type NodeDef } from "../designer/model";
import { designerBridge } from "../designer/bridge";
import { NodePanel } from "../designer/panel";
import { AsyncButton, COMPACT_BELOW, ErrorBox, go, Help, Modal, readDraft, removeDraft, TrashButton, useDraft, useWindowWidth, writeDraft } from "../ui";
import { JsonEditor } from "../json-editor";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";

const DefsContext = createContext<Record<string, NodeDef>>({});
/** Keys of the nodes nothing points to: they run first. */
const EntryContext = createContext<Set<string>>(new Set());
/** Every connection is drawn as an arrow from the node that runs first to the node that runs after it. */
const EDGE_COLOR = "#334155";
const EDGE_SELECTED_COLOR = "#2563eb";
// interactionWidth: the invisible band around the line that reacts to a click, so a thin arrow is easy to hit.
const EDGE_OPTIONS = { markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20, color: EDGE_COLOR }, style: { strokeWidth: 2, stroke: EDGE_COLOR }, interactionWidth: 28 };
const EDGE_SELECTED = { markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: EDGE_SELECTED_COLOR }, style: { strokeWidth: 4, stroke: EDGE_SELECTED_COLOR }, zIndex: 10 };
const NEW = "\u0000new";
const draftKey = (name: string | null) => `designer:${name ?? "__new__"}`;
const DND = "application/chief-node";
const TYPE_COLOR: Record<string, string> = { agent: "border-primary", script: "border-emerald-500", gate: "border-amber-500", map: "border-purple-500" };

/**
 * A drawn chevron for the two column handles. The `«` and `»` characters were *text*: at 14 px they rendered small, thin,
 * and at a different weight from every other icon in chief, so the box around a single character looked oversized and the
 * glyph inside it undersized at the same time (reported 2026-11-22: "make this slightly bigger"). A 16 px drawing at a
 * 1.8 stroke weight is the same weight as the panel strip's own chevron.
 */
function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className={`h-4 w-4 shrink-0 ${dir === "right" ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.5 2L3.5 6l4 4" />
    </svg>
  );
}

/** Canvas node. The React Flow id is an internal key; the workflow node id is editable. */
function FlowNode({ id, selected }: NodeProps) {
  const def = useContext(DefsContext)[id];
  const entry = useContext(EntryContext).has(id);
  if (!def) return null;
  const inner = def.type === "map" ? def.node : def;
  const detail = def.type === "gate" ? def.kind
    : def.type === "map" ? `map → ${inner?.type ?? "agent"}`
    : inner?.type === "script" ? inner.run || "script"
    : !Array.isArray(inner?.mcp) ? "all MCP servers" : inner.mcp.join(", ") || "no MCP";
  // A step that chose its own agent CLI says so on the canvas: in a workflow that mixes them (personal
  // and work, a cheaper CLI for one step) the diagram is where that has to be visible (task 15.11).
  const ownAgent = inner?.type === "agent" || inner?.type === "script" ? inner?.agent : undefined;
  return (
    <div data-testid={`flow-node-${def.id}`} data-node-type={def.type} className={`w-52 rounded border-2 bg-surface px-3 py-2 shadow-sm ${TYPE_COLOR[def.type]} ${selected ? "ring-2 ring-ring" : ""}`}>
      <Handle type="target" position={Position.Top} />
      {entry && <span data-testid={`runs-first-${def.id}`} title="Nothing points to this node, so it runs first" className="absolute -top-2.5 right-2 rounded bg-slate-200 px-1.5 text-2xs font-semibold uppercase tracking-wide text-slate-800">runs first</span>}
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-2xs font-semibold uppercase tracking-wide text-slate-500">{def.type}</span>
        {ownAgent && <span data-testid={`flow-agent-${def.id}`} title={`This step runs on ${ownAgent}, not on the workflow's own agent CLI`} className="truncate rounded bg-primary/10 px-1 text-2xs font-semibold text-primary">{ownAgent}</span>}
      </div>
      <div className="truncate text-sm font-semibold">{def.id || "(no id)"}</div>
      <div className="truncate text-xs text-slate-600">{detail}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
const nodeTypes = { chief: FlowNode };

type Phase = "empty" | "saving" | "saved" | "blocked";

interface Validation { ok: boolean; errors: string[]; warnings: string[]; environment: string[]; estimates: { node_id: string; chars: number; est_tokens: number }[] }

function DesignerInner({ name }: { name: string | null }) {
  const flow = useReactFlow();
  // React Flow draws its dots and its controls itself, so it is told the theme by name.
  const theme = useAppTheme();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [defs, setDefs] = useState<Record<string, NodeDef>>({});
  const [wf, setWf] = useState({ name: "", description: "", warn: "", max: "", baseDir: "", agent: "", inputs: {} as Record<string, unknown> });
  /** Text of the workflow inputs field; `wf.inputs` follows it whenever it is a valid JSON object. */
  const [inputsText, setInputsText] = useState("{}");
  const [selected, setSelected] = useState<string | null>(null);
  const [meta, setMeta] = useState<any>(null);
  const [servers, setServers] = useState<any[]>([]);
  /** True once the agent CLI's servers are in the palette (entries below them no longer move). */
  const [paletteReady, setPaletteReady] = useState(false);
  const [workflows, setWorkflows] = useState<any[]>([]);
  /** Out of service: still here, still replayable, not offered for a run, and never fired by a schedule (task 15.2). */
  const [archived, setArchived] = useState<any[]>([]);
  /** The open workflow: whether it is archived, and how many runs it has (which is what Delete needs to know). */
  const [isArchived, setIsArchived] = useState(false);
  const [runCount, setRunCount] = useState(0);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /**
   * There is no Save button. Every change is stored at once (as the working copy) and the
   * workflow itself is updated a moment later, as soon as the canvas is a valid workflow.
   *   empty   nothing to save yet
   *   saving  being checked and written
   *   saved   the workflow in the database is exactly what is on the canvas
   *   blocked the canvas is not a valid workflow yet; the last valid version stays in place
   */
  const [phase, setPhaseState] = useState<Phase>("empty");
  const phaseRef = useRef<Phase>("empty");
  const setPhase = (p: Phase) => { phaseRef.current = p; setPhaseState(p); };
  /** True while the canvas differs from the stored workflow (a save is pending, running, or blocked). */
  const [dirty, setDirty] = useState(false);
  const [version, setVersion] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  /** Script nodes that widen the sandbox and whether the user approved them. */
  const [approvals, setApprovals] = useState<{ node_id: string; script: string; widening: string; approved: boolean; missing: boolean }[]>([]);
  const snapRef = useRef("");
  const lastAttempt = useRef<string | null>(null);
  const publishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const publishing = useRef(false);
  const again = useRef(false);
  /** The check result of the stored workflow, shown again whenever the canvas is back at that state. */
  const storedValidation = useRef<Validation | null>(null);
  const savedNameRef = useRef<string | null>(null);
  const markSaved = (n: string | null) => { savedNameRef.current = n; setSavedName(n); };
  const nameRef = useRef(name);
  nameRef.current = name;
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText, clearImportText] = useDraft("designer:import-text", "");
  /** Width of the side panel on wide windows, set with the handle on its left edge; kept across reloads. */
  const [savedPanelWidth, setPanelWidth] = useDraft("ui:designer-panel-width", window.innerWidth < COMPACT_BELOW ? PANEL_MIN : PANEL_DEFAULT);
  /** The width while the handle is being dragged; stored once, when it is let go. */
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const panelWidth = dragWidth ?? savedPanelWidth;
  const startResize = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startW = savedPanelWidth;
    let last = startW;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => { last = clampPanel(startW + (startX - ev.clientX)); setDragWidth(last); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setPanelWidth(last);
      setDragWidth(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  useEffect(() => {
    // A narrower window must not leave the panel wider than its limit.
    const fit = () => setPanelWidth((w) => clampPanel(w));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  /** Unsaved edits are kept as a draft per workflow and put back after a refresh. */
  const [loadTick, setLoadTick] = useState(0);
  const baseline = useRef<string | null>(null);
  const lastWritten = useRef<string | null>(null);
  const rebase = useRef(false);
  const pendingDraft = useRef<any>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [exported, setExported] = useState<string | null>(null);
  const keySeq = useRef(0);
  const loadedName = useRef<string | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  const scriptsEnabled = meta ? !!meta.sandbox?.available : true;
  // Every server of every agent CLI, per agent; the ones it is connected to (or has configured) come first.
  const usable = (st: unknown) => st === "connected" || st === "configured";
  const serversByAgent = useMemo(() => {
    const out: Record<string, { name: string; status: string }[]> = {};
    for (const s of servers) (out[s.adapter] ??= []).push({ name: String(s.name), status: String(s.config?.status ?? "unknown") });
    for (const list of Object.values(out)) list.sort((a, b) => Number(usable(b.status)) - Number(usable(a.status)) || a.name.localeCompare(b.name));
    return out;
  }, [servers]);
  const namesByAgent = useMemo(() => Object.fromEntries(Object.entries(serversByAgent).map(([a, l]) => [a, l.map((x) => x.name)])), [serversByAgent]);
  /** Every agent CLI with whether it may be used and whether it is installed, from `/api/meta`. */
  const providerState = useMemo<Record<string, { name: string; enabled: boolean; found: boolean }>>(
    () => Object.fromEntries(((meta?.providers ?? []) as { name: string; enabled: boolean; found: boolean }[]).map((p) => [p.name, p])),
    [meta],
  );
  // The status list names every CLI chief knows (so "not installed" and "switched off" are visible); the
  // pickers use `meta.adapters`, which holds only the ones switched on (task 15.14).
  const agentOrder: string[] = (meta?.providers ?? []).map((p: { name: string }) => p.name).length ? (meta.providers as { name: string }[]).map((p) => p.name) : (meta?.adapters ?? Object.keys(serversByAgent));
  const totalServers = servers.length;
  // Two calls, not one filtered in the browser: the server decides what "live" means, and the archived group is the only
  // way back from archiving, so it has to be somewhere a person will look (task 15.2).
  const refreshList = () => Promise.all([get("/api/workflows"), get("/api/workflows?archived=1").catch(() => [])])
    .then(([live, gone]) => { setWorkflows(live); setArchived(gone); }).catch(() => {});

  useEffect(() => {
    get("/api/meta").then(setMeta).catch((e) => setError(e.message));
    refreshList();
  }, []);

  // The MCP servers of the folder this workflow's steps run in: an agent CLI has different servers
  // in different folders (Claude Code's local scope, .mcp.json). Read again when the folder changes.
  const [mcpFolder, setMcpFolder] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      const q = new URLSearchParams();
      if (wf.baseDir.trim()) q.set("base_dir", wf.baseDir.trim()); else if (wf.name.trim()) q.set("name", wf.name.trim());
      fetch(`/api/mcp?${q}`).then(async (res) => {
        if (!live || !res.ok) return;
        setServers(await res.json());
        setMcpFolder(res.headers.get("X-Mcp-Folder"));
      }).catch(() => {}).finally(() => live && setPaletteReady(true));
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [wf.baseDir, wf.name]);

  /** Put a definition on the canvas. */
  const loadDefinition = useCallback((d: any, baseDir: string | null, keepBaseline = false) => {
    // What is loaded becomes the "saved" state that later edits are compared with, unless it is itself unsaved work.
    if (!keepBaseline) rebase.current = true;
    setLoadTick((t) => t + 1);
    const pos = autoLayout(d.nodes ?? [], d.edges ?? []);
    const keyOf: Record<string, string> = {};
    const nextDefs: Record<string, NodeDef> = {};
    const nextNodes: Node[] = (d.nodes ?? []).map((n: any) => {
      const key = `k${++keySeq.current}`;
      keyOf[n.id] = key;
      const { position: _p, ...rest } = n;
      nextDefs[key] = rest;
      return { id: key, type: "chief", position: pos[n.id], data: {} };
    });
    setDefs(nextDefs);
    setNodes(nextNodes);
    setEdges((d.edges ?? []).filter((e: any) => keyOf[e.from] && keyOf[e.to]).map((e: any) => ({ id: `${keyOf[e.from]}-${keyOf[e.to]}`, source: keyOf[e.from], target: keyOf[e.to] })));
    setWf({ name: d.name ?? "", description: d.description ?? "", warn: String(d.budget?.["warn-usd"] ?? ""), max: String(d.budget?.["max-usd"] ?? ""), baseDir: baseDir ?? "", agent: d.agent ?? "", inputs: d.inputs ?? {} });
    setInputsText(Object.keys(d.inputs ?? {}).length ? JSON.stringify(d.inputs, null, 2) : "{}");
    setSelected(null);
    setValidation(null);
  }, [setNodes, setEdges]);

  useEffect(() => {
    const draft = readDraft(draftKey(name));
    if (!name) {
      if (loadedName.current !== NEW) {
        loadedName.current = NEW; markSaved(null); setVersion(null); setApprovals([]);
        pendingDraft.current = draft;
        loadDefinition({ nodes: [], edges: [] }, null);
      }
      return;
    }
    if (name === loadedName.current) return;
    loadedName.current = name;
    get(`/api/workflows/${encodeURIComponent(name)}`).then((w) => {
      pendingDraft.current = draft;
      markSaved(w.name);
      setVersion(w.version);
      setApprovals(w.approvals ?? []);
      setIsArchived(!!w.archived);
      setRunCount(w.runs ?? 0);
      loadDefinition(w.definition, w.base_dir);
    }).catch((e) => setError(e.message));
  }, [name, loadDefinition]);

  // Wide windows have the app's top row (the notification bell); the designer's bar goes into it.
  const [topRow, setTopRow] = useState<HTMLElement | null>(null);
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  useEffect(() => {
    setTopRow(document.getElementById("page-bar"));
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const inTopRow = wide && !!topRow;

  /** The "New workflow" panel (slides in from the right). What is typed in it is kept as a draft. */
  const [creating, setCreating] = useState(false);
  const blankForm = { name: "", baseDir: "", agent: "", warn: "", max: "" };
  const [form, setForm, clearForm] = useDraft("new-workflow:form", blankForm);
  const formName = form.name.trim();
  const formProblem = !formName ? "Give the workflow a name." : !/^[a-z0-9][a-z0-9-]*$/.test(formName) ? "Use lower-case letters, digits and dashes, for example daily-triage." : workflows.some((w) => w.name === formName) ? `A workflow named "${formName}" already exists.` : null;
  useEffect(() => {
    if (!creating) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCreating(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating]);
  /** Open an empty canvas with what was entered. It is saved as a workflow as soon as it has its first step. */
  const createFromForm = () => {
    if (formProblem) return;
    const f = form;
    startNew();
    setWf((cur) => ({ ...cur, name: f.name.trim(), baseDir: f.baseDir.trim(), agent: f.agent, warn: f.warn, max: f.max }));
    setInputsText("{}");
    clearForm();
    setCreating(false);
    setNote(`New workflow "${f.name.trim()}": drag a building block onto the canvas. It is saved as soon as it has its first step.`);
  };

  /** Copy the open workflow (its last valid version) and open the copy, which is renamed by typing a name. */
  const cloneThis = async () => {
    if (!savedName) return;
    setError(null);
    try {
      const r = await api("POST", `/api/workflows/${encodeURIComponent(savedName)}/clone`, {});
      refreshList();
      setNote(`Cloned "${r.from}" as "${r.name}". Type a new name in the Name field to rename it.${dirty ? ` The copy is "${r.from}" as last saved: changes that were not a valid workflow yet are not in it.` : ""}${(r.approvals ?? []).some((a: any) => !a.approved) ? " Scripts that widen the sandbox need approving again for the copy." : ""}`);
      go(`/designer/${encodeURIComponent(r.name)}`);
    } catch (e: any) { setError(e.message); }
  };

  /**
   * Take the open workflow out of service, or put it back (task 15.2).
   *
   * Nothing is deleted: the runs stay, replay stays, and its schedules keep their own on/off — which is why unarchiving
   * needs no question about what to switch back on. What changes is that it leaves every list, and its schedules stop
   * firing. The list is refreshed so the picker's Archived group is right immediately.
   */
  const toggleArchive = async () => {
    if (!savedName) return;
    setError(null);
    const wasArchived = isArchived;
    try {
      await api("POST", `/api/workflows/${encodeURIComponent(savedName)}/${wasArchived ? "unarchive" : "archive"}`);
      setIsArchived(!wasArchived);
      setNote(wasArchived ? `"${savedName}" is in service again.` : `"${savedName}" is archived: it is out of every list, and its schedules have stopped. Its runs are kept — you can reopen it from the Archived group in the picker above.`);
      refreshList();
      // The route stays: closing the panel would throw away what the person was looking at, and unarchiving is one click.
    } catch (e: any) { setError(e.message); }
  };

  /** Remove the open workflow for good. Only offered when it has no runs; the server refuses the rest. */
  const deleteThis = async () => {
    if (!savedName) return;
    setError(null);
    try {
      await api("DELETE", `/api/workflows/${encodeURIComponent(savedName)}`);
      removeDraft(draftKey(savedName));
      setNote(`"${savedName}" was removed.`);
      refreshList();
      go("/runs");
    } catch (e: any) { setError(e.message); }
  };

  /** The delete confirmation. A Modal, because a record can be removed for good and that is worth one question. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /**
   * Empty the canvas. Done here and not only on a route change: after an import the URL is
   * already /designer, so navigating to it again would change nothing.
   */
  const startNew = () => {
    removeDraft(draftKey(null));
    loadedName.current = NEW;
    markSaved(null);
    setVersion(null);
    setApprovals([]);
    setExported(null);
    setNote(null);
    setError(null);
    loadDefinition({ nodes: [], edges: [] }, null);
    go("/designer");
  };

  /** The definition as it will be saved. */
  const build = useCallback(() => {
    const idOf = (key: string) => defs[key]?.id;
    const budget: Record<string, number> = {};
    if (wf.warn.trim() && Number.isFinite(Number(wf.warn))) budget["warn-usd"] = Number(wf.warn);
    if (wf.max.trim() && Number.isFinite(Number(wf.max))) budget["max-usd"] = Number(wf.max);
    return {
      name: wf.name.trim(),
      ...(wf.description.trim() ? { description: wf.description.trim() } : {}),
      ...(wf.agent ? { agent: wf.agent } : {}),
      ...(Object.keys(budget).length ? { budget } : {}),
      ...(Object.keys(wf.inputs).length ? { inputs: wf.inputs } : {}),
      nodes: nodes.filter((n) => defs[n.id]).map((n) => ({ ...cleanNode(defs[n.id]), position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
      edges: edges.filter((e) => idOf(e.source) && idOf(e.target)).map((e) => ({ from: idOf(e.source), to: idOf(e.target) })),
    };
  }, [defs, nodes, edges, wf]);

  /**
   * Turn the canvas into the stored workflow. Called a moment after every change. A canvas that
   * is not a valid workflow yet is left as the working copy and the reasons are shown.
   */
  const publish = async () => {
    if (publishing.current) { again.current = true; return; }
    const snap = snapRef.current;
    if (!snap || snap === baseline.current) return;
    lastAttempt.current = snap;
    const { definition, baseDir } = JSON.parse(snap) as { definition: any; baseDir: string };
    if (!definition.nodes.length && !savedNameRef.current) { setValidation(null); setPhase("empty"); return; }
    if (!definition.name) {
      setValidation({ ok: false, errors: ["Give the workflow a name: type one in the Name field at the top of this page (lower-case letters, digits and dashes, for example daily-triage)."], warnings: [], environment: [], estimates: [] });
      setPhase("blocked");
      return;
    }
    publishing.current = true;
    setPhase("saving");
    setError(null);
    try {
      const base_dir = baseDir.trim() || undefined;
      const v: Validation = await api("POST", "/api/workflows/validate", { definition, base_dir });
      setValidation(v);
      if (!v.ok) { setPhase("blocked"); return; }
      storedValidation.current = v;
      // Typing a new name renames the workflow; it does not create a second one.
      const rename_from = savedNameRef.current && savedNameRef.current !== definition.name ? savedNameRef.current : undefined;
      const r = await api("PUT", `/api/workflows/${encodeURIComponent(definition.name)}`, { definition, base_dir, autosave: true, rename_from });
      baseline.current = snap;
      loadedName.current = r.name;
      markSaved(r.name);
      setVersion(r.version);
      setApprovals(r.approvals ?? []);
      setSavedAt(new Date());
        const oldKey = draftKey(nameRef.current), newKey = draftKey(r.name);
      if (snapRef.current === snap) {
        removeDraft(oldKey); removeDraft(newKey);
        lastWritten.current = null;
        setDirty(false);
        setPhase("saved");
      } else if (oldKey !== newKey) {
        // Edited again while saving, and renamed: the working copy follows the new name.
        writeDraft(newKey, JSON.parse(snapRef.current));
        removeDraft(oldKey);
      }
      refreshList();
      if (nameRef.current !== r.name) go(`/designer/${encodeURIComponent(r.name)}`);
    } catch (e: any) {
      setError(e.message);
      setPhase("blocked");
    } finally {
      publishing.current = false;
      if (again.current || (snapRef.current !== baseline.current && snapRef.current !== lastAttempt.current)) { again.current = false; void publish(); }
    }
  };

  // Autosave. Every change (a drop, a move, a connection, a deletion, anything in the panel or
  // the header) is written to the database right away as the working copy, and published as the
  // workflow shortly after. Renders that change nothing (a selection) do neither.
  useEffect(() => {
    const snapshot = JSON.stringify({ definition: build(), baseDir: wf.baseDir, inputsText });
    snapRef.current = snapshot;
    if (rebase.current) {
      rebase.current = false;
      baseline.current = snapshot;
      lastWritten.current = null;
      lastAttempt.current = null;
      storedValidation.current = null;
      setDirty(false);
      setPhase(savedNameRef.current ? "saved" : "empty");
      // Show what the stored workflow's check says (warnings, problems on this machine, prompt sizes) without waiting for an edit.
      if (savedNameRef.current) {
        const { definition, baseDir } = JSON.parse(snapshot);
        api("POST", "/api/workflows/validate", { definition, base_dir: baseDir.trim() || undefined })
          .then((v: Validation) => { if (baseline.current === snapshot) { storedValidation.current = v; if (snapRef.current === snapshot) setValidation(v); } })
          .catch(() => {});
      }
      const d = pendingDraft.current;
      pendingDraft.current = null;
      if (d?.definition && JSON.stringify(d) !== snapshot) {
        loadDefinition(d.definition, d.baseDir || null, true);
        if (typeof d.inputsText === "string") setInputsText(d.inputsText);
        lastWritten.current = JSON.stringify(d);
      }
      return;
    }
    if (baseline.current === null) return;
    if (snapshot === baseline.current) {
      if (lastWritten.current !== null) { removeDraft(draftKey(name)); lastWritten.current = null; }
      clearTimeout(publishTimer.current);
      setDirty(false);
      if (!publishing.current) { setValidation(storedValidation.current); setPhase(savedNameRef.current ? "saved" : "empty"); }
      return;
    }
    setDirty(true);
    if (snapshot !== lastWritten.current) {
      writeDraft(draftKey(name), JSON.parse(snapshot));
      lastWritten.current = snapshot;
    }
    if (snapshot !== lastAttempt.current) {
      clearTimeout(publishTimer.current);
      publishTimer.current = setTimeout(() => void publish(), 400);
    }
  }, [defs, nodes, edges, wf, inputsText, loadTick]);
  useEffect(() => () => clearTimeout(publishTimer.current), []);

  // The assistant (task 9.65) reads the canvas and puts a changed workflow on it through this.
  // What it puts there is unsaved work like any edit: the autosave above stores and publishes it.
  const bridge = useRef({ build, baseDir: wf.baseDir });
  bridge.current = { build, baseDir: wf.baseDir };
  useEffect(() => {
    designerBridge.set({
      snapshot: () => ({ definition: bridge.current.build(), baseDir: bridge.current.baseDir }),
      apply: (d, text) => {
        const now = bridge.current.build();
        const onCanvas = Object.fromEntries(now.nodes.map((n: any) => [n.id, n.position]));
        const edges = (d.edges ?? []).map((e: any) => (typeof e === "string" ? { from: e.split("->")[0].trim(), to: e.split("->")[1].trim() } : e));
        loadDefinition({ ...d, edges, nodes: placeNodes(d.nodes ?? [], edges, onCanvas) }, bridge.current.baseDir || null, true);
        setError(null);
        setNote(text);
        setTimeout(() => flow.fitView({ padding: 0.2, maxZoom: 1 }), 50);
      },
    });
    return () => designerBridge.set(null);
  }, [loadDefinition, flow]);

  const entries = useMemo(() => {
    const targets = new Set(edges.map((e) => e.target));
    return new Set(nodes.map((n) => n.id).filter((k) => !targets.has(k)));
  }, [nodes, edges]);

  const addNode = useCallback((kind: string, server: string | null, position: { x: number; y: number }) => {
    if (kind === "script" && !scriptsEnabled) return;
    const key = `k${++keySeq.current}`;
    setDefs((cur) => ({ ...cur, [key]: newNode(kind, server, new Set(Object.values(cur).map((d) => d.id))) }));
    setNodes((cur) => [...cur.map((n) => ({ ...n, selected: false })), { id: key, type: "chief", position, data: {}, selected: true }]);
    setSelected(key);
  }, [scriptsEnabled, setNodes]);

  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  /** The side panel's tab: the workflow's settings, or the selected step (or connection). It follows the selection. */
  const [tab, setTab] = useState<"workflow" | "step">("workflow");
  useEffect(() => { setTab(selected || selectedEdge ? "step" : "workflow"); }, [selected, selectedEdge]);

  // ── room for the canvas on a narrower window (a laptop) ─────────────────────
  // Side by side (1024 px and up) but narrower than COMPACT_BELOW: the blocks are a slim rail and the
  // side panel is shown when there is something in it to look at (a selected step or connection, a
  // problem), and hidden otherwise. Both can be opened and closed by hand, and that choice is kept
  // per kind of window, so a large monitor and a laptop each keep their own.
  const winWidth = useWindowWidth();
  const sideBySide = winWidth >= 1024;
  const compact = sideBySide && winWidth < COMPACT_BELOW;
  const [panelPins, setPanelPins] = useDraft<{ compact?: boolean; wide?: boolean }>("ui:designer-panel-open", {});
  const [railPins, setRailPins] = useDraft<{ compact?: boolean; wide?: boolean }>("ui:designer-blocks-open", {});
  const kindOfWindow = compact ? "compact" : "wide";
  /** Whether the panel stays open with nothing selected. */
  const panelStays = panelPins[kindOfWindow] ?? !compact;
  const [panelOpen, setPanelOpen] = useState(panelStays);
  useEffect(() => { setPanelOpen(panelStays || !!selected || !!selectedEdge); }, [panelStays, selected, selectedEdge]);
  const togglePanel = () => { const next = !panelOpen; setPanelOpen(next); setPanelPins((cur) => ({ ...cur, [kindOfWindow]: next })); };
  const panelShown = !sideBySide || panelOpen;
  /** The blocks column in full (with the server list), or as a rail of the four blocks. */
  const railFull = !sideBySide || (railPins[kindOfWindow] ?? !compact);
  const toggleRail = () => setRailPins((cur) => ({ ...cur, [kindOfWindow]: !railFull }));
  const onSelectionChange = useCallback(({ nodes: picked, edges: pickedEdges }: { nodes: Node[]; edges: Edge[] }) => {
    setSelected(picked.length === 1 ? picked[0].id : null);
    setSelectedEdge(picked.length === 0 && pickedEdges.length === 1 ? pickedEdges[0].id : null);
  }, []);
  /** The selected connection is drawn thicker and in another colour, arrowhead included, so it is obvious what a click selected. */
  const shownEdges = useMemo(() => edges.map((e) => (e.selected ? { ...e, ...EDGE_SELECTED } : e)), [edges]);
  const pickedEdge = selectedEdge ? edges.find((e) => e.id === selectedEdge) ?? null : null;

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData(DND);
    if (!raw) return;
    const { kind, server } = JSON.parse(raw);
    addNode(kind, server, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const removeNode = (key: string) => {
    setNodes((cur) => cur.filter((n) => n.id !== key));
    setEdges((cur) => cur.filter((e) => e.source !== key && e.target !== key));
    setDefs((cur) => { const { [key]: _gone, ...rest } = cur; return rest; });
    setSelected(null);
  };

  // A problem is shown in the panel, so the panel opens for it.
  useEffect(() => { if (phase === "blocked" || error) setPanelOpen(true); }, [phase, error]);

  /** Finish saving what is on the canvas; a canvas that is not a valid workflow cannot run. Returns the saved workflow's name. */
  const readyToRun = async (): Promise<string | null> => {
    clearTimeout(publishTimer.current);
    const idle = async () => { while (publishing.current) await new Promise((r) => setTimeout(r, 40)); };
    await idle();
    await publish();
    await idle();
    if (!savedNameRef.current || snapRef.current !== baseline.current) { setError("This workflow cannot run yet. Fix what is listed below; your changes are kept."); return null; }
    return savedNameRef.current;
  };
  /** Run: at once, with the inputs set in the Workflow tab. They are changed there before pressing Run; there is no dialog in between. */
  const run = async () => {
    const name = await readyToRun();
    if (!name) return;
    try { const d = await api("POST", "/api/runs", { workflow: name, inputs: {} }); go(`/runs/${d.run.id}`); }
    catch (e: any) { setError(e.message); setTab("workflow"); }
  };

  /** Approving wider sandbox permissions is a security decision, so it stays an explicit action. */
  const approveSandbox = async () => {
    if (!savedName) return;
    try { setApprovals(await api("POST", `/api/workflows/${encodeURIComponent(savedName)}/approve`)); setError(null); }
    catch (e: any) { setError(e.message); }
  };
  const unapproved = approvals.filter((a) => !a.approved);

  const doImport = async () => {
    setImportErrors([]);
    try {
      const v = await api("POST", "/api/workflows/validate", { yaml: importText });
      if (!v.ok || !v.definition) return setImportErrors(v.errors?.length ? v.errors : ["The file is not a valid workflow."]);
      loadedName.current = v.definition.name;
      // An import with the name of an existing workflow updates that workflow; any other name is a new one.
      markSaved(workflows.some((w) => w.name === v.definition.name) ? v.definition.name : null);
      // An import is unsaved work: it is kept as a draft until it is saved.
      loadDefinition(v.definition, null, true);
      setImportOpen(false); clearImportText();
      setNote(`Imported "${v.definition.name}" onto the canvas.`);
      setTimeout(() => flow.fitView({ padding: 0.2 }), 50);
    } catch (e: any) { setImportErrors([e.message]); }
  };

  const doExport = async () => {
    if (!savedName) return;
    try { setExported(await api("GET", `/api/workflows/${encodeURIComponent(savedName)}/export`)); } catch (e: any) { setError(e.message); }
  };

  const drag = (kind: string, server: string | null) => (e: React.DragEvent) => { e.dataTransfer.setData(DND, JSON.stringify({ kind, server })); e.dataTransfer.effectAllowed = "copy"; };
  const dropPoint = () => ({ x: 80 + (nodes.length % 4) * 240, y: 60 + Math.floor(nodes.length / 4) * 130 });
  const paletteItem = (testid: string, label: string, kind: string, server: string | null, sub?: string) => (
    <div key={testid} data-testid={testid} draggable onDragStart={drag(kind, server)} onDoubleClick={() => addNode(kind, server, dropPoint())}
      title={railFull ? `Drag onto the canvas (or double-click): ${sub ?? label}` : `${label}: ${sub}. Drag onto the canvas (or double-click)`}
      className={`mb-1 cursor-grab rounded border border-slate-300 bg-surface text-sm hover:border-slate-400 ${railFull ? "px-2 py-1.5" : "px-1 py-1.5 text-center"}`}>
      {/* No "?" here: the four kinds share one, on the column's heading (see the "Building blocks" label). */}
      <div className={railFull ? "font-medium" : "text-xs font-medium"}>{label}</div>
      {sub && railFull && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
  const sel = selected ? defs[selected] : null;
  /** Bring the whole workflow back into view, from wherever the canvas was panned or zoomed to. */
  const fitAll = () => { void flow.fitView({ padding: 0.3, maxZoom: 1, minZoom: 0.1 }); };
  const selAgent = sel?.type === "map" ? (sel.node?.type === "agent" ? sel.node : null) : sel?.type === "agent" ? sel : null;
  /** The servers the selected node may use, to mark them in the server list. */
  // An agent node without a list may use every connected server.
  const selUsesAll = !!selAgent && !Array.isArray(selAgent.mcp);
  const usedBySelected = new Set<string>((selAgent?.mcp as string[] | undefined) ?? []);
  /** The agent CLI that runs the selected node: only its servers can be "used" by that node. */
  const workflowAgent = wf.agent || meta?.default_adapter || "claude-code";
  const selAgentCli = selAgent ? (selAgent.agent as string | undefined) ?? workflowAgent : null;
  const DOT: Record<string, string> = { connected: "bg-green-500", configured: "bg-green-500", "needs-auth": "bg-slate-300", failed: "bg-red-500", disabled: "bg-slate-300", pending: "bg-amber-400" };
  // Which server groups the person has folded, by agent CLI. React owns it rather than the DOM: with
  // `open` as a fixed prop, a group the person closed was re-opened by the next re-render (the list
  // refreshes as the CLIs are looked for), which is a fold that undoes itself.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const mcpRow = (agent: string) => (r: { name: string; status: string }) => {
    const used = agent === selAgentCli && ((selUsesAll && usable(r.status)) || usedBySelected.has(r.name) || [...usedBySelected].some((u) => r.name.startsWith(u + "-")));
    return (
      <li key={`${agent}/${r.name}`} data-testid={`palette-mcp-${r.name}`} data-agent={agent} data-status={r.status} data-used={used} draggable={false}
        title={`${r.name} (${AGENT_NAME[agent] ?? agent}): ${r.status.replace("-", " ")}${used ? " · the selected node may use it" : ""}`}
        className={`flex cursor-default select-none items-center gap-1.5 py-0.5 ${usable(r.status) ? "text-slate-700" : "text-slate-400"} ${used ? "font-semibold" : ""}`}>
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[r.status] ?? "bg-slate-300"}`} />
        <span className="truncate">{r.name}</span>
        {used && <span className="ml-auto text-primary" aria-label="used by the selected node">✓</span>}
        {!usable(r.status) && !used && <span className="ml-auto shrink-0 text-2xs">{r.status.replace("-", " ")}</span>}
      </li>
    );
  };

  return (
    <div className="flex min-h-full flex-col lg:h-full">
      {/* The bar: which workflow is open (existing ones only), and making a new one or a copy. On wide
          windows it sits in the app's top row, next to the notification bell; on narrow ones, here. */}
      {(() => {
        const bar = (
      <div data-testid="designer-bar" className={inTopRow ? "flex min-w-0 flex-1 items-center gap-2" : "flex flex-wrap items-center gap-2 border-b border-slate-200 bg-surface px-4 py-2"}>
        <label className="flex w-full items-center gap-2 sm:w-auto">
          <span className="label mb-0 shrink-0">Workflow</span>
          <Select className="sm:w-72" data-testid="wf-picker"  value={savedName ?? ""} onChange={(e) => { if (e.target.value) go(`/designer/${encodeURIComponent(e.target.value)}`); }}>
            {!savedName && <option value="" disabled>{wf.name.trim() ? `${wf.name.trim()} (new, not saved yet)` : workflows.length ? "Choose a workflow…" : "No workflows yet"}</option>}
            {workflows.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
            {/* The way back: archived workflows are in no other list, so the picker keeps a group for them. */}
            {archived.length > 0 && (
              <optgroup label="Archived" data-testid="wf-picker-archived">
                {archived.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
              </optgroup>
            )}
          </Select>
        </label>
        {/* Next to the picker, not lost among the row's other buttons: "which workflow am I in" and "start a
            new one" are the same question, and the button used to sit fourth in a row of five with nothing
            to mark it as the way in (reported 2026-11-21). Outlined here, filled in the bar, and the only
            one with a plus. */}
        <Button variant="outline" className="shrink-0 border-border font-medium text-primary hover:border-ring hover:bg-accent" data-testid="btn-new"  onClick={() => setCreating(true)} aria-haspopup="dialog" aria-expanded={creating} title="Start a new workflow on an empty canvas">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          New workflow
        </Button>
        {/* The state of the autosave in a word, here too, because the panel that has it in full may be closed. */}
        {phase !== "empty" && (
          <Button variant="ghost" type="button" data-testid="designer-status" data-state={phase} onClick={() => setPanelOpen(true)} title={phase === "blocked" ? "This is not a runnable workflow yet: show what is missing" : "Saved automatically"}
            className={`hidden shrink-0 rounded px-2 py-1 text-xs sm:block ${phase === "blocked" ? "bg-amber-100 font-medium text-amber-900" : "text-slate-500"}`}>
            {phase === "saving" ? "Saving…" : phase === "saved" ? `✓ Saved · v${version}` : "● Not runnable yet"}
          </Button>
        )}
        <div className="flex flex-wrap gap-2 sm:ml-auto" data-testid="wf-actions">
          {/* Archived is a state of the whole page, so it is in the bar with the actions — a panel can be closed, and the
              one thing that stops working is Run (task 15.2). */}
          {isArchived && (
            <Button variant="outline" type="button" data-testid="archived-chip" onClick={() => setPanelOpen(true)}
              title="This workflow is archived: it is out of every list and its schedules have stopped. Open the panel to unarchive it.">
              Archived
            </Button>
          )}
          <AsyncButton data-testid="btn-run" variant="default" onClick={run} disabled={isArchived}
            title={isArchived ? "Archived workflows can be unarchived, not run" : undefined}>Run</AsyncButton>
          <Button variant="outline" data-testid="btn-import"  title="Import a workflow from YAML" onClick={() => { setImportErrors([]); setImportOpen(true); }}>Import</Button>
          <AsyncButton data-testid="btn-export" variant="outline" disabled={!savedName} title={savedName ? "Export the workflow as YAML" : "Nothing to export yet"} onClick={doExport}>Export</AsyncButton>
          <span aria-hidden="true" className="hidden w-px self-stretch bg-slate-200 sm:block" />
          {/* Cloning waits on the server, so it is an AsyncButton like Export: the label becomes a spinner and
              cannot be clicked twice (AGENTS.md, "A button whose action waits on the server shows a spinner"). */}
          <AsyncButton data-testid="btn-clone" variant="outline" disabled={!savedName} onClick={cloneThis}
            title={savedName ? `Make a copy of "${savedName}" to change (its runs, schedules and script approvals are not copied)` : "Nothing to clone yet: open a workflow first"}>Clone</AsyncButton>
        </div>
      </div>
        );
        return inTopRow ? createPortal(bar, topRow!) : bar;
      })()}

      {/* Wide windows: blocks, canvas and panel side by side. Narrower: stacked, and the page scrolls. */}
      <div className="flex flex-1 flex-col lg:min-h-0 lg:flex-row">
        <aside className={`max-h-56 w-full shrink-0 overflow-auto border-b border-slate-200 bg-slate-50 lg:max-h-none lg:border-b-0 lg:border-r ${railFull ? "p-3 lg:w-56" : "p-1.5 lg:w-[4.5rem]"}`} data-testid="palette" data-ready={paletteReady} data-full={railFull}>
          {/* Building blocks: the only things that are dragged onto the canvas. */}
          {railFull ? (
            <>
              <div className="flex items-center justify-between">
                {/* One "?" for the four kinds, not one per block: four bubbles in a 224 px column was a
                    column of question marks, and each answered a question about its siblings anyway
                    (reported 2026-11-21). The section's bubble describes all four. */}
                <div className="label">Building blocks<Help id="blocks" /></div>
                {sideBySide && <Button variant="ghost" className="mb-1 h-8 w-8 px-0 text-slate-600" type="button" data-testid="palette-toggle" aria-expanded="true" title="Shrink this column to the four blocks, for a wider canvas" onClick={toggleRail}><Chevron dir="left" /></Button>}
              </div>
              <p className="mb-2 text-xs text-slate-500">Drag one onto the canvas.</p>
            </>
          ) : (
            <Button variant="ghost" className="mb-1.5 h-8 w-full px-0 text-slate-600" type="button" data-testid="palette-toggle" aria-expanded="false" title="Show the blocks with their explanations, and the MCP servers" onClick={toggleRail}><Chevron dir="right" /></Button>
          )}
          {paletteItem("palette-agent", "Agent", "agent", null, "runs a prompt")}
          {scriptsEnabled
            ? paletteItem("palette-script", "Script", "script", null, "sandboxed")
            : (
              <div data-testid="palette-script" data-disabled="true" aria-disabled="true" draggable={false} className="mb-1 cursor-not-allowed rounded border border-slate-200 bg-slate-100 px-2 py-1.5 text-sm text-slate-400">
                <div className="font-medium">Script</div>
                <div className="text-xs" data-testid="palette-script-reason">Disabled: {meta?.sandbox?.reason ?? "no sandbox backend on this platform"}</div>
              </div>
            )}
          {paletteItem("palette-gate", "Gate", "gate", null, "human decision")}
          {paletteItem("palette-map", "Map", "map", null, "fan out over a list")}

          {/* As a rail the server list is one click away: the count, which opens the column. */}
          {!railFull && (
            <Button variant="outline" className="mt-2 flex h-auto w-full flex-col gap-0 overflow-hidden px-1 py-1 text-center leading-tight" type="button" data-testid="palette-servers" title="MCP servers the agent CLI is connected to here: show the list" onClick={toggleRail}>
              {/* The count over a caption, like a rail item in the app shell: at 59 px of usable width "MCP servers" on one
                  line was clipped mid-word, and the number is the part a glance needs (reported 2026-11-22). */}
              <span className="block text-sm font-semibold text-slate-800" data-testid="palette-servers-count">{paletteReady ? Object.values(serversByAgent).flat().filter((r: any) => usable(r.status)).length : "…"}</span>
              <span className="block w-full truncate text-2xs uppercase tracking-wide text-slate-500">MCP</span>
            </Button>
          )}
          {/* MCP servers: information, not blocks. Deliberately plain rows with a status dot, no card, not draggable. */}
          <div className={`mt-5 border-t border-slate-200 pt-3 ${railFull ? "" : "hidden"}`} data-testid="palette-mcp-list">
            {/* No "?" here: the line under it already says what the list is, and a tooltip repeating the sentence beside it
                is the noise 15.40 removed elsewhere (asked 2026-11-22: "remove this"). */}
            <div className="label">MCP servers</div>
            <p className="mb-2 text-xs text-slate-500" data-testid="palette-mcp-explained">What each agent CLI is connected to. Not blocks: an agent node may use all the servers of its agent unless you restrict it in its panel.</p>
            {mcpFolder && <p className="mono mb-2 break-all text-2xs text-slate-500" data-testid="palette-mcp-folder" title="The servers depend on the folder the agent runs in">in {mcpFolder}</p>}
            {paletteReady && totalServers === 0 && <div className="mb-2 text-xs text-slate-500" data-testid="palette-empty">Your agent CLIs report no MCP servers here. chief does not configure them: Settings › MCP servers has the exact command for each CLI.</div>}
            {/* One group per agent CLI, so it is clear which agent is connected to which server. All of
                them are listed, including one that is not installed or switched off: "why is Codex not
                here?" is a question the list answers (task 15.19). */}
            {agentOrder.map((agent) => {
              const rows = serversByAgent[agent] ?? [];
              const on = rows.filter((r) => usable(r.status)), off = rows.filter((r) => !usable(r.status));
              const provider = providerState[agent];
              const why = provider && !provider.found ? "not installed" : provider && !provider.enabled ? "switched off in Settings" : null;
              if (!rows.length) {
                // Shown only once the list is known, and only for agents other than the one in use.
                return paletteReady && agent !== workflowAgent
                  ? <div key={agent} data-testid={`palette-mcp-agent-${agent}`} data-count="0" data-why={why ?? "none"} className="mt-2 text-xs text-slate-400">{AGENT_NAME[agent] ?? agent}: no servers ({why ?? "none set up"})</div>
                  : null;
              }
              return (
                <div key={agent} data-testid={`palette-mcp-agent-${agent}`} data-count={rows.length} data-why={why ?? undefined} className="mt-2 first:mt-0">
                  {/* Each group folds, so a CLI with thirty servers does not push the rest off the column
                      (reported 2026-11-21: "this list may go super long"). Open by default, so the column
                      still says at a glance what is connected; the count stays visible when it is shut. */}
                  <details data-testid={`palette-mcp-group-${agent}`} open={!folded.has(agent)}
                    onToggle={(e) => {
                      const isOpen = (e.currentTarget as HTMLDetailsElement).open;
                      setFolded((cur) => { const next = new Set(cur); if (isOpen) next.delete(agent); else next.add(agent); return next; });
                    }}>
                    <summary className="flex cursor-pointer list-none items-baseline justify-between gap-1 rounded text-xs font-semibold text-slate-700 hover:text-slate-900" title={why ? `${AGENT_NAME[agent] ?? agent}: ${why}` : `Show or hide ${AGENT_NAME[agent] ?? agent}'s servers: ${on.length} connected, ${off.length} not`}>
                      {/* The caret a folded list needs: `list-none` removed the browser's marker, so a
                          header that folds looked exactly like one that does not (reported 2026-11-21).
                          Its rotation is a plain CSS rule in styles.css (`details[open] .caret`): the
                          utility form did not apply, and a caret that never turns is a second lie. */}
                      <span className="flex min-w-0 items-baseline gap-1">
                        <svg viewBox="0 0 12 12" aria-hidden="true" data-testid={`palette-mcp-caret-${agent}`} className="caret h-2.5 w-2.5 shrink-0 self-center">
                          <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span data-testid={`palette-mcp-agent-name-${agent}`} className="truncate">{AGENT_NAME[agent] ?? agent}</span>
                      </span>
                      {/* A CLI that cannot be used says why, in place of the count. */}
                      <span className="shrink-0 font-normal text-slate-500">{why ?? `${on.length} ${on.some((r) => r.status === "configured") ? "set up" : "connected"}`}</span>
                    </summary>
                    <ul className="text-xs">{on.map(mcpRow(agent))}</ul>
                    {off.length > 0 && (
                      <details className="mt-1" data-testid={agent === "claude-code" ? "palette-mcp-unavailable" : `palette-mcp-unavailable-${agent}`}>
                        <summary className="cursor-pointer text-xs text-slate-500">Not connected ({off.length})</summary>
                        <ul className="mt-1 text-xs">{off.map(mcpRow(agent))}</ul>
                      </details>
                    )}
                  </details>
                </div>
              );
            })}
          </div>
        </aside>

        <div ref={wrapper} className="relative h-[60vh] min-w-0 shrink-0 lg:h-auto lg:flex-1" data-testid="canvas" onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }} onDrop={onDrop}>
          <DefsContext.Provider value={defs}><EntryContext.Provider value={entries}>
            <ReactFlow nodes={nodes} edges={shownEdges} nodeTypes={nodeTypes} defaultEdgeOptions={EDGE_OPTIONS} fitView fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
              colorMode={theme}
              // The canvas chrome is chief's own. The library's attribution badge is a link to its site
              // in the corner of the canvas; the credit is in THIRD-PARTY-NOTICES like every other MIT
              // dependency, and the run diagram hides it too (task 15.9).
              proOptions={{ hideAttribution: true }}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
              onConnect={(c: Connection) => setEdges((cur) => addEdge({ ...c, id: `${c.source}-${c.target}` }, cur))}
              onNodesDelete={(gone) => { const keys = new Set(gone.map((g) => g.id)); setDefs((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !keys.has(k)))); setSelected((s) => (s && keys.has(s) ? null : s)); }}
              onSelectionChange={onSelectionChange}
              // A click on a step or connection shows it, also when it was selected already and the Workflow tab is open.
              onNodeClick={() => setTab("step")} onEdgeClick={() => setTab("step")}>
              <Background />
              {/* The library's own fit-view button is a pair of brackets with no label, which is the one
                  control a person needs when they have panned the workflow off screen (asked for
                  2026-11-21). It is replaced by ours below: same action, a label and a tooltip. */}
              <Controls showFitView={false}>
                <ControlButton data-testid="canvas-fit" title="Fit the whole workflow in the canvas" aria-label="Fit the whole workflow in the canvas" onClick={fitAll}>
                  {/* Arrows out of a frame: "make it all fit", rather than a pair of parentheses. */}
                  <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
                    <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    <rect x="5.5" y="5.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                </ControlButton>
              </Controls>
            </ReactFlow>
          </EntryContext.Provider></DefsContext.Provider>
          {nodes.length === 0 && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-400" data-testid="canvas-empty">Drag a building block here.</div>}
        </div>

        {/* The handle that resizes the side panel (wide windows only): drag, arrow keys, double-click to reset. */}
        <div data-testid="panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize the side panel" tabIndex={0}
          aria-valuenow={panelWidth} aria-valuemin={PANEL_MIN} aria-valuemax={Math.round(window.innerWidth * PANEL_MAX_SHARE)}
          title="Drag to resize · double-click to reset"
          className={`group relative z-10 -mr-1 hidden w-2 shrink-0 cursor-col-resize touch-none ${panelShown ? "lg:block" : ""} ${dragWidth !== null ? "bg-primary/30" : "hover:bg-primary/20 focus-visible:bg-primary/20"}`}
          onPointerDown={startResize} onDoubleClick={() => setPanelWidth(PANEL_DEFAULT)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 64 : 16;
            if (e.key === "ArrowLeft") { e.preventDefault(); setPanelWidth((w) => clampPanel(w + step)); }
            if (e.key === "ArrowRight") { e.preventDefault(); setPanelWidth((w) => clampPanel(w - step)); }
          }}>
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-200 group-hover:bg-primary" />
        </div>
        {/* The panel closed: a tab, not a sliver of empty space. A lone « was a chevron with nothing to say,
            and at 28 px of plain grey the strip could be mistaken for the window's edge — a person could not
            tell a panel existed until they dropped a block (reported 2026-11-21, twice). The strip is tinted,
            the button is a bordered handle with a drawn chevron and the label reading downwards, and hover
            and focus fill it, so it answers when touched. */}
        {!panelShown && (
          <div className="hidden shrink-0 border-l border-slate-200 bg-slate-100 p-1 lg:block" data-testid="side-panel-closed">
            <Button variant="outline" className="group flex h-full flex-col border border-slate-400 bg-slate-50 shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring" type="button" data-testid="panel-toggle" aria-expanded="false" aria-controls="designer-panel" title="Show the panel: the workflow's settings and the selected step" onClick={togglePanel}>
              <svg viewBox="0 0 12 12" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:-translate-x-0.5">
                <path d="M7.5 2L3.5 6l4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-2xs font-bold uppercase tracking-widest [writing-mode:vertical-rl]">Panel</span>
            </Button>
          </div>
        )}
        <aside id="designer-panel" className={`relative w-full shrink-0 overflow-auto border-t border-slate-200 bg-surface p-4 lg:w-[var(--panel-w)] lg:border-t-0 ${panelShown ? "" : "lg:hidden"}`} data-testid="side-panel" data-open={panelShown}
          style={{ ["--panel-w" as any]: `${panelWidth}px` }}>
          {sideBySide && panelShown && <Button variant="ghost" className="absolute right-2 top-2 z-10 h-8 w-8 px-0 text-slate-500" type="button" data-testid="panel-toggle" aria-expanded="true" aria-controls="designer-panel" title="Hide the panel, for a wider canvas. It comes back when a step is selected" onClick={togglePanel}><Chevron dir="right" /></Button>}
          <ErrorBox error={error} testid="designer-error" />
          <div data-testid="autosave-status" data-state={phase} data-dirty={dirty} data-version={version ?? ""} className={`mb-3 pr-7 text-xs ${phase === "blocked" ? "text-amber-800" : "text-slate-500"}`}>
            {phase === "empty" && "Nothing to save yet. Drop a block on the canvas and give the workflow a name; everything is saved automatically."}
            {phase === "saving" && "Saving…"}
            {phase === "saved" && <>✓ Saved automatically · {savedName} v{version}{savedAt ? ` · ${savedAt.toLocaleTimeString([], { hour12: false })}` : ""}</>}
            {phase === "blocked" && <>● Your changes are stored, but this is not a runnable workflow yet{savedName ? `. “${savedName}” keeps its last valid version (v${version}) until the problems below are fixed.` : "."}</>}
          </div>
          {unapproved.length > 0 && (
            <div data-testid="approval-needed" className="mb-3 rounded border-2 border-amber-400 bg-amber-50 p-3 text-sm">
              <div className="mb-1 font-semibold text-amber-900">Approval needed before this workflow can run</div>
              <p className="mb-2">These script nodes ask for more than the default sandbox. Approve only if you have read the scripts; the approval is tied to each script’s current content.</p>
              <ul data-testid="approve-list" className="mb-2 list-disc pl-5">{unapproved.map((a) => <li key={a.node_id}><b>{a.node_id}</b>: {a.widening}{a.missing ? " (script file not found)" : ""}</li>)}</ul>
              <AsyncButton data-testid="approve-confirm" variant="default" onClick={approveSandbox}>Approve these permissions</AsyncButton>
            </div>
          )}
          {/* Amber, not a shadcn token: shadcn's scheme has exactly one status colour (`destructive`) and no warning, so its own
              advice is to use the palette directly — which this does, and chief's dark block themes both ends of the amber
              ramp, so the same three classes read in either theme (text is 8.75:1 in the light, 14.5:1 in the dark).
              `role="status"` because the colour is not the only thing saying it: a restore nobody is told about is silent. */}
          {/*
            * No "your changes were restored" notice (removed 2026-11-22: *"i just realized that this discard feature isn't
            * required, remove this"*). Restoring is what chief does — the canvas coming back is the news, and a banner
            * explaining it sat above the workflow on every reload of unfinished work. **Nothing about the draft itself
            * changed**: it is still written as it is typed and still comes back, which is the no-data-loss rule (AGENTS.md).
            * "Throw the working copy away" went with the notice: the way to get back to the stored workflow is to undo the
            * edits one by one ("Undo the assistant's change" and the canvas are both live), and a button that silently
            * discarded everything typed since the last valid version was the one destructive control with no confirmation.
            */}
          {note && <div data-testid="designer-note" className="mb-3 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900">{note}</div>}
          {/* Archived, said where the workflow is rather than only in the panel: everything on this canvas still works
              (it saves, it clones, its runs are here) except being started, and that has to be visible without opening a tab. */}
          {isArchived && (
            <div data-testid="archived-banner" role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-700">
              <span>This workflow is archived: it is not offered when starting a run, and its schedules have stopped.</span>
              <Button variant="link" size="sm" className="px-0" type="button" data-testid="archived-unarchive" onClick={() => void toggleArchive()}>Unarchive</Button>
            </div>
          )}
          {validation && (
            <div data-testid="validation" data-ok={validation.ok} className="mb-4 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className={`font-semibold ${validation.ok ? "text-green-800" : "text-red-800"}`} data-testid="validation-summary">{validation.ok ? "Valid" : `${validation.errors.length} error${validation.errors.length === 1 ? "" : "s"}`}</div>
              {validation.errors.length > 0 && <ul data-testid="validation-errors" className="mt-1 list-disc pl-5 text-red-800">{validation.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
              {validation.warnings.length > 0 && <ul data-testid="validation-warnings" className="mt-1 list-disc pl-5 text-amber-800">{validation.warnings.map((e, i) => <li key={i}>{e}</li>)}</ul>}
              {validation.environment.length > 0 && (<><div className="mt-2 text-xs font-semibold uppercase text-slate-500">On this machine</div><ul data-testid="validation-environment" className="list-disc pl-5 text-slate-700">{validation.environment.map((e, i) => <li key={i}>{e}</li>)}</ul></>)}
              {validation.estimates.length > 0 && (<><div className="mt-2 text-xs font-semibold uppercase text-slate-500">Prompt size (before templates)</div><ul data-testid="validation-estimates" className="mono text-xs">{validation.estimates.map((e) => <li key={e.node_id}>{e.node_id}: ~{e.est_tokens} tokens</li>)}</ul></>)}
            </div>
          )}
          {/* Two tabs instead of one long column: the workflow's settings, and the selected step. */}
          <Tabs value={tab} onValueChange={(v) => setTab(v as "workflow" | "step")}>
            <TabsList aria-label="Side panel" data-testid="panel-tabs" className="mb-3 w-full">
              {([["workflow", "Workflow"], ["step", sel && selected ? `Step: ${sel.id || "(no id)"}` : pickedEdge ? "Connection" : "Step"]] as const).map(([key, label]) => (
                <TabsTrigger key={key} value={key} data-testid={`tab-${key}`} className="max-w-[60%] truncate">{label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {tab === "workflow" && (
          <section data-testid="wf-settings" role="tabpanel">
            <div className="grid grid-cols-3 gap-x-2 gap-y-2">
          <label className="col-span-3"><span className="label">Name</span>
            <Input data-testid="wf-name" aria-invalid={phase === "blocked" && !wf.name.trim() ? true : undefined} placeholder="daily-triage" value={wf.name} onChange={(e) => setWf({ ...wf, name: e.target.value })} />
            {/* The example is the placeholder, not a "?" (reported 2026-11-21): a name needs a shape, and
                the shape is easier to read inside the box than in a bubble beside it. */}
            <span className="mt-1 block text-xs text-slate-500">Lower-case letters, digits and dashes. It is how the workflow is named in runs and on the command line.</span>
          </label>
          {/* The budget fields are hidden while budgets are, but what a workflow already has is kept: it
              is still in `wf` and still saved (features.ts, task 15.24). */}
          {SHOW_BUDGETS && <>
            <label><span className="label">Warn $<Help id="wf-warn" /></span><Input data-testid="wf-warn"  value={wf.warn} onChange={(e) => setWf({ ...wf, warn: e.target.value })} /></label>
            <label><span className="label">Max $<Help id="wf-max" /></span><Input data-testid="wf-max"  value={wf.max} onChange={(e) => setWf({ ...wf, max: e.target.value })} /></label>
          </>}
          <label className="col-span-3"><span className="label">Working directory<Help id="wf-base-dir" /></span><Input className="mono" data-testid="wf-base-dir"  placeholder={meta ? `${meta.workspace_dir}/${wf.name || "<name>"}` : ""} value={wf.baseDir} onChange={(e) => setWf({ ...wf, baseDir: e.target.value })} /></label>
          {/* No "?" here (asked 2026-11-22): the label says which CLI, and the dropdown lists the ones installed. The rule
              about which choice wins — the step's, then the workflow's, then Settings — is in docs/workflow-guide.md. */}
          <label><span className="label">Agent CLI</span>
            <Select data-testid="wf-agent"  value={wf.agent} onChange={(e) => setWf({ ...wf, agent: e.target.value })}>
              <option value="">default{meta ? ` (${meta.default_adapter})` : ""}</option>
              {(meta?.adapters ?? []).map((a: string) => <option key={a} value={a}>{a}</option>)}
            </Select>
          </label>
          {/* The workflow's inputs: one JSON for all blocks, one section per block id. Run shows it for the values of that run. */}
          <div className="col-span-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="label mb-0">Inputs (JSON, one section per block)<Help id="wf-inputs" /></span>
              <Button variant="link" className="ml-auto" type="button" data-testid="wf-inputs-by-block" title="Add an empty section for every block that has none yet" onClick={() => {
                  const cur = parseInputs(inputsText);
                  if (!cur) return;
                  const next: Record<string, unknown> = { ...cur };
                  for (const n of nodes) { const id = defs[n.id]?.id; if (id && !(id in next)) next[id] = {}; }
                  setInputsText(JSON.stringify(next, null, 2)); setWf((w) => ({ ...w, inputs: next }));
                }}>Add a section per block</Button>
            </div>
            <div className="mt-1"><JsonEditor testid="wf-inputs" rows={3} invalid={!inputsValid(inputsText)} title="The workflow's inputs, as a JSON object with one section per block id" value={inputsText}
              placeholder={'{\n  "planner": { "prlink": "" },\n  "runner": {}\n}'}
              onChange={(t) => { setInputsText(t); const v = parseInputs(t); if (v) setWf((cur) => ({ ...cur, inputs: v })); }} /></div>
          </div>
            </div>
            {/*
              * Out of service, rather than deleted (task 15.2). Deleting a workflow that has runs is refused, because each
              * run is the record of what happened and it points at this row — which left a finished workflow in every
              * picker for ever. Archiving hides it everywhere and stops its schedules, and loses nothing: the runs, their
              * replay and the schedules all still resolve. Delete is offered only where it can work.
              *
              * One button and a bin, with no heading and no note beside either (asked 2026-11-22: *"let's simplify this,
              * keep only 1 button `Archive workflow`, that's it, no need to header and hint text"*). The labels say what
              * the buttons do, and a bin that cannot be used says why in its title instead of in a paragraph under it.
              */}
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3" data-testid="wf-danger">
              <AsyncButton data-testid="wf-archive" variant="outline" disabled={!savedName} onClick={toggleArchive}
                title={isArchived ? "Put it back in service: it is offered again and its schedules fire again" : "Take it out of service: hidden from every list, its schedules stop firing, and its runs are kept"}>
                {isArchived ? "Unarchive workflow" : "Archive workflow"}
              </AsyncButton>
              <TrashButton testid="wf-delete" label={runCount > 0 ? "Delete workflow" : `Delete ${savedName || "workflow"}`}
                disabled={!savedName || runCount > 0}
                title={!savedName ? "Nothing to delete yet: give it a name first"
                  : runCount > 0 ? `Its ${runCount} run${runCount === 1 ? " is" : "s are"} kept in full, so it cannot be deleted. Archive it instead.`
                    : "Remove it for good: it has no runs, so there is no record to keep."}
                onClick={() => setConfirmingDelete(true)} />
            </div>
          </section>
          )}
          {tab === "step" && (
          <div role="tabpanel" data-testid="step-tab">
          {sel && selected
            ? <NodePanel node={sel} servers={namesByAgent} scriptsEnabled={scriptsEnabled} adapter={wf.agent || meta?.default_adapter || "claude-code"} adapters={meta?.adapters ?? []} onDelete={() => removeNode(selected)} change={(patch) => setDefs((cur) => ({ ...cur, [selected]: { ...cur[selected], ...patch } as NodeDef }))} />
            : pickedEdge
            ? (
              <div data-testid="edge-panel" className="rounded border-2 border-ring bg-accent p-3 text-sm">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-primary">Connection selected</div>
                <div className="mb-3 font-medium" data-testid="edge-label">{defs[pickedEdge.source]?.id ?? "?"} → {defs[pickedEdge.target]?.id ?? "?"}</div>
                <p className="mb-3 text-slate-700">“{defs[pickedEdge.target]?.id}” runs after “{defs[pickedEdge.source]?.id}” has completed.</p>
                {/* The bin again: one removal control in the whole app, so it is learned once. */}
                <div className="flex items-center gap-2">
                  <TrashButton testid="edge-delete" label="Delete this connection" title="Delete this connection: the arrow between the two steps goes" onClick={() => { setEdges((cur) => cur.filter((e) => e.id !== pickedEdge.id)); setSelectedEdge(null); }} />
                  <span className="text-xs text-slate-500">or press Backspace</span>
                </div>
              </div>
            )
            : <div className="text-sm text-slate-500" data-testid="panel-empty">Select a node to edit it. Connect nodes by dragging from the bottom handle of one to the top handle of another: the arrow points to the node that runs after. Nodes marked “runs first” have nothing pointing to them.</div>}
          </div>
          )}
        </aside>
      </div>

      {creating && (
        <>
          <div data-testid="new-wf-backdrop" className="fixed inset-0 z-40 bg-black/20" onClick={() => setCreating(false)} />
          <aside data-testid="new-wf-panel" role="dialog" aria-modal="true" aria-label="New workflow" className="slide-in-right fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-auto bg-surface p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">New workflow</h2>
              <Button variant="outline" className="p-1.5" type="button" data-testid="new-wf-close" aria-label="Close" onClick={() => setCreating(false)}>✕</Button>
            </div>
            <label className="mb-3 block"><span className="label">Name</span>
              <Input data-testid="new-wf-name" autoFocus  placeholder="daily-triage" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <span className="mt-1 block text-xs text-slate-500">Lower-case letters, digits and dashes.</span>
            </label>
            <label className="mb-3 block"><span className="label">Working directory (optional)</span>
              <Input className="mono" data-testid="new-wf-base-dir"  placeholder={meta ? `${meta.workspace_dir}/${formName || "<name>"}` : ""} value={form.baseDir} onChange={(e) => setForm({ ...form, baseDir: e.target.value })} />
              <span className="mt-1 block text-xs text-slate-500">Where its steps run. Empty: a folder of its own in the workspace.</span>
            </label>
            <div className="mb-3 grid grid-cols-3 gap-2">
              <label><span className="label">Agent CLI</span>
                <Select data-testid="new-wf-agent"  value={form.agent} onChange={(e) => setForm({ ...form, agent: e.target.value })}>
                  <option value="">default{meta ? ` (${meta.default_adapter})` : ""}</option>
                  {(meta?.adapters ?? []).map((a: string) => <option key={a} value={a}>{a}</option>)}
                </Select>
              </label>
              {SHOW_BUDGETS && <>
                <label><span className="label">Warn $</span><Input data-testid="new-wf-warn"  value={form.warn} onChange={(e) => setForm({ ...form, warn: e.target.value })} /></label>
                <label><span className="label">Max $</span><Input data-testid="new-wf-max"  value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} /></label>
              </>}
            </div>
            {/* No inputs here: a run gives its values when it starts; defaults, if any, are set in the open workflow's settings. */}
            {formName && formProblem && <p data-testid="new-wf-problem" className="mb-3 text-sm text-red-700">{formProblem}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="default" data-testid="new-wf-create"  disabled={!!formProblem} title={formProblem ?? undefined} onClick={createFromForm}>Create</Button>
              <Button variant="outline" data-testid="new-wf-import"  onClick={() => { setCreating(false); setImportErrors([]); setImportOpen(true); }}>Import YAML instead</Button>
            </div>
            <p className="mt-4 text-xs text-slate-500">The workflow is saved as soon as it has its first step. Its settings stay editable in the panel on the right of the designer.</p>
          </aside>
        </>
      )}
      {importOpen && (
        <Modal title="Import YAML" testid="import-modal" onClose={() => setImportOpen(false)}>
          <Input type="file" accept=".yaml,.yml,.json" data-testid="import-file" className="mb-2 text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setImportText(await f.text()); }} />
          <Textarea data-testid="import-yaml" rows={14} className="mono text-xs mb-2" placeholder="Paste a workflow YAML here" value={importText} onChange={(e) => setImportText(e.target.value)} />
          {importErrors.length > 0 && <ul data-testid="import-errors" className="mb-2 list-disc pl-5 text-sm text-red-800">{importErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          <AsyncButton data-testid="import-load" variant="default" disabled={!importText.trim()} onClick={doImport}>Load onto the canvas</AsyncButton>
        </Modal>
      )}

      {confirmingDelete && savedName && (
        <Modal title={`Delete "${savedName}"?`} testid="delete-modal" onClose={() => setConfirmingDelete(false)}>
          <p className="mb-3 text-sm text-slate-700">It has no runs, so nothing has been recorded from it. This cannot be undone.</p>
          <div className="flex flex-wrap gap-2">
            <AsyncButton data-testid="delete-yes" variant="destructive" onClick={() => { setConfirmingDelete(false); void deleteThis(); }}>Delete</AsyncButton>
            <Button variant="outline" data-testid="delete-no" onClick={() => setConfirmingDelete(false)}>Keep it</Button>
          </div>
        </Modal>
      )}

      {exported !== null && (
        <Modal title={`${savedName}.yaml`} testid="export-modal" onClose={() => setExported(null)}>
          <Textarea data-testid="export-yaml" readOnly rows={18} className="mono text-xs mb-2" value={exported} />
          {/* A link that downloads: shadcn's Button with `asChild`, so it is the same button and still an anchor. */}
          <Button asChild size="sm"><a data-testid="export-download" download={`${savedName}.yaml`} href={`data:text/yaml;charset=utf-8,${encodeURIComponent(exported)}`}>Download</a></Button>
        </Modal>
      )}
    </div>
  );
}

function parseInputs(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text.trim() || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}
const inputsValid = (text: string) => parseInputs(text) !== null;

/** The designer side panel: default width, the narrowest it goes, and the widest as a share of the window. */
const PANEL_DEFAULT = 384, PANEL_MIN = 320, PANEL_MAX_SHARE = 0.6;
const clampPanel = (w: number) => Math.round(Math.min(Math.max(w, PANEL_MIN), Math.max(PANEL_MIN, window.innerWidth * PANEL_MAX_SHARE)));

export function Designer({ name }: { name: string | null }) {
  return <ReactFlowProvider><DesignerInner name={name} /></ReactFlowProvider>;
}

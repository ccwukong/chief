import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { agentList, api, get, getPage, tokenCount, usd } from "../api";
import { SHOW_COST } from "../features";
import { AsyncButton, ConfirmDeleteRuns, ErrorBox, FINISHED, go, Pager, readDraft, Status, useDraft, useWindowWidth } from "../ui";
import { blankInputs, RunInputsEditor, type InputRef } from "../run-inputs";
import { RunDetail } from "./run-detail";
import { usePolling } from "../polling";

/** The run panel's width: two thirds of the window by default, never so wide that the list beside it disappears. */
const clampRunPanel = (w: number) => Math.round(Math.min(Math.max(w, 520), Math.max(520, window.innerWidth - 300)));

/**
 * The run list. A run that is opened (`openId`, from #/runs/<id>) is shown in a panel that lies over
 * the right part of the page. The list under it is not rearranged: it stays exactly as it was, with
 * its filter, page and scroll position, and the rows left of the panel can still be clicked;
 * another row or the arrow keys change the run, Escape closes the panel.
 */
export function Runs({ openId = null }: { openId?: number | null }) {
  const [runs, setRuns] = useState<any[] | null>(null);
  const [total, setTotal] = useState(0);
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [workflow, setWorkflow] = useDraft("new-run:workflow", "");
  const [inputs, setInputs, clearInputs] = useDraft("new-run:inputs", "");
  const [only, setOnly] = useDraft("runs:filter", "");
  const [perPage, setPerPage] = useDraft("runs:per-page", 10);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** The inputs the chosen workflow uses, with their defaults. */
  const [refs, setRefs] = useState<InputRef[]>([]);
  /** True when no agent CLI is set up: the run cannot start, and the button says why (task 15.15). */
  const [noAgent, setNoAgent] = useState(false);
  /** Why, in the person's terms: nothing installed, or everything that is installed is switched off. */
  const [noAgentWhy, setNoAgentWhy] = useState("");

  useEffect(() => {
    get("/api/workflows").then((w) => { setWorkflows(w); setWorkflow((cur) => (cur && w.some((x: any) => x.name === cur) ? cur : w[0]?.name || "")); }).catch(() => {});
    // Without an agent CLI a run cannot start: the button says so instead of failing after the click.
    get("/api/meta").then((m) => {
      const none = Array.isArray(m?.usable_adapters) && m.usable_adapters.length === 0;
      const found: string[] = Array.isArray(m?.found_providers) ? m.found_providers : [];
      setNoAgent(none);
      setNoAgentWhy(none ? (found.length ? `Every agent CLI is switched off (${agentList(found)} ${found.length === 1 ? "was" : "were"} found), so a run cannot start.` : "No agent CLI is installed, so a run cannot start.") : "");
    }).catch(() => {});
  }, []);

  // The list keeps asking, because a run can start, finish or be resumed by another process and this
  // page has no stream of its own. `usePolling` re-arms when the filter, page or reload counter
  // changes, and stops when the page unmounts.
  const load = useCallback(() => getPage(only ? `/api/runs?workflow=${encodeURIComponent(only)}` : "/api/runs", page, perPage).then(({ items, total }) => {
    // A page that emptied (runs deleted, a smaller total) moves back to the last page that has runs.
    const last = Math.max(1, Math.ceil(total / perPage));
    if (page > last) return setPage(last);
    setRuns(items); setTotal(total);
    setSelected((cur) => new Set([...cur].filter((id) => items.some((r: any) => r.id === id && FINISHED.includes(r.status)))));
  }).catch((e) => setError(e.message)), [only, page, perPage]);
  usePolling(load, 2000, [load, reload]);

  useEffect(() => {
    if (!workflow) return setRefs([]);
    let live = true;
    get(`/api/workflows/${encodeURIComponent(workflow)}`).then((w) => live && setRefs(w.input_refs ?? [])).catch(() => live && setRefs([]));
    return () => { live = false; };
  }, [workflow]);

  // ── the panel with the opened run ─────────────────────────────────────────
  const [savedPanelWidth, setSavedPanelWidth] = useDraft("ui:run-panel-width", 0);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const winWidth = useWindowWidth();
  const panelWidth = clampRunPanel(dragWidth ?? (savedPanelWidth || winWidth * 0.66));
  const startResize = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startW = panelWidth;
    let last = startW;
    const move = (ev: PointerEvent) => { last = clampRunPanel(startW + (startX - ev.clientX)); setDragWidth(last); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setSavedPanelWidth(last); setDragWidth(null); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const closePanel = () => go("/runs");
  // The panel slides in from the right and out again. While it slides out it still shows the run that
  // was open, so `shownId` lags behind `openId` by the length of that movement.
  const [shownId, setShownId] = useState<number | null>(openId);
  useEffect(() => {
    if (openId != null) { setShownId(openId); return; }
    const t = setTimeout(() => setShownId(null), 200);
    return () => clearTimeout(t);
  }, [openId]);
  const closing = openId == null && shownId != null;
  const openIndex = openId == null ? -1 : (runs ?? []).findIndex((r) => r.id === openId);
  const neighbour = (step: number) => (openIndex < 0 ? null : (runs ?? [])[openIndex + step] ?? null);
  // Keys while a run is open: Escape closes it, the arrows go to the run above or below in the list.
  // Not while typing, and not while a dialog or a tooltip is using the key.
  useEffect(() => {
    if (openId == null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.closest("input, textarea, select, [contenteditable]") || t.closest('[role="tooltip"]'))) return;
      if (document.querySelector('[data-testid="confirm-delete"]')) return;
      if (e.key === "Escape") { e.preventDefault(); closePanel(); }
      const to = e.key === "ArrowDown" ? neighbour(1) : e.key === "ArrowUp" ? neighbour(-1) : null;
      if (to) { e.preventDefault(); go(`/runs/${to.id}`); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const deletable = (runs ?? []).filter((r) => FINISHED.includes(r.status));
  const allTicked = deletable.length > 0 && deletable.every((r) => selected.has(r.id));
  const tick = (id: number, on: boolean) => setSelected((cur) => { const n = new Set(cur); if (on) n.add(id); else n.delete(id); return n; });

  const start = async () => {
    setError(null);
    let parsed: unknown = {};
    if (inputs.trim()) {
      try { parsed = JSON.parse(inputs); } catch { return setError("Inputs must be a JSON object."); }
      // A blank of the template that was not filled in would start a run about nothing.
      const blank = blankInputs(refs, parsed);
      if (blank.length) return setError(`${blank.map((b) => `inputs.${b}`).join(", ")} ${blank.length === 1 ? "is" : "are"} empty. Fill ${blank.length === 1 ? "it" : "them"} in, or remove ${blank.length === 1 ? "it" : "them"} from the JSON to use the workflow's own value.`);
    }
    try {
      const d = await api("POST", "/api/runs", { workflow, inputs: parsed });
      clearInputs();
      go(`/runs/${d.run.id}`);
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="page-width py-6" data-testid="page-column">
      <h1 className="mb-4 text-xl font-semibold">Runs</h1>
      <ErrorBox error={error} />
      {/* Start a run: one line, the workflow and the button that starts it, because that is one thought. The
          inputs are a second, optional line and only exist when this workflow has any: a JSON box under a
          workflow that takes no inputs was the bulk of the card and said nothing (reported 2026-11-21: "this
          entire block looks ugly"). The editor stays the only way in — a list of the workflow's stored values
          was removed on request in 9.48, and this does not bring it back. */}
      <div className="card mb-5" data-testid="new-run">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Start a run</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block min-w-0 flex-1 sm:max-w-sm">
            <span className="label">Workflow</span>
            <select data-testid="new-run-workflow" className="input w-full" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
              {workflows.length === 0 && <option value="">No workflows yet</option>}
              {workflows.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
            </select>
          </label>
          <AsyncButton data-testid="new-run-start" className="btn btn-primary shrink-0" disabled={!workflow || noAgent} onClick={start}>Start run</AsyncButton>
        </div>
        {noAgent && (
          <p data-testid="new-run-no-agent" className="mt-2 text-xs text-red-800">
            {noAgentWhy} <a className="underline" href="#/settings">Open Settings › Agent CLIs</a>.
          </p>
        )}
        {/* Shown when the workflow uses inputs (there is something to fill in) and when a draft is still held,
            so a value typed under another workflow is never invisible yet sent. */}
        {(refs.length > 0 || inputs.trim() !== "") && (
          <div className="mt-3 min-w-0 md:max-w-3xl" data-testid="new-run-inputs-block">
            <RunInputsEditor refs={refs} value={inputs} onChange={setInputs} rows={2} />
          </div>
        )}
        {workflow && readDraft(`designer:${workflow}`) && (
          <div data-testid="new-run-unsaved" className="mt-3 text-xs text-amber-800">
            “{workflow}” has changes in the designer that are not a valid workflow yet. This run uses its last valid version. <a className="underline" href={`#/designer/${encodeURIComponent(workflow)}`}>Open the designer</a>
          </div>
        )}
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">Show runs of</span>
          <select data-testid="runs-filter" className="input w-56" value={only} onChange={(e) => { setOnly(e.target.value); setPage(1); setSelected(new Set()); }}>
            <option value="">all workflows</option>
            {workflows.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && <span className="text-sm text-slate-600" data-testid="runs-selected">{selected.size} selected</span>}
          <button data-testid="runs-delete" className="btn btn-danger" disabled={!selected.size} title={selected.size ? undefined : "Tick finished runs to delete them"} onClick={() => setConfirming(true)}>Delete</button>
        </div>
      </div>
      <div className="overflow-x-auto rounded border border-slate-200 bg-surface">
      <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="runs-table">
        <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="w-10 px-3 py-2"><input type="checkbox" data-testid="runs-select-all" aria-label="Select every finished run on this page" checked={allTicked} disabled={!deletable.length}
              onChange={(e) => setSelected(e.target.checked ? new Set(deletable.map((r) => r.id)) : new Set())} /></th>
            <th className="px-3 py-2">Run</th><th className="px-3 py-2">Workflow</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Tokens</th>{SHOW_COST && <th className="px-3 py-2">Cost</th>}<th className="px-3 py-2">Created</th>
          </tr>
        </thead>
        <tbody>
          {runs?.map((r) => {
            const finished = FINISHED.includes(r.status);
            return (
              <tr key={r.id} data-testid={`run-row-${r.id}`} data-open={openId === r.id} aria-current={openId === r.id ? "true" : undefined}
                className={`cursor-pointer border-t border-slate-100 ${openId === r.id ? "bg-blue-100 shadow-[inset_3px_0_0_#2563eb]" : selected.has(r.id) ? "bg-blue-50" : "hover:bg-slate-50"}`} onClick={() => go(`/runs/${r.id}`)}>
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" data-testid={`run-select-${r.id}`} aria-label={`Select run #${r.id}`} checked={selected.has(r.id)} disabled={!finished}
                    title={finished ? undefined : "Only finished runs can be deleted: cancel the run first"} onChange={(e) => tick(r.id, e.target.checked)} />
                </td>
                <td className="px-3 py-2 font-medium">#{r.id}</td>
                <td className="px-3 py-2">{r.workflow_name}</td>
                <td className="px-3 py-2"><Status value={r.status} /></td>
                {/* "Tokens" is the label: the numbers are input and output tokens, in the run page's compact form. */}
                <td className="mono whitespace-nowrap px-3 py-2 text-slate-600" data-testid={`run-tokens-${r.id}`} title="Input and output tokens">
                  {tokenCount(r.tokens_in)} in · {tokenCount(r.tokens_out)} out
                </td>
                {SHOW_COST && <td className="px-3 py-2 mono" data-testid={`run-cost-${r.id}`}>{usd(r.cost_usd)}</td>}
                <td className="px-3 py-2 text-slate-600">{new Date(r.created_at).toLocaleString()}</td>
              </tr>
            );
          })}
          {runs?.length === 0 && <tr><td colSpan={SHOW_COST ? 7 : 6} className="px-3 py-6 text-center text-slate-500" data-testid="runs-empty">No runs yet.</td></tr>}
        </tbody>
      </table>
      </div>
      <Pager page={page} perPage={perPage} total={total} sizes={[10, 25, 50, 100]} onPage={(p) => { setPage(p); setSelected(new Set()); }} onPerPage={(n) => { setPerPage(n); setPage(1); setSelected(new Set()); }} testid="runs-pager" />
      {/* The opened run: a panel that slides in over the right part of the page, the full height of the window.
          There is no backdrop: the rest of the page stays as it is and in use, as in a log viewer. */}
      {shownId != null && (
        <aside data-testid="run-panel" data-closing={closing} aria-label={`Run #${shownId}`} aria-hidden={closing || undefined}
          className={`fixed inset-y-0 right-0 z-50 flex flex-col border-l border-slate-300 bg-[#f6f7f9] shadow-2xl ${closing ? "slide-out-right" : "slide-in-right"}`} style={{ width: panelWidth }}>
          <div data-testid="run-panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize the run panel" title="Drag to resize"
            className={`absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none ${dragWidth !== null ? "bg-blue-500/30" : "hover:bg-blue-500/20"}`} onPointerDown={startResize} />
          <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-surface px-3 py-1.5 text-sm">
            <button type="button" data-testid="run-panel-prev" className="btn px-2 py-1" disabled={!neighbour(-1)} title="The run above in the list (arrow up)" onClick={() => { const r = neighbour(-1); if (r) go(`/runs/${r.id}`); }}>↑</button>
            <button type="button" data-testid="run-panel-next" className="btn px-2 py-1" disabled={!neighbour(1)} title="The run below in the list (arrow down)" onClick={() => { const r = neighbour(1); if (r) go(`/runs/${r.id}`); }}>↓</button>
            <span className="ml-2 text-xs text-slate-500">{openIndex >= 0 ? `${openIndex + 1} of ${runs?.length ?? 0} on this page` : closing ? "" : "not on this page of the list"}</span>
            <a data-testid="run-panel-full" className="btn ml-auto px-2 py-1" href={`#/runs/${shownId}/full`} title="Show this run on a page of its own">Open full page</a>
            <button type="button" data-testid="run-panel-close" className="btn px-2 py-1" aria-label="Close the run" title="Close (Escape)" onClick={closePanel}>✕</button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto" data-testid="run-panel-scroll">
            <RunDetail key={shownId} id={shownId} panel />
          </div>
        </aside>
      )}
      {confirming && <ConfirmDeleteRuns ids={[...selected].sort((a, b) => a - b)} onClose={() => setConfirming(false)} onDone={() => { setConfirming(false); setSelected(new Set()); setReload((n) => n + 1); }} />}
    </div>
  );
}

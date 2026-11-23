import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { agentList, api, get, getPage, tokenCount, usd } from "../api";
import { SHOW_COST } from "../features";
import { AsyncButton, ConfirmDeleteRuns, ErrorBox, FINISHED, go, Pager, readDraft, Status, TrashButton, useDraft, useWindowWidth } from "../ui";
import { blankInputs, inputTemplate, RunInputsEditor, type InputRef } from "../run-inputs";
import { RunDetail } from "./run-detail";
import { usePolling } from "../polling";
import { Button } from "../components/ui/button";
import { Select } from "../components/ui/select";
import { Card } from "../components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { Checkbox } from "../components/ui/checkbox";

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
  const [inputs, setInputs] = useDraft("new-run:inputs", "");
  const [only, setOnly] = useDraft("runs:filter", "");
  const [perPage, setPerPage] = useDraft("runs:per-page", 10);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** The ids the delete confirmation is about: the ticked runs, or the single row whose bin was pressed. */
  const [confirming, setConfirming] = useState<number[] | null>(null);
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
      // What was typed is cleared; the inputs' **shape** comes back, because the next run of this workflow is filled into
      // the same shape and typing it again was the complaint (15.116).
      setInputs(refs.length ? JSON.stringify(inputTemplate(refs), null, 2) : "");
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
      <Card className="mb-5" data-testid="new-run">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Start a run</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block min-w-0 flex-1 sm:max-w-sm">
            <span className="label">Workflow</span>
            <Select className="w-full" data-testid="new-run-workflow"  value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
              {workflows.length === 0 && <option value="">No workflows yet</option>}
              {workflows.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
            </Select>
          </label>
          <AsyncButton data-testid="new-run-start" variant="default" className="shrink-0" disabled={!workflow || noAgent} onClick={start}>Start run</AsyncButton>
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
      </Card>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">Show runs of</span>
          <Select className="w-56" data-testid="runs-filter"  value={only} onChange={(e) => { setOnly(e.target.value); setPage(1); setSelected(new Set()); }}>
            <option value="">all workflows</option>
            {workflows.map((w) => <option key={w.name} value={w.name}>{w.name}</option>)}
          </Select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          {selected.size > 0 && <span className="text-sm text-slate-600" data-testid="runs-selected">{selected.size} selected</span>}
          {/* A bin, not a filled red bar: this is a list, and the destructive action should not be its loudest control. The
              confirmation names what will go (asked 2026-11-22: "can we use a Bin icon button for deleting"). */}
          <TrashButton testid="runs-delete" disabled={!selected.size}
            label={selected.size ? `Delete ${selected.size} selected run${selected.size === 1 ? "" : "s"}` : "Delete the selected runs"}
            title={selected.size ? "Delete the ticked runs…" : "Tick finished runs to delete them"} onClick={() => setConfirming([...selected].sort((a, b) => a - b))} />
        </div>
      </div>
      <div className="overflow-x-auto rounded border border-slate-200 bg-surface">
      <Table className="w-full min-w-[640px] border-collapse text-sm" data-testid="runs-table">
        <TableHeader className="bg-slate-50 text-left text-xs uppercase text-slate-500">
          <TableRow>
            <TableHead className="w-10 px-3 py-2"><Checkbox data-testid="runs-select-all" aria-label="Select every finished run on this page" checked={allTicked} disabled={!deletable.length}
              onCheckedChange={(v) => setSelected(v ? new Set(deletable.map((r) => r.id)) : new Set())} /></TableHead>
            <TableHead className="px-3 py-2">Run</TableHead><TableHead className="px-3 py-2">Workflow</TableHead><TableHead className="px-3 py-2">Status</TableHead><TableHead className="px-3 py-2">Tokens</TableHead>{SHOW_COST && <TableHead className="px-3 py-2">Cost</TableHead>}<TableHead className="px-3 py-2">Created</TableHead><TableHead className="w-10 px-2 py-2"><span className="sr-only">Delete</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs?.map((r) => {
            const finished = FINISHED.includes(r.status);
            return (
              <TableRow key={r.id} data-testid={`run-row-${r.id}`} data-open={openId === r.id} aria-current={openId === r.id ? "true" : undefined}
                className={`cursor-pointer border-t border-slate-100 ${openId === r.id ? "bg-accent shadow-[inset_3px_0_0_var(--primary)]" : selected.has(r.id) ? "bg-accent" : "hover:bg-slate-50"}`} onClick={() => go(`/runs/${r.id}`)}>
                <TableCell className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <Checkbox data-testid={`run-select-${r.id}`} aria-label={`Select run #${r.id}`} checked={selected.has(r.id)} disabled={!finished}
                    title={finished ? undefined : "Only finished runs can be deleted: cancel the run first"} onCheckedChange={(v) => tick(r.id, !!v)} />
                </TableCell>
                <TableCell className="px-3 py-2 font-medium">#{r.id}</TableCell>
                <TableCell className="px-3 py-2">{r.workflow_name}</TableCell>
                <TableCell className="px-3 py-2"><Status value={r.status} /></TableCell>
                {/* "Tokens" is the label: the numbers are input and output tokens, in the run page's compact form. */}
                <TableCell className="mono whitespace-nowrap px-3 py-2 text-slate-600" data-testid={`run-tokens-${r.id}`} title="Input and output tokens">
                  {tokenCount(r.tokens_in)} in · {tokenCount(r.tokens_out)} out
                </TableCell>
                {SHOW_COST && <TableCell className="px-3 py-2 mono" data-testid={`run-cost-${r.id}`}>{usd(r.cost_usd)}</TableCell>}
                <TableCell className="px-3 py-2 text-slate-600">{new Date(r.created_at).toLocaleString()}</TableCell>
                <TableCell className="w-10 px-2 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                  {/* Only a finished run can be deleted — a run in flight is not a record yet, and the server refuses it. The
                      button is drawn for the ones it applies to instead of being shown dead on every row (task 15.90's rule). */}
                  {finished && (
                    <TrashButton testid={`run-delete-${r.id}`} size="sm" label={`Delete run #${r.id}`} onClick={() => setConfirming([r.id])} />
                  )}
                </TableCell>
              </TableRow>
            );
          })}
          {runs?.length === 0 && <TableRow><TableCell colSpan={SHOW_COST ? 7 : 6} className="px-3 py-6 text-center text-slate-500" data-testid="runs-empty">No runs yet.</TableCell></TableRow>}
        </TableBody>
      </Table>
      </div>
      <Pager page={page} perPage={perPage} total={total} sizes={[10, 25, 50, 100]} onPage={(p) => { setPage(p); setSelected(new Set()); }} onPerPage={(n) => { setPerPage(n); setPage(1); setSelected(new Set()); }} testid="runs-pager" />
      {/* The opened run: a panel that slides in over the right part of the page, the full height of the window.
          There is no backdrop: the rest of the page stays as it is and in use, as in a log viewer. */}
      {shownId != null && (
        <aside data-testid="run-panel" data-closing={closing} aria-label={`Run #${shownId}`} aria-hidden={closing || undefined}
          className={`fixed inset-y-0 right-0 z-50 flex flex-col border-l border-slate-300 bg-[#f6f7f9] shadow-2xl ${closing ? "slide-out-right" : "slide-in-right"}`} style={{ width: panelWidth }}>
          <div data-testid="run-panel-resize" role="separator" aria-orientation="vertical" aria-label="Resize the run panel" title="Drag to resize"
            className={`absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none ${dragWidth !== null ? "bg-primary/30" : "hover:bg-primary/20"}`} onPointerDown={startResize} />
          <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-surface px-3 py-1.5 text-sm">
            {/*
              * This strip is navigation, and every control in it is a glyph or a word — none of them is an action worth a box
              * (asked 2026-11-22, three times on this one row: "this should be a text/icon button only"). They were
              * `variant="outline"`, four bordered, filled, shadowed boxes in a 36 px bar, which made "close this run" and
              * "the run above" look like the page's primary actions. The arrows are **drawn**: `↑`/`↓` are characters that
              * render small and thin at text size, the same problem the designer's `«`/`»` had (task 15.88).
              */}
            <Button variant="ghost" className="h-8 w-8 px-0 text-slate-600" type="button" data-testid="run-panel-prev" disabled={!neighbour(-1)} title="The run above in the list (arrow up)" aria-label="The run above" onClick={() => { const r = neighbour(-1); if (r) go(`/runs/${r.id}`); }}>
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V4M4 7.5L8 3.5l4 4" /></svg>
            </Button>
            <Button variant="ghost" className="h-8 w-8 px-0 text-slate-600" type="button" data-testid="run-panel-next" disabled={!neighbour(1)} title="The run below in the list (arrow down)" aria-label="The run below" onClick={() => { const r = neighbour(1); if (r) go(`/runs/${r.id}`); }}>
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v9M4 8.5L8 12.5l4-4" /></svg>
            </Button>
            <span className="ml-2 text-xs text-slate-500">{openIndex >= 0 ? `${openIndex + 1} of ${runs?.length ?? 0} on this page` : closing ? "" : "not on this page of the list"}</span>
            <Button asChild variant="ghost" size="sm" className="ml-auto text-slate-600"><a data-testid="run-panel-full" href={`#/runs/${shownId}/full`} title="Show this run on a page of its own">Open full page</a></Button>
            <Button variant="ghost" className="h-8 w-8 px-0 text-slate-600" type="button" data-testid="run-panel-close" aria-label="Close the run" title="Close (Escape)" onClick={closePanel}>
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto" data-testid="run-panel-scroll">
            <RunDetail key={shownId} id={shownId} panel />
          </div>
        </aside>
      )}
      {confirming && <ConfirmDeleteRuns ids={confirming} onClose={() => setConfirming(null)} onDone={() => { setConfirming(null); setSelected(new Set()); setReload((n) => n + 1); }} />}
    </div>
  );
}

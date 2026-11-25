import { useCallback, useEffect, useState } from "react";
import { agentList, api, get, getPage, tokenCount, usd } from "../api";
import { SHOW_COST } from "../features";
import { ConfirmDeleteRuns, ErrorBox, FINISHED, go, hashQuery, Pager, PanelResizeHandle, readDraft, Status, TrashButton, useDraft, useRightPanelResize } from "../ui";
import { InputSetPanel, inputSetMissing, useInputSets, WorkflowPanel, type InputSet } from "../input-sets";
import { RunDetail } from "./run-detail";
import { usePolling } from "../polling";
import { Button } from "../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { Checkbox } from "../components/ui/checkbox";

/**
 * Runs — and the input data a run is given, which is the same page because it is the same act (15.124–15.126).
 *
 * Three things, and the order matters:
 *
 * - A **column of workflows** on the left, like the designer's building blocks: see them, choose one, open one in the
 *   designer, or make one — without leaving the page, and collapsible so the lists get the room.
 * - The page's own two tabs: **Collections** first, because a run starts from one, and **Runs** second, the record of
 *   what has been run. An **input data set** is the input data of one run, prepared over as many days as it takes
 *   (15.122); it has been called a case, then a collection, and now what the person called it, and it used to have a page of its own.
 * - A run opened in a panel over whichever list it was started from (`#/runs/37`), as before.
 */
export function Runs({ openId = null }: { openId?: number | null }) {
  const [workflows, setWorkflows] = useState<any[]>([]);
  /** The workflow the page is about: the panel's choice, which filters both lists and names a new set's workflow. */
  const [focus, setFocus] = useDraft("runs:workflow", "");
  const [panelOpen, setPanelOpen] = useDraft("runs:workflows-open", true);
  /**
   * The page opens on **Collections**, because that is the view it is for (asked 2026-11-24: *"the default view will be
   * the input data collections listing"*). Not kept in a draft — a sticky tab means a person who opened Runs yesterday
   * lands on yesterday's list — but it **is** in the address, so that a link which means "the record" can say so:
   * `#/runs` is the input data and `#/runs?tab=runs` is the past runs, which is what "← All runs" and the route from a
   * run's own page use (found 2026-11-25: that link landed on the input data instead).
   */
  const [tab, setTab] = useState<"input-sets" | "runs">(() => (hashQuery().get("tab") === "runs" ? "runs" : "input-sets"));
  const [error, setError] = useState<string | null>(null);
  /** True when no agent CLI is set up: a run cannot start, and the button says why (task 15.15). */
  const [noAgent, setNoAgent] = useState(false);
  const [noAgentWhy, setNoAgentWhy] = useState("");

  /**
   * Read the workflow list again. The panel draws a count of collections on each card, and a count that is only read
   * when the page loads is a count that is wrong the moment anything is created — which is exactly what was reported
   * (2026-11-25: *"i had to manually refresh the page to see the collection listing and counter updated"*).
   */
  const refreshWorkflows = useCallback(() => get("/api/workflows").then((w) => {
    setWorkflows(w);
    // A workflow that no longer exists is not a filter: fall back to all of them.
    setFocus((cur) => (cur && !w.some((x: any) => x.name === cur) ? "" : cur));
  }).catch(() => {}), [setFocus]);

  useEffect(() => { void refreshWorkflows();
    get("/api/meta").then((m) => {
      const none = Array.isArray(m?.usable_adapters) && m.usable_adapters.length === 0;
      const found: string[] = Array.isArray(m?.found_providers) ? m.found_providers : [];
      setNoAgent(none);
      setNoAgentWhy(none ? (found.length ? `Every agent CLI is switched off (${agentList(found)} ${found.length === 1 ? "was" : "were"} found), so a run cannot start.` : "No agent CLI is installed, so a run cannot start.") : "");
    }).catch(() => {});
  }, [refreshWorkflows]);

  // ── input data: the values of a run, prepared and then run ────────────────
  const { rows: inputSets, total: setsCount, loading: setsLoading, error: setsError, reload: reloadInputSets } = useInputSets(focus);
  const [colPage, setColPage] = useState(1);
  const [colPerPage, setColPerPage] = useDraft("runs:input-sets-per-page", 25);
  /** Which row opened the panel: an id, "new", or nothing. */
  const [editing, setEditing] = useState<number | "new" | null>(null);
  /**
   * The set the open panel has **become**, once its first change created one. Kept apart from `editing` on purpose: the
   * panel is keyed by `editing`, so writing the new id there remounted it — and remounting threw away what was being
   * typed the moment it was first saved (found 2026-11-25 by watching the panel lose a field).
   */
  const [panelId, setPanelId] = useState<number | null>(null);
  useEffect(() => { setColPage(1); }, [focus]);

  // ── runs: the record of what has been run ─────────────────────────────────
  const [runs, setRuns] = useState<any[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useDraft("runs:per-page", 10);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** The ids the delete confirmation is about: the ticked runs, or the single row whose bin was pressed. */
  const [confirming, setConfirming] = useState<number[] | null>(null);
  useEffect(() => { setPage(1); setSelected(new Set()); }, [focus]);

  const load = useCallback(() => getPage(focus ? `/api/runs?workflow=${encodeURIComponent(focus)}` : "/api/runs", page, perPage).then(({ items, total }) => {
    // A page that emptied (runs deleted, a smaller total) moves back to the last page that has runs.
    const last = Math.max(1, Math.ceil(total / perPage));
    if (page > last) return setPage(last);
    setRuns(items); setTotal(total);
    setSelected((cur) => new Set([...cur].filter((id) => items.some((r: any) => r.id === id && FINISHED.includes(r.status)))));
  }).catch((e) => setError(e.message)), [focus, page, perPage]);
  usePolling(load, 2000, [load]);

  // ── the panel with the opened run ─────────────────────────────────────────
  const runPanelResize = useRightPanelResize({
    draftKey: "ui:run-panel-width",
    defaultWidth: (vw) => Math.round(vw * 0.66),
    minWidth: 520,
    maxWidth: (vw) => Math.max(520, vw - 300),
  });
  /** Closing a run goes back to the list it was opened from — the record, not the collections. */
  const closePanel = () => go("/runs?tab=runs");
  // The panel slides in from the right and out again. While it slides out it still shows the run that
  // was open, so `shownId` lags behind `openId` by the length of that movement.
  const [shownId, setShownId] = useState<number | null>(openId);
  useEffect(() => {
    if (openId != null) { setShownId(openId); setTab("runs"); return; }
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

  const removeSet = async (c: InputSet) => {
    try {
      await api("DELETE", `/api/input-sets/${c.id}`);
      if (editing === c.id) setEditing(null);
      reloadInputSets();
      void refreshWorkflows();
    } catch (e: any) { setError(e.message); }
  };

  const openedSet = editing !== null && editing !== "new" ? (inputSets.find((c) => c.id === editing) ?? null) : null;
  const highlighted = editing === "new" ? panelId : editing;

  const startFromSet = async (c: InputSet) => {
    setError(null);
    try {
      const d = await api("POST", "/api/runs", { workflow: c.workflow, input_set: c.id });
      setTab("runs");
      go(`/runs/${d.run.id}`);
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="flex h-full min-h-0" data-testid="runs-layout">
      <WorkflowPanel workflows={workflows} selected={focus} onSelect={setFocus} open={!!panelOpen} setOpen={setPanelOpen} />
      <div className="page-width min-h-0 min-w-0 flex-1 overflow-y-auto py-6" data-testid="page-column">
        <h1 className="mb-3 text-xl font-semibold">Runs</h1>
        <ErrorBox error={error} />
        {/* Above the tabs: a run cannot start at all, which is true of both of them. */}
        {noAgent && (
          <p data-testid="new-run-no-agent" className="mb-2 text-xs text-red-800">
            {noAgentWhy} <a className="underline" href="#/settings">Open Settings › Agent CLIs</a>.
          </p>
        )}
        <Tabs value={tab} onValueChange={(v) => {
            const next = v as "input-sets" | "runs";
            setTab(next);
            // The address follows the tab, so a refresh — or a bookmark — lands on the same view.
            const hash = window.location.hash.split("?")[0] || "#/runs";
            window.history.replaceState(null, "", next === "runs" ? `${hash}?tab=runs` : hash);
          }} data-testid="runs-tabs" data-tab={tab}>
          <TabsList aria-label="Input data and past runs" data-testid="runs-tabs-list" className="mb-3 h-9 gap-0.5 border border-slate-300 bg-slate-100 p-0.5">
            <TabsTrigger value="input-sets" data-testid="runs-tab-input-sets"
              className="px-3 text-sm font-medium text-slate-600 data-[state=active]:bg-surface data-[state=active]:font-semibold data-[state=active]:text-slate-900 data-[state=active]:shadow-sm">
              Input data
            </TabsTrigger>
            <TabsTrigger value="runs" data-testid="runs-tab-runs"
              className="px-3 text-sm font-medium text-slate-600 data-[state=active]:bg-surface data-[state=active]:font-semibold data-[state=active]:text-slate-900 data-[state=active]:shadow-sm">
              Runs{total ? <span className="ml-1.5 text-2xs font-normal text-slate-500">{total}</span> : null}
            </TabsTrigger>
          </TabsList>

          {/* ── Collections: the input data of a run, prepared here and started from here ── */}
          <TabsContent value="input-sets" data-testid="runs-pane-input-sets" className="mt-0">
            <ErrorBox error={setsError} testid="input-sets-error" />
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 text-sm text-slate-600">
                The input values a run of a workflow is given. Prepare one over as many days as it takes, leave what you do not have yet empty, and start the run when it is ready.
              </p>
              <Button variant="default" data-testid="new-run-new" disabled={!workflows.length} onClick={() => { setEditing("new"); setPanelId(null); }}>New input data set</Button>
            </div>
            {editing !== null && (
              <InputSetPanel key={String(editing)} id={editing === "new" ? null : editing} existing={openedSet}
                workflows={workflows} defaultWorkflow={focus} blocked={noAgent ? { why: noAgentWhy } : undefined}
                onClose={() => { setEditing(null); setPanelId(null); }}
                onSaved={(c) => {
                  // It saves itself as the person types, so the list and the workflow column's count follow every
                  // write — and the panel stays open and **unmounted-free**, because that is where the person is working.
                  setPanelId(c.id);
                  setColPage(1);
                  reloadInputSets(1, colPerPage);
                  void refreshWorkflows();
                }}
                onStarted={(runId) => { setEditing(null); setPanelId(null); reloadInputSets(1, colPerPage); void refreshWorkflows(); setTab("runs"); go(`/runs/${runId}`); }} />
            )}
            <div className="overflow-x-auto rounded border border-slate-200 bg-surface">
              <Table className="w-full min-w-[640px] border-collapse text-sm" data-testid="input-sets-table">
                <TableHeader className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <TableRow>
                    <TableHead className="px-3 py-2">Input data set</TableHead>
                    <TableHead className="px-3 py-2">Workflow</TableHead>
                    <TableHead className="px-3 py-2">Prepared</TableHead>
                    <TableHead className="px-3 py-2">Ready</TableHead>
                    <TableHead className="px-3 py-2">Last prepared</TableHead>
                    <TableHead className="w-24 px-2 py-2"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {setsLoading && <TableRow><TableCell colSpan={6} className="px-3 py-6 text-center text-slate-500">Loading…</TableCell></TableRow>}
                  {!setsLoading && inputSets.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="px-3 py-6 text-center text-slate-500" data-testid="input-sets-empty">
                      Nothing prepared yet. Press <b>New input data set</b>: it is kept until a run is started from it, however long the data takes to arrive.
                    </TableCell></TableRow>
                  )}
                  {inputSets.map((c) => {
                    const missing = inputSetMissing(c);
                    return (
                      <TableRow key={c.id} data-testid={`input-set-row-${c.id}`} data-ready={c.ready}
                        className={`cursor-pointer border-t border-slate-100 ${highlighted === c.id ? "bg-accent shadow-[inset_3px_0_0_var(--primary)]" : "hover:bg-slate-50"}`}
                        onClick={() => { setEditing(c.id); setPanelId(c.id); }}>
                        <TableCell className="px-3 py-2">
                          <div className="font-medium" data-testid={`input-set-name-${c.id}`}>{c.name}</div>
                          <div className="mono text-2xs text-slate-400" title="This set's number: quote it to chief bot and it knows which one you mean">#{c.id}</div>
                        </TableCell>
                        <TableCell className="px-3 py-2 text-slate-700">{c.workflow}</TableCell>
                        <TableCell className="px-3 py-2 text-slate-600" data-testid={`input-set-filled-${c.id}`}>{c.filled} of {c.fields} {c.fields === 1 ? "field" : "fields"}</TableCell>
                        <TableCell className="px-3 py-2" data-testid={`input-set-ready-${c.id}`}>
                          {c.workflow_archived
                            ? <span className="text-xs text-slate-500">workflow archived</span>
                            : c.ready
                              ? <span className="inline-block rounded bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">ready</span>
                              : <span className="text-xs text-amber-800" title={`Still needed: ${missing.join(", ")}`}>needs {missing.length === 1 ? missing[0] : `${missing.length} values`}</span>}
                        </TableCell>
                        <TableCell className="px-3 py-2 text-slate-600">{new Date(c.updated_at).toLocaleString()}</TableCell>
                        <TableCell className="whitespace-nowrap px-2 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                          {c.ready && !c.workflow_archived && (
                            <Button variant="link" size="sm" className="h-auto px-1 text-xs" data-testid={`input-set-start-${c.id}`}
                              title={`Start a run of ${c.workflow} with this input data set`} onClick={() => void startFromSet(c)}>Start</Button>
                          )}
                          <TrashButton testid={`input-set-remove-${c.id}`} size="sm" label={`Remove the input data set “${c.name}”`}
                            title="Remove this set. Runs started from it keep their own copy of the values" onClick={() => void removeSet(c)} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <Pager testid="input-sets-pager" page={colPage} perPage={colPerPage} total={setsCount}
              onPage={(p) => { setColPage(p); reloadInputSets(p, colPerPage); }} onPerPage={(n) => { setColPerPage(n); setColPage(1); reloadInputSets(1, n); }} />
          </TabsContent>

          {/* ── Runs: the record ─────────────────────────────────────────────── */}
          <TabsContent value="runs" data-testid="runs-pane-runs" className="mt-0">
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <span className="text-sm text-slate-600">{focus ? `Runs of ${focus}` : "Every run, newest first"}</span>
              <div className="ml-auto flex items-center gap-2">
                {selected.size > 0 && <span className="text-sm text-slate-600" data-testid="runs-selected">{selected.size} selected</span>}
                {/* A bin, not a filled red bar: this is a list, and the destructive action should not be its loudest control. */}
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
                        <TableCell className="mono whitespace-nowrap px-3 py-2 text-slate-600" data-testid={`run-tokens-${r.id}`} title="Input and output tokens">
                          {tokenCount(r.tokens_in)} in · {tokenCount(r.tokens_out)} out
                        </TableCell>
                        {SHOW_COST && <TableCell className="px-3 py-2 mono" data-testid={`run-cost-${r.id}`}>{usd(r.cost_usd)}</TableCell>}
                        <TableCell className="px-3 py-2 text-slate-600">{new Date(r.created_at).toLocaleString()}</TableCell>
                        <TableCell className="w-10 px-2 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                          {/* Only a finished run can be deleted — a run in flight is not a record yet, and the server refuses it. */}
                          {finished && <TrashButton testid={`run-delete-${r.id}`} size="sm" label={`Delete run #${r.id}`} onClick={() => setConfirming([r.id])} />}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {runs?.length === 0 && <TableRow><TableCell colSpan={SHOW_COST ? 7 : 6} className="px-3 py-6 text-center text-slate-500" data-testid="runs-empty">No runs yet.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>
            <Pager page={page} perPage={perPage} total={total} sizes={[10, 25, 50, 100]} onPage={(p) => { setPage(p); setSelected(new Set()); }} onPerPage={(n) => { setPerPage(n); setPage(1); setSelected(new Set()); }} testid="runs-pager" />
            {focus && readDraft(`designer:${focus}`) && (
              <div data-testid="new-run-unsaved" className="mt-3 text-xs text-amber-800">
                “{focus}” has changes in the designer that are not a valid workflow yet. A run uses its last valid version. <a className="underline" href={`#/designer/${encodeURIComponent(focus)}`}>Open the designer</a>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
      {/* The opened run: a panel that slides in over the right part of the page, the full height of the window.
          There is no backdrop: the rest of the page stays as it is and in use, as in a log viewer. */}
      {shownId != null && (
        <aside data-testid="run-panel" data-closing={closing} aria-label={`Run #${shownId}`} aria-hidden={closing || undefined}
          className={`fixed inset-y-0 right-0 z-50 flex flex-col border-l border-slate-300 bg-page shadow-2xl ${closing ? "slide-out-right" : "slide-in-right"}`} style={{ width: runPanelResize.width }}>
          <PanelResizeHandle testid="run-panel-resize" label="Resize the run panel" resize={runPanelResize} />
          <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-surface px-3 py-1.5 text-sm">
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
      {confirming && <ConfirmDeleteRuns ids={confirming} onClose={() => setConfirming(null)} onDone={() => { setConfirming(null); setSelected(new Set()); void load(); }} />}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { api, get, pretty, tokenCount, usd } from "../api";
import { AsyncButton, ConfirmDeleteRuns, ErrorBox, go, readDraft, removeDraft, Status, writeDraft } from "../ui";
import { SHOW_BUDGETS, SHOW_COST } from "../features";
import { GateCard } from "./gates";
import { Preview, TextSection } from "../text-view";
import { JsonCode } from "../json-editor";
import { Replay } from "./replay";
import { ModelSelect } from "../designer/panel";
import { RunDiagram } from "../run-diagram";
import { mergeInputs } from "../run-inputs";
import { usePolling, useReveal } from "../polling";

const TERMINAL = ["completed", "failed", "reverted", "cancelled"];
/** Errors that mean the model's context window was too small for what the step had to read. */
const CONTEXT_ERROR = /context (window|length|limit)|prompt is too long|too many tokens|maximum context|input (is )?too long|exceeds? (the )?(model'?s? )?(maximum )?context/i;
/** Run statuses in which a step that has not completed may be changed before resuming (see STOPPED_RUN in ops.ts). */
const STOPPED = ["failed", "paused", "interrupted", "waiting_gate"];

const IN_LABEL: Record<string, string> = { prompt: "Input: prompt sent to the agent", stdin: "Input: sent to the script", gate_question: "Input: what you were asked" };
/** The first lines of a text, for the compact view on a node. */
const preview = (t: string | null | undefined, max = 420) => (!t ? "" : t.length > max ? t.slice(0, max) + " …" : t);
/** For the compact view: the prompt as the author wrote it, without what chief appends for every agent (the full text is in the details). */
const ownPrompt = (t: string | null | undefined) => (t ?? "").split(/\n---\n(?:Output contract|You are undoing earlier work|Results of earlier steps)/)[0].split("\n\nMCP servers available to you in this session:")[0];

/** Subscribe to the run's SSE stream; calls back for every event. Returns when the stream ends. */
async function streamEvents(runId: number, after: number, onEvent: (e: any) => void, signal: AbortSignal) {
  const res = await fetch(`/api/runs/${runId}/events?after=${after}`, { signal, headers: { Accept: "text/event-stream" } });
  if (!res.ok || !res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const name = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (name === "end") return;
      if (data) { try { onEvent(JSON.parse(data)); } catch { /* ignore malformed */ } }
    }
  }
}

/** One run. On its own page, or (`panel`) inside the panel that the run list opens beside itself. */
export function RunDetail({ id, panel = false }: { id: number; panel?: boolean }) {
  const [d, setD] = useState<any | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [report, setReport] = useState<any | null>(null);
  const [revertTo, setRevertTo] = useState("");
  const [defaultAdapter, setDefaultAdapter] = useState("claude-code");
  const [openPending, setOpenPending] = useState<string | null>(null);
  /** Scrolls a row into view after it renders (see polling.ts). */
  const reveal = useReveal();
  useEffect(() => { get("/api/meta").then((m) => m?.default_adapter && setDefaultAdapter(m.default_adapter)).catch(() => {}); }, []);

  const [confirmDelete, setConfirmDelete] = useState(false);
  /** Resume normally takes the designer's newer prompt and model for unfinished steps; this keeps the run's own. */
  const [keepOwn, setKeepOwn] = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  const lastEvent = useRef(0);

  const load = useCallback(() => get(`/api/runs/${id}`).then(setD).catch((e) => setError(e.message)), [id]);

  // Live updates: every event from the stream triggers a refetch of the run.
  useEffect(() => {
    const ctl = new AbortController();
    let pending: ReturnType<typeof setTimeout> | undefined;
    load();
    streamEvents(id, lastEvent.current, (e) => {
      lastEvent.current = Math.max(lastEvent.current, e.id);
      setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e]));
      clearTimeout(pending);
      pending = setTimeout(load, 60);
    }, ctl.signal).then(load).catch(() => {});
    return () => { ctl.abort(); clearTimeout(pending); };
  }, [id, load, streamKey]);

  // A stopped run has no events, but things around it still change: the workflow is edited in the
  // designer, a gate is answered elsewhere, another process resumes it. So the page keeps asking:
  // at once when the tab or window is looked at again, and every few seconds while the run is stopped.
  //
  // A running run is followed by the event stream, and this is the safety net under it: a stream can end
  // (a proxy, a sleeping laptop, a server restart) and then the page would show "running" for ever — it
  // looked exactly like a cancel that never arrived until the panel was closed and reopened (task 15.23).
  // Slower than the stream, so the two do not fight, and it costs one small request (the record's inputs
  // are read by `runInputs`, not the whole transcript).
  const stopped = !!d && STOPPED.includes(d.run.status);
  const look = useCallback(() => { if (document.visibilityState === "visible") void load(); }, [load]);
  useEffect(() => {
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    return () => { window.removeEventListener("focus", look); document.removeEventListener("visibilitychange", look); };
  }, [look]);
  usePolling(look, stopped ? 3000 : 10_000);

  /**
   * Pause, resume, cancel, revert. The button's spinner follows the request, not the page's reload: the
   * reload of a big run's record can take seconds, and awaiting it made Cancel look stuck after the
   * cancellation had already happened (task 15.23). The status above is what shows the run stopping; the
   * button reads "Cancelling…" while the server reports that a cancel was requested.
   */
  const act = async (action: string, body?: unknown) => {
    setError(null);
    try {
      const r = await api("POST", `/api/runs/${id}/${action}`, body);
      if (action === "revert") setReport(r);
    } catch (e: any) {
      setError(e.message);
      return;
    }
    // The record is fetched again in the background: one now, so the status is not stale, and the events
    // that follow (a new stream) bring it up to date.
    void load();
    setStreamKey((k) => k + 1);
  };

  /** Run again: a new run of the same workflow with this run's inputs; the page goes to it. */
  const rerun = async () => {
    setError(null);
    try { const r = await api("POST", `/api/runs/${id}/rerun`); go(`/runs/${r.run.id}`); }
    catch (e: any) { setError(e.message); }
  };

  if (!d) return <div className="p-6"><ErrorBox error={error} />Loading…</div>;
  const { run } = d;
  const s: string = run.status;
  const waiting = d.gates.filter((g: any) => g.status === "waiting");
  // A gate is answered where it is in the run: inside the row of the step that waits. Only a gate
  // that belongs to no step (a budget stop) is shown above the steps.
  const stepIds = new Set(d.node_runs.map((n: any) => n.id));
  const gatesOf = (nodeRunId: number) => waiting.filter((g: any) => g.node_run_id === nodeRunId);
  const loose = waiting.filter((g: any) => g.node_run_id == null || !stepIds.has(g.node_run_id));
  const inSteps = waiting.filter((g: any) => !loose.includes(g));
  const answered = () => { load(); setStreamKey((k) => k + 1); };
  const topLevel: string[] = (run.definition?.nodes ?? []).map((n: any) => n.id);
  const children = (parentId: number) => d.node_runs.filter((n: any) => n.parent_node_run_id === parentId);
  const roots = d.node_runs.filter((n: any) => n.parent_node_run_id == null);

  /** Top-level steps of the run's workflow that have no attempt yet. */
  const notStarted = (run.definition?.nodes ?? []).filter((d: any) => !roots.some((n: any) => n.node_id === d.id));
  /** The same step in the workflow as it is now, when the workflow changed after the run started. */
  const currentStep = (nodeId: string) => {
    if (!d.current) return null;
    const c = (d.current.nodes ?? []).find((x: any) => x.id === nodeId);
    const step = c?.type === "map" ? c.node : c;
    return step?.type === "agent" ? { version: d.current.version, prompt: step.prompt ?? "", model: step.model ?? null } : null;
  };
  /** The step's definition in this run (for a map, its inner agent step). */
  const stepDef = (n: any) => {
    const def = (run.definition?.nodes ?? []).find((x: any) => x.id === n.node_id);
    return def?.type === "map" ? def.node : def;
  };
  const stepAdapter = (n: any) => stepDef(n)?.agent ?? run.definition?.agent ?? defaultAdapter;
  /**
   * Agent steps of this stopped run that have not completed and whose prompt or model differs in
   * the workflow as it is now. A run keeps the workflow it started with, so a fix made in the
   * designer does not reach it by itself: it is offered here, in one click.
   */
  const outdated: { id: string; patch: { prompt?: string; model?: string | null } }[] = !STOPPED.includes(s) || !d.current ? [] : (run.definition?.nodes ?? []).flatMap((def: any) => {
    const mine = def.type === "map" ? def.node : def;
    const cur = currentStep(def.id);
    const latest = roots.filter((n: any) => n.node_id === def.id && n.phase === "forward").sort((a: any, b: any) => b.id - a.id)[0];
    if (!cur || mine?.type !== "agent" || latest?.status === "completed") return [];
    const patch: { prompt?: string; model?: string | null } = {};
    if (cur.prompt && cur.prompt !== (mine.prompt ?? "")) patch.prompt = cur.prompt;
    if ((cur.model ?? null) !== (mine.model ?? null)) patch.model = cur.model;
    return Object.keys(patch).length ? [{ id: def.id, patch }] : [];
  });
  /**
   * Resume. Steps that were fixed in the designer since the run started are brought up to the
   * workflow's current version first (unless the user chose to keep the run's own), so "fix the
   * prompt, press Resume" works. Each change is written to the run's record by the server.
   */
  const resume = async () => {
    setError(null);
    if (!keepOwn) {
      try { for (const o of outdated) await api("POST", `/api/runs/${id}/steps/${encodeURIComponent(o.id)}`, o.patch); }
      catch (e: any) { setError(`The steps could not be brought up to version ${d.current?.version}, so the run was not resumed: ${e.message}`); await load(); return; }
    }
    await act("resume");
  };
  /** The inputs the run ran with: its own values over the workflow's defaults. */
  const usedInputs = mergeInputs(run.definition?.inputs, run.inputs);
  /** Open a step's row from the diagram: its latest attempt, or its entry under "Not started yet". */
  const openStep = (nodeId: string) => {
    const latest = roots.filter((n: any) => n.node_id === nodeId && n.phase === "forward").sort((a: any, b: any) => b.id - a.id)[0];
    const target = latest ? `node-run-${latest.id}` : `pending-step-${nodeId}`;
    if (latest) setOpen(latest.id); else setOpenPending(nodeId);
    reveal(target); // scrolls after the row is rendered, instead of racing it with a zero-delay timer
  };
  /** A top-level agent step that has not completed, in a run that is stopped: its model may be changed. */
  const changeable = (n: any) => n.parent_node_run_id == null && n.phase === "forward" && n.status !== "completed" && STOPPED.includes(s) && stepDef(n)?.type === "agent";

  const row = (n: any, depth: number) => {
    const u = n.usage;
    return (
      <div key={n.id}>
        {/* The whole row opens the node's details. The arrow and the highlight show that, and whether it is open. */}
        <button data-testid={`node-run-${n.id}`} data-node-id={n.node_id} data-status={n.status} data-phase={n.phase} data-item={n.item_index ?? ""}
          aria-expanded={open === n.id} data-open={open === n.id} title={open === n.id ? "Hide the details" : "Show the full input and output"}
          className={`flex w-full items-center gap-3 border-l-4 border-t border-t-slate-100 px-3 py-2 text-left text-sm ${open === n.id ? "border-l-blue-600 bg-blue-50" : "border-l-transparent hover:bg-slate-50"}`} style={{ paddingLeft: 8 + depth * 24 }}
          onClick={() => setOpen(open === n.id ? null : n.id)}>
          <span data-testid={`node-arrow-${n.id}`} aria-hidden="true" className={`w-3 shrink-0 text-xs ${open === n.id ? "text-blue-700" : "text-slate-400"}`}>{open === n.id ? "▾" : "▸"}</span>
          <span className="w-64 truncate font-medium">
            {n.node_id}{n.item_index != null ? `[${n.item_index}]` : ""}
            {n.phase === "compensate" && <span className="ml-2 rounded bg-orange-100 px-1.5 text-xs text-orange-800">compensate</span>}
            {n.attempt > 1 && <span className="ml-2 text-xs text-slate-500">try {n.attempt}</span>}
          </span>
          <span className="w-14 text-xs text-slate-500">{n.node_type}</span>
          <Status value={n.status} />
          <span className="mono ml-auto text-xs text-slate-600" data-testid={`node-usage-${n.id}`}>
            {[u ? `${u.input_tokens + u.cache_read_tokens + u.cache_write_tokens} in · ${u.output_tokens} out${SHOW_COST ? ` · ${usd(u.cost_usd)}` : ""}` : "", n.input?.est_tokens ? `prompt ~${n.input.est_tokens} tok` : ""].filter(Boolean).join(" · ")}
          </span>
          <span className="w-16 shrink-0 text-right text-xs text-blue-700">{open === n.id ? "Hide" : "Details"}</span>
        </button>
        {/* What went in and what came out, on the node itself. Click the node for the full text. */}
        {open !== n.id && (n.io?.input != null || n.output != null || n.error) && (
          <div data-testid={`node-io-${n.id}`} className="grid cursor-pointer grid-cols-1 gap-2 px-3 pb-2 text-xs sm:grid-cols-2" style={{ paddingLeft: 12 + depth * 24 }} onClick={() => setOpen(n.id)} title="Click for the full input and output">
            <div className="min-w-0">
              <div className="text-2xs font-semibold uppercase tracking-wide text-slate-400">{IN_LABEL[n.io?.input_kind] ?? "Input"}</div>
              <Preview testid={`node-in-${n.id}`}>{preview(n.io?.input_kind === "prompt" ? ownPrompt(n.io?.input) : n.io?.input) || "(nothing recorded)"}</Preview>
            </div>
            <div className="min-w-0">
              <div className="text-2xs font-semibold uppercase tracking-wide text-slate-400">{n.error ? "Error" : n.node_type === "gate" ? "Answer → output" : "Output"}</div>
              {n.io?.reply && n.io.reply.length > 200 && <div data-testid={`node-reply-note-${n.id}`} className="mb-0.5 text-2xs text-amber-800">This step also wrote {n.io.reply.length} characters of text besides its result (click to read; later steps are given it too).</div>}
              <Preview testid={`node-out-${n.id}`} error={!!n.error}>{n.error ? preview(n.error) : n.output == null ? (n.status === "waiting_gate" ? "(waiting for your answer)" : "(none yet)") : preview(pretty(n.output))}</Preview>
            </div>
          </div>
        )}
        {open !== n.id && changeable(n) && n.status === "failed" && (
          <div data-testid={`node-failed-help-${n.id}`} className="px-3 pb-2 text-xs text-red-800" style={{ paddingLeft: 12 + depth * 24 }}>
            {CONTEXT_ERROR.test(n.error ?? "") ? "This step ran out of room in the model's context window. " : "This step failed. "}
            <button type="button" className="font-medium text-blue-700 underline" onClick={() => setOpen(n.id)}>Change its model</button>, then press Resume: only this step and the ones after it run again.
          </div>
        )}
        {gatesOf(n.id).map((g: any) => (
          <div key={g.id} data-testid={`node-gate-${n.id}`} className="px-3 pb-3" style={{ paddingLeft: 12 + depth * 24 }}>
            <GateCard gate={g} onAnswered={answered} onChangeStep={g.reason === "needs_input" && changeable(n) ? () => setOpen(n.id) : undefined} />
          </div>
        ))}
        {open === n.id && (
          <div data-testid="node-details" data-for={n.node_id} className="border-l-4 border-l-blue-600 bg-blue-50/40 px-4 py-3 text-xs" style={{ paddingLeft: 16 + depth * 24 }}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-blue-900" data-testid="node-details-title">Details of {n.node_id}{n.item_index != null ? `[${n.item_index}]` : ""} <span className="font-normal text-slate-600">({n.node_type}, {String(n.status).replace("_", " ")})</span></span>
              <button data-testid="node-details-hide" className="btn" onClick={() => setOpen(null)}>Hide details</button>
            </div>
            {n.error && <div className="mb-2 whitespace-pre-wrap text-red-700" data-testid="node-error">{n.error}</div>}
            {changeable(n) && (
              <StepEditor runId={id} nodeId={n.node_id} def={stepDef(n)} adapter={stepAdapter(n)} status={n.status} error={n.error} onSaved={load} current={currentStep(n.node_id)} />
            )}
            {/* A prompt and what a step wrote are usually markdown: shown formatted, with the raw text one click away. */}
            <TextSection label={IN_LABEL[n.io?.input_kind] ?? "Input"} text={n.io?.input} testid="node-input" markdown={n.io?.input_kind === "prompt"} empty="(nothing recorded)" />
            {n.io?.answer && <TextSection label="Your answer" text={n.io.answer} testid="node-answer" />}
            {n.io?.reply && <TextSection label="Text the step wrote besides its result" text={n.io.reply} testid="node-reply" markdown />}
            <TextSection label="Output (the result that is passed on)" text={n.output == null ? null : pretty(n.output)} testid="node-output" />
            {n.session_id && <div className="text-slate-500">session {n.session_id}{u?.model ? ` · ${u.model}` : ""}{u ? ` · ${u.invocations} invocation${u.invocations === 1 ? "" : "s"}` : ""}</div>}
          </div>
        )}
        {n.phase === "forward" && children(n.id).map((c: any) => row(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className={panel ? "px-5 py-4" : "page-width py-6"} data-testid={panel ? "run-panel-body" : "page-column"}>
      {!panel && <a href="#/runs" className="text-sm text-blue-700 underline">← All runs</a>}
      <div className="mb-4 mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold" data-testid="run-title">Run #{run.id} · {run.workflow_name} v{run.workflow_version}</h1>
        <Status value={s} testid="run-status" />
        <span className="mono whitespace-nowrap text-sm text-slate-600" data-testid="run-totals">
          {tokenCount(run.tokens_in)} tokens in · {tokenCount(run.tokens_out)} tokens out{SHOW_COST ? ` · ${usd(run.cost_usd)}` : ""}{SHOW_BUDGETS && d.budget?.["max-usd"] ? ` of ${usd(d.budget["max-usd"])}` : ""}
        </span>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <AsyncButton data-testid="btn-pause" className="btn" disabled={!["pending", "running", "waiting_gate", "interrupted"].includes(s)} onClick={() => act("pause")}>Pause</AsyncButton>
          <AsyncButton data-testid="btn-resume" className="btn" disabled={!["paused", "interrupted", "failed"].includes(s)} onClick={resume}>Resume</AsyncButton>
          <AsyncButton data-testid="btn-rerun" className="btn" title="Start a new run of this workflow with the inputs this run ran with. This run stays as it is" onClick={rerun}>Run again</AsyncButton>
          <AsyncButton data-testid="btn-cancel" className="btn btn-danger" disabled={TERMINAL.includes(s) || s === "reverting" || run.requested_action === "cancel"} onClick={() => act("cancel")}>
            {run.requested_action === "cancel" ? "Cancelling…" : "Cancel"}
          </AsyncButton>
          {TERMINAL.includes(s) && <button data-testid="btn-delete-run" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>Delete</button>}
        </div>
        {confirmDelete && <ConfirmDeleteRuns ids={[run.id]} onClose={() => setConfirmDelete(false)} onDone={() => go("/runs")} />}
      </div>
      <ErrorBox error={error ?? (run.error && s === "failed" ? run.error : null)} testid="run-error" />

      {outdated.length > 0 && (
        <div data-testid="run-outdated" className="mb-4 flex flex-wrap items-center gap-2 rounded border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900">
          {keepOwn
            ? <span>Resume will run {outdated.length === 1 ? "step" : "steps"} <b>{outdated.map((o) => o.id).join(", ")}</b> as {outdated.length === 1 ? "it was" : "they were"} when this run started (version {run.workflow_version}), not as changed in the designer since (version {d.current.version}).</span>
            : <span>{outdated.length === 1 ? "Step" : "Steps"} <b>{outdated.map((o) => o.id).join(", ")}</b> {outdated.length === 1 ? "was" : "were"} changed in the designer since this run started. <b>Resume will use the new version</b> (version {d.current.version}) for {outdated.length === 1 ? "it" : "them"}. Completed steps keep their results.</span>}
          <button type="button" data-testid="run-keep-own" className="btn" onClick={() => setKeepOwn(!keepOwn)}>{keepOwn ? `Use version ${d.current.version} instead` : "Keep this run's version"}</button>
        </div>
      )}
      {loose.map((g: any) => <GateCard key={g.id} gate={g} onAnswered={answered} />)}
      {inSteps.length > 0 && (
        <div data-testid="gate-notice" className="mb-4 flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>This run is waiting for your answer at {inSteps.length === 1 ? "step" : "steps"} <b>{inSteps.map((g: any) => g.node_id ?? "?").join(", ")}</b>.</span>
          <button data-testid="gate-notice-go" className="btn" onClick={() => document.querySelector(`[data-testid="gate-${inSteps[0].id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>Go to it</button>
        </div>
      )}

      {Object.keys(usedInputs).length > 0 && (
        <details className="card mb-5 py-2" data-testid="run-inputs">
          <summary className="cursor-pointer text-xs font-semibold uppercase text-slate-500">Inputs this run ran with</summary>
          <div className="mt-2"><JsonCode testid="run-inputs-json" maxRows={12} value={JSON.stringify(usedInputs, null, 2)} /></div>
        </details>
      )}
      <RunDiagram definition={run.definition} nodeRuns={d.node_runs} onOpen={openStep} />

      <div className="card mb-5 p-0" data-testid="timeline">
        <div className="px-3 py-2 text-xs font-semibold uppercase text-slate-500">Nodes</div>
        {roots.map((n: any) => row(n, 0))}
        {notStarted.length > 0 && (
          <div data-testid="not-started" className="border-t border-slate-200 px-3 py-2">
            <div className="text-2xs font-semibold uppercase tracking-wide text-slate-400">Not started yet</div>
            {notStarted.map((d: any) => {
              const agent = (d.type === "map" ? d.node : d)?.type === "agent";
              const editable = agent && STOPPED.includes(s);
              return (
                <div key={d.id} data-testid={`pending-step-${d.id}`} className="border-b border-slate-100 py-1.5 last:border-b-0">
                  <button type="button" className={`flex w-full items-center gap-3 text-left text-sm ${editable ? "" : "cursor-default"}`} aria-expanded={openPending === d.id} disabled={!editable}
                    onClick={() => setOpenPending(openPending === d.id ? null : d.id)}>
                    <span aria-hidden="true" className="w-3 text-xs text-slate-400">{editable ? (openPending === d.id ? "▾" : "▸") : ""}</span>
                    <span className="w-64 truncate font-medium text-slate-600">{d.id}</span>
                    <span className="w-14 text-xs text-slate-500">{d.type}</span>
                    {editable && <span className="ml-auto text-xs text-blue-700">{openPending === d.id ? "Hide" : "Change"}</span>}
                  </button>
                  {editable && openPending === d.id && (
                    <div className="mt-2 pl-6">
                      <StepEditor runId={id} nodeId={d.id} def={d.type === "map" ? d.node : d} adapter={(d.type === "map" ? d.node : d)?.agent ?? run.definition?.agent ?? defaultAdapter} status="pending" onSaved={load} current={currentStep(d.id)} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {roots.length === 0 && <div className="border-t border-slate-100 px-3 py-4 text-sm text-slate-500">Nothing has run yet.</div>}
      </div>

      <div className="card mb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Revert</span>
          <select data-testid="revert-to" className="input w-56" value={revertTo} onChange={(e) => setRevertTo(e.target.value)}>
            <option value="">everything</option>
            {topLevel.map((n) => <option key={n} value={n}>only what ran after “{n}”</option>)}
          </select>
          <AsyncButton data-testid="btn-revert" className="btn btn-danger" disabled={["pending", "running", "reverting", "reverted"].includes(s)} onClick={() => act("revert", revertTo ? { to: revertTo } : {})}>Revert run</AsyncButton>
          <span className="text-xs text-slate-500">Runs each node’s compensation in reverse order.</span>
        </div>
        {report && (
          <div data-testid="revert-report" className="rounded bg-slate-50 p-3 text-sm">
            <div>Compensated: <b>{report.compensated.length ? report.compensated.join(", ") : "none"}</b> · side effects reverted: <b>{report.reverted_effects}</b></div>
            {report.manual.length > 0 ? (
              <>
                <div className="mt-2 font-semibold text-red-800">Manual follow-up needed</div>
                <ul data-testid="revert-manual" className="list-disc pl-5">
                  {report.manual.map((m: any, i: number) => (
                    <li key={i}>{m.node_id}{m.item_index != null ? `[${m.item_index}]` : ""}: {m.kind} {m.ref} {m.url && <a className="text-blue-700 underline" href={m.url}>link</a>} — {m.reason}{m.how_to_undo ? ` (how to undo: ${m.how_to_undo})` : ""}</li>
                  ))}
                </ul>
              </>
            ) : <div className="mt-1 text-green-800" data-testid="revert-clean">Nothing left to undo by hand.</div>}
          </div>
        )}
      </div>

      {d.side_effects.length > 0 && (
        <div className="card mb-5" data-testid="side-effects">
          <div className="label">Side effects</div>
          <ul className="text-sm">
            {d.side_effects.map((e: any) => (
              <li key={e.id} data-testid={`effect-${e.id}`}>
                <span className="font-medium">{e.kind}</span> {e.ref} {e.url && <a className="text-blue-700 underline" href={e.url} target="_blank" rel="noreferrer">link</a>}
                {e.irreversible ? <span className="ml-2 rounded bg-red-100 px-1.5 text-xs text-red-800">irreversible</span> : null}
                {e.reverted_at ? <span className="ml-2 rounded bg-orange-100 px-1.5 text-xs text-orange-800">reverted</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Replay runId={id} count={d.messages ?? 0} />

      <details className="card" data-testid="event-log">
        <summary className="cursor-pointer text-sm font-semibold">Event log ({events.length})</summary>
        <div className="mono mt-2 max-h-80 overflow-auto text-xs">
          {events.map((e) => <div key={e.id} data-testid="event-row" data-type={e.type}><span className="text-slate-400">{e.ts.slice(11, 19)}</span> <b>{e.type}</b> {JSON.stringify(e.payload).slice(0, 300)}</div>)}
        </div>
      </details>
    </div>
  );
}


/**
 * Change an agent step of a stopped run, for that run only: its model (saved when picked) and its
 * prompt (saved a moment after typing stops; kept as a draft until then, so a refresh loses
 * nothing). Each saved change is written to the run's record. See changeStep in ops.ts.
 */
function StepEditor({ runId, nodeId, def, adapter, status, error, onSaved, current }: { runId: number; nodeId: string; def: any; adapter: string; status: string; error?: string | null; onSaved: () => void; current?: { version: number; prompt: string; model: string | null } | null }) {
  const saved = String(def?.prompt ?? "");
  // What is typed is kept as a draft until it is saved, so a refresh loses nothing.
  const key = `run-step:${runId}:${nodeId}:prompt`;
  const [prompt, setPromptState] = useState<string>(() => readDraft<string>(key) ?? saved);
  const setPrompt = (v: string) => { setPromptState(v); writeDraft(key, v); };
  const [state, setState] = useState<"saved" | "saving" | "error">("saved");
  const [problem, setProblem] = useState<string | null>(null);
  const send = async (patch: { model?: string | null; prompt?: string }) => {
    setState("saving"); setProblem(null);
    try { await api("POST", `/api/runs/${runId}/steps/${encodeURIComponent(nodeId)}`, patch); setState("saved"); if ("prompt" in patch) removeDraft(key); onSaved(); }
    catch (e: any) { setState("error"); setProblem(e.message); }
  };
  useEffect(() => {
    if (prompt === saved) { removeDraft(key); return; }
    if (!prompt.trim()) return;
    const t = setTimeout(() => void send({ prompt }), 900);
    return () => clearTimeout(t);
  }, [prompt, saved]);
  const waitingForAnswer = status === "waiting_gate";
  // The workflow was changed after the run started, and this step differs there.
  const newer = current && (current.prompt !== saved || (current.model ?? null) !== (def?.model ?? null)) ? current : null;
  const useNewer = async () => {
    if (!newer) return;
    if (newer.prompt !== saved) setPrompt(newer.prompt);
    await send({ ...(newer.prompt !== saved ? { prompt: newer.prompt } : {}), ...((newer.model ?? null) !== (def?.model ?? null) ? { model: newer.model } : {}) });
  };
  return (
    <div data-testid="step-model" className="mb-3 rounded border border-slate-200 bg-surface p-3">
      {status === "failed" && CONTEXT_ERROR.test(error ?? "") && (
        <p data-testid="step-context-hint" className="mb-2 text-sm text-amber-900">This step ran out of room in the model's context window. Pick a model with a larger context window, then press Resume. Completed steps keep their results; only this step and the ones after it run again.</p>
      )}
      <ErrorBox error={problem} testid="step-model-error" />
      {newer && (
        <div data-testid="step-newer" className="mb-2 flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs text-blue-900">
          <span>The workflow has changed since this run started: version {newer.version} has a different {newer.prompt !== saved && (newer.model ?? null) !== (def?.model ?? null) ? "prompt and model" : newer.prompt !== saved ? "prompt" : "model"} for this step.</span>
          <AsyncButton data-testid="step-use-newer" className="btn px-2 py-1 text-xs" onClick={useNewer}>Use version {newer.version}'s</AsyncButton>
        </div>
      )}
      <ModelSelect adapter={adapter} value={def?.model} testid="step-model-select" onChange={(v) => void send({ model: v || null })} />
      <label className="mb-1 block">
        <span className="label">Prompt for this run</span>
        <textarea data-testid="step-prompt" rows={6} className="input mono text-xs" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div data-testid="step-edit-status" data-state={state} className="text-xs text-slate-500">
        {state === "saving" ? "Saving…" : prompt !== saved && state !== "error" ? "Changes are saved a moment after you stop typing." : "Saved for this run."}
        {" "}For this run only: the workflow is not changed.{" "}
        {status === "interrupted" ? "A new model continues the step's session; a new prompt starts the step again from the beginning." : waitingForAnswer ? "A new prompt withdraws the step's question and starts it again (then press Resume); a new model is used when it continues after your answer." : status === "pending" ? "The step uses this when the run gets to it." : "Press Resume to run the step with this."}
      </div>
    </div>
  );
}

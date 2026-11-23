import { useCallback, useEffect, useRef, useState } from "react";
import { api, get, pretty, tokenCount, usd } from "../api";
import { AsyncButton, ConfirmDeleteRuns, ErrorBox, go, readDraft, removeDraft, Status, TrashButton, writeDraft } from "../ui";
import { SHOW_BUDGETS, SHOW_COST } from "../features";
import { GateCard } from "./gates";
import { Preview, rawPromptBoundary, TextSection } from "../text-view";
import { JsonCode } from "../json-editor";
import { Replay } from "./replay";
import { ModelSelect } from "../designer/panel";
import { RunDiagram } from "../run-diagram";
import { mergeInputs } from "../run-inputs";
import { usePolling, useReveal } from "../polling";
import { Button } from "../components/ui/button";
import { Select } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { Card } from "../components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";


/**
 * Which actions a run offers, by what state it is in. **Only the applicable ones are drawn** (asked 2026-11-22: *"i think
 * there should be only a Resume button, no?"* — a cancelled run was showing five, four of them greyed out).
 *
 * The model, which the engine already enforces (`resumeRun` refuses anything but paused/interrupted/failed, and
 * `requestCancel` refuses a terminal run) and which this row now reflects instead of contradicting:
 *
 *  - **Pause** only while it is doing something. There is nothing to pause in a run that has stopped.
 *  - **Resume** only when something stopped it that a person can fix — the server went away (`interrupted`), a step
 *    failed on a connection or quota problem (`failed`), or it was paused on purpose. **Never after a cancel**: a
 *    cancelled run is finished, and the way forward is a new run.
 *  - **Cancel** only while it is going. A finished or stopped run has nothing to cancel.
 *  - **Run again** only once this run is no longer progressing: it starts a *new* run and leaves this one as it is, so
 *    offering it beside Cancel would suggest two ways to end the same thing.
 *  - **Delete** only for a finished one — a run in flight is not a record yet.
 */
/**
 * A solid fill per run status, for the dot on a step's tab. `STATUS_COLOR` is the badge's pair (`bg-*-100 text-*-800`) and
 * a 100 step is invisible at 6 px, so this is the same family one step in, not a second palette.
 */
const STEP_DOT: Record<string, string> = {
  pending: "bg-slate-300", running: "bg-blue-500", waiting_gate: "bg-amber-500",
  paused: "bg-purple-500", interrupted: "bg-purple-500", completed: "bg-green-600",
  failed: "bg-red-600", cancelled: "bg-slate-400", reverting: "bg-orange-500", reverted: "bg-orange-500",
};

/** The tab that holds the steps of the workflow that have no attempt yet. Not an attempt id, hence the prefix. */
const PENDING_TAB = "pending";

/** Finished: nothing is left to control, which is why the same four appear under `rerun` and `delete`. */
const FINISHED = ["completed", "failed", "reverted", "cancelled"];
const ACTIONS = {
  pause: ["pending", "running", "waiting_gate"],
  resume: ["paused", "interrupted", "failed"],
  cancel: ["pending", "running", "waiting_gate", "paused", "interrupted"],
  rerun: FINISHED,
  delete: FINISHED,
} as const;
/** Errors that mean the model's context window was too small for what the step had to read. */
const CONTEXT_ERROR = /context (window|length|limit)|prompt is too long|too many tokens|maximum context|input (is )?too long|exceeds? (the )?(model'?s? )?(maximum )?context/i;
/**
 * Errors that mean the step's model — or the account behind it — was refused rather than the task going wrong.
 *
 * The case this is for: a step left on **"CLI default"** passes no `-m` at all, so the CLI uses whatever model its
 * own configuration names, and that model can need an account token this machine does not have. Run #51 of
 * `flight-weather-forecast` failed every agent step that way — "Personal Access Tokens are not supported for this
 * endpoint" — and the page said only "This step failed", so the setting at fault was a guess (2026-11-22).
 */
const MODEL_AUTH_ERROR = /personal access token|third-party user token|invalid[_ ]?api[_ ]?key|no api key|api key|unauthorized|not authorized|authentication|not authenticated|please (sign|log) in|sign[- ]?in required|\b(401|403)\b/i;
/** Run statuses in which a step that has not completed may be changed before resuming (see STOPPED_RUN in ops.ts). */
const STOPPED = ["failed", "paused", "interrupted", "waiting_gate"];

const IN_LABEL: Record<string, string> = { prompt: "Input: prompt sent to the agent", stdin: "Input: sent to the script", gate_question: "Input: what you were asked" };
/** The first lines of a text, for the compact view on a node. */
const preview = (t: string | null | undefined, max = 420) => (!t ? "" : t.length > max ? t.slice(0, max) + " …" : t);
/** For the compact view: the prompt as the author wrote it, without what chief appends for every agent (the full text is in the details). */
/** The author's own words from a recorded prompt: chief's appended part is not what the row is previewing. */
const ownPrompt = (t: string | null | undefined, at?: number | null) => {
  const text = t ?? "";
  const cut = at != null && at > 0 && at < text.length ? at : rawPromptBoundary(text) ?? 0;
  return cut > 0 ? text.slice(0, cut) : text;
};

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
  /**
   * Which step is in view, by attempt id (`roots` are attempts, not definitions: a rerun makes a second `plan`).
   *
   * One step at a time, rather than every step's output stacked in one column: with three steps the card was already 589 px
   * before anything was expanded, and a ten-step workflow would be a page of scrolling to compare two outputs (asked
   * 2026-11-22: *"can we use tabs to show all the building blocks of this workflow?"*).
   *
   * Declared here, with the other hooks, and not beside the values derived from it: those are computed after `if (!d)
   * return`, and a hook below an early return runs on some renders and not others — which is React error #310, and it took
   * the whole run page down when it was first written that way.
   */
  const [stepTab, setStepTab] = useState<string>("");
  const lastEvent = useRef(0);

  const load = useCallback(() => get(`/api/runs/${id}`).then(setD).catch((e) => setError(e.message)), [id]);

  // Live updates: every event from the stream triggers a refetch of the run.
  useEffect(() => {
    const ctl = new AbortController();
    let pending: ReturnType<typeof setTimeout> | undefined;
    load();
    streamEvents(id, lastEvent.current, (e) => {
      lastEvent.current = Math.max(lastEvent.current, e.id);
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
  /**
   * Run again: a new run of the same workflow with this run's inputs.
   *
   * `from` starts it at that step, keeping this run's results for the steps before it instead of spending tokens and time on
   * them again (asked 2026-11-23: *"a full rerun of a workflow run everytime is waste of token and time"*). The choice is a
   * menu under the button rather than a second control: "run again" is one action, and where to start is how it is run.
   */
  const rerun = async (from?: string) => {
    setError(null);
    try { const r = await api("POST", `/api/runs/${id}/rerun`, from ? { from } : {}); go(`/runs/${r.run.id}`); }
    catch (e: any) { setError(e.message); }
  };
  const [rerunMenu, setRerunMenu] = useState(false);

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
  /** Does this run's state offer this action? See `ACTIONS` for the model and the reason for each. */
  const shows = (name: keyof typeof ACTIONS) => (ACTIONS[name] as readonly string[]).includes(s);
  /** The step a person is most likely to want: the one asking a question, then the one running, then the first. */
  const needsYou = roots.find((n: any) => waiting.some((g: any) => g.node_run_id === n.id)) ?? roots.find((n: any) => n.status === "running") ?? roots[0];
  /** The tab in view, falling back to the one that needs attention — never to nothing while there are steps. */
  // "Not started" is a tab of its own and must be openable like any other: the fallback below only applies when the chosen
  // tab no longer names an attempt (a rerun replaced them), and it would otherwise have pulled the view back to the step that
  // is asking every time this one was clicked (found by E15.93-1).
  const shownTab = stepTab === PENDING_TAB ? PENDING_TAB : roots.some((n: any) => String(n.id) === stepTab) ? stepTab : needsYou ? String(needsYou.id) : "";
  /** Waiting questions outside the step in view: they must never be reachable only by guessing which tab they are under. */
  const waitingElsewhere = roots.filter((n: any) => String(n.id) !== shownTab && waiting.some((g: any) => g.node_run_id === n.id));
  const selectStep = (nodeRunId: number | string) => setStepTab(String(nodeRunId));

  /** The inputs the run ran with: its own values over the workflow's defaults. */
  const usedInputs = mergeInputs(run.definition?.inputs, run.inputs);
  /** Open a step's row from the diagram: its latest attempt, or its entry under "Not started yet". */
  const openStep = (nodeId: string) => {
    const latest = roots.filter((n: any) => n.node_id === nodeId && n.phase === "forward").sort((a: any, b: any) => b.id - a.id)[0];
    const target = latest ? `node-run-${latest.id}` : `pending-step-${nodeId}`;
    // Into view first: the row only exists inside its own tab, so selecting it is what makes `reveal` find anything.
    if (latest) { selectStep(latest.id); setOpen(latest.id); } else { setStepTab(PENDING_TAB); setOpenPending(nodeId); }
    reveal(target); // scrolls after the row is rendered, instead of racing it with a zero-delay timer
  };
  /** A top-level agent step that has not completed, in a run that is stopped: its model may be changed. */
  /**
   * The steps this run has results for, in the workflow's order: where a partial rerun can start. Starting at the first of
   * them is a full rerun, so the menu offers the second onwards.
   */
  const rerunFrom = ((): string[] => {
    const done = new Set((d.node_runs as any[]).filter((n: any) => n.status === "completed").map((n: any) => n.node_id));
    return (run.definition?.nodes ?? []).map((n: any) => String(n.id)).filter((id: string) => done.has(id));
  })();
  const changeable = (n: any) => n.parent_node_run_id == null && n.phase === "forward" && n.status !== "completed" && STOPPED.includes(s) && stepDef(n)?.type === "agent";
  /**
   * The other agent steps of this run that have no model of their own and have not finished.
   *
   * Those are the ones a model chosen here should reach: a step with no model inherits the CLI's own default, which
   * is what was refused. Run #51 failed **one step at a time** — the first failure stopped the run, so the steps
   * after it were still pending — and the same edit was made three times because fixing the step that failed left
   * the ones after it unchanged (2026-11-22). A step that already names a model is left alone: that was a choice.
   */
  const unsetModelSteps = (n: any) => (run.definition?.nodes ?? [])
    .filter((def: any) => {
      const inner = def.type === "map" ? def.node : def;
      return inner?.type === "agent" && def.id !== n.node_id && !inner.model;
    })
    .map((def: any) => def.id as string)
    .filter((nodeId: string) => !(d.node_runs as any[]).some((r: any) => r.node_id === nodeId && r.status === "completed"));

  const row = (n: any, depth: number) => {
    const u = n.usage;
    return (
      <div key={n.id}>
        {/* The whole row opens the node's details. The arrow and the highlight show that, and whether it is open. */}
        <Button variant="ghost" data-testid={`node-run-${n.id}`} data-node-id={n.node_id} data-status={n.status} data-phase={n.phase} data-item={n.item_index ?? ""} aria-expanded={open === n.id} data-open={open === n.id} title={open === n.id ? "Hide the details" : "Show the full input and output"} className={`flex w-full items-center gap-3 border-l-4 border-t border-t-slate-100 px-3 py-2 text-left text-sm ${open === n.id ? "border-l-primary bg-accent" : "border-l-transparent hover:bg-slate-50"}`} style={{ paddingLeft: 8 + depth * 24 }} onClick={() => setOpen(open === n.id ? null : n.id)}>
          <span data-testid={`node-arrow-${n.id}`} aria-hidden="true" className={`w-3 shrink-0 text-xs ${open === n.id ? "text-primary" : "text-slate-400"}`}>{open === n.id ? "▾" : "▸"}</span>
          {/* The row is five columns wide; on a phone it kept the window at 432 px, so the name gives way first and the
              three secondary ones go (the arrow, the status and the row itself still say everything a thumb needs). */}
          <span className="w-24 shrink-0 truncate font-medium sm:w-40 md:w-64">
            {n.node_id}{n.item_index != null ? `[${n.item_index}]` : ""}
            {n.phase === "compensate" && <span className="ml-2 rounded bg-orange-100 px-1.5 text-xs text-orange-800">compensate</span>}
            {n.attempt > 1 && <span className="ml-2 text-xs text-slate-500">try {n.attempt}</span>}
          </span>
          <span className="hidden w-14 shrink-0 text-xs text-slate-500 sm:block">{n.node_type}</span>
          <Status value={n.status} />
          <span className="mono ml-auto min-w-0 truncate text-xs text-slate-600" data-testid={`node-usage-${n.id}`}>
            {[u ? `${u.input_tokens + u.cache_read_tokens + u.cache_write_tokens} in · ${u.output_tokens} out${SHOW_COST ? ` · ${usd(u.cost_usd)}` : ""}` : "", n.input?.est_tokens ? `prompt ~${n.input.est_tokens} tok` : ""].filter(Boolean).join(" · ")}
          </span>
          <span className="hidden w-16 shrink-0 text-right text-xs text-primary sm:block">{open === n.id ? "Hide" : "Details"}</span>
        </Button>
        {/* What went in and what came out, on the node itself. Click the node for the full text. */}
        {open !== n.id && (n.io?.input != null || n.output != null || n.error) && (
          <div data-testid={`node-io-${n.id}`} className="grid cursor-pointer grid-cols-1 gap-2 px-3 pb-2 text-xs sm:grid-cols-2" style={{ paddingLeft: 12 + depth * 24 }} onClick={() => setOpen(n.id)} title="Click for the full input and output">
            <div className="min-w-0">
              <div className="text-2xs font-semibold uppercase tracking-wide text-slate-400">{IN_LABEL[n.io?.input_kind] ?? "Input"}</div>
              <Preview testid={`node-in-${n.id}`}>{preview(n.io?.input_kind === "prompt" ? ownPrompt(n.io?.input, n.io.appended_at) : n.io?.input) || "(nothing recorded)"}</Preview>
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
            {CONTEXT_ERROR.test(n.error ?? "")
              ? "This step ran out of room in the model's context window. "
              : MODEL_AUTH_ERROR.test(n.error ?? "")
                ? "This step's model or account was refused — a step left on the CLI's default model uses whatever that CLI is configured with, and that can need an account this machine is not signed in to. "
                : "This step failed. "}
            <Button variant="ghost" className="text-primary underline" type="button" onClick={() => setOpen(n.id)}>Change its model</Button>, then press Resume: only this step and the ones after it run again.
          </div>
        )}
        {gatesOf(n.id).map((g: any) => (
          <div key={g.id} data-testid={`node-gate-${n.id}`} className="px-3 pb-3" style={{ paddingLeft: 12 + depth * 24 }}>
            <GateCard gate={g} onAnswered={answered} onChangeStep={g.reason === "needs_input" && changeable(n) ? () => setOpen(n.id) : undefined} />
          </div>
        ))}
        {open === n.id && (
          <div data-testid="node-details" data-for={n.node_id} className="border-l-4 border-l-primary bg-accent/40 px-4 py-3 text-xs" style={{ paddingLeft: 16 + depth * 24 }}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold text-primary" data-testid="node-details-title">Details of {n.node_id}{n.item_index != null ? `[${n.item_index}]` : ""} <span className="font-normal text-slate-600">({n.node_type}, {String(n.status).replace("_", " ")})</span></span>
              <Button variant="outline" data-testid="node-details-hide"  onClick={() => setOpen(null)}>Hide details</Button>
            </div>
            {n.error && <div className="mb-2 whitespace-pre-wrap text-red-700" data-testid="node-error">{n.error}</div>}
            {changeable(n) && (
              <StepEditor runId={id} nodeId={n.node_id} def={stepDef(n)} adapter={stepAdapter(n)} status={n.status} error={n.error} onSaved={load} current={currentStep(n.node_id)}
                unsetModelSteps={unsetModelSteps(n)} />
            )}
            {/* A prompt and what a step wrote are usually markdown: shown formatted, with the raw text one click away. */}
            <TextSection label={IN_LABEL[n.io?.input_kind] ?? "Input"} text={n.io?.input} testid="node-input" markdown={n.io?.input_kind === "prompt"} empty="(nothing recorded)"
              appendedAt={n.io?.input_kind === "prompt" ? n.io.appended_at ?? rawPromptBoundary(n.io.input ?? "") : null} />
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
      {!panel && <a href="#/runs" className="text-sm text-primary underline">← All runs</a>}
      <div className="mb-4 mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold" data-testid="run-title">Run #{run.id} · {run.workflow_name} v{run.workflow_version}</h1>
        <Status value={s} testid="run-status" />
        <span className="mono whitespace-nowrap text-sm text-slate-600" data-testid="run-totals">
          {tokenCount(run.tokens_in)} tokens in · {tokenCount(run.tokens_out)} tokens out{SHOW_COST ? ` · ${usd(run.cost_usd)}` : ""}{SHOW_BUDGETS && d.budget?.["max-usd"] ? ` of ${usd(d.budget["max-usd"])}` : ""}
        </span>
        <div className="flex flex-wrap gap-2 sm:ml-auto" data-testid="run-actions" data-state={s}>
          {shows("pause") && <AsyncButton data-testid="btn-pause" variant="outline" disabled={run.requested_action === "pause"} onClick={() => act("pause")}>{run.requested_action === "pause" ? "Pausing…" : "Pause"}</AsyncButton>}
          {shows("resume") && <AsyncButton data-testid="btn-resume" variant="outline" onClick={resume}>Resume</AsyncButton>}
          {shows("rerun") && (
            <span className="relative">
              <AsyncButton data-testid="btn-rerun" variant="outline" title="Start a new run of this workflow with the inputs this run ran with. This run stays as it is" onClick={() => void rerun()}>Run again — new run</AsyncButton>
              {/* A caret beside it, not a second action: the menu is where the run starts, and "from the beginning" is the
                  button itself. Offered only when there is a later step to start at — one step is no choice.
                  A kept result means the step is not run again, so the menu says what it saves. */}
              {rerunFrom.length > 1 && (
                <>
                  <Button variant="outline" type="button" data-testid="btn-rerun-menu" aria-label="Run again from a step" aria-expanded={rerunMenu}
                    className="ml-1 h-9 px-1.5" onClick={() => setRerunMenu((v) => !v)}>
                    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 6.5l4 4 4-4" /></svg>
                  </Button>
                  {rerunMenu && (
                    <div data-testid="rerun-menu" className="absolute right-0 top-full z-30 mt-1 w-80 rounded-md border border-border bg-surface p-1 shadow-lg">
                      <div className="px-2 py-1 text-2xs text-slate-500">Run again from a step: the steps before it keep the results they returned in this run and are not run again.</div>
                      {rerunFrom.slice(1).map((nodeId: string) => (
                        <Button key={nodeId} variant="ghost" type="button" data-testid={`rerun-from-${nodeId}`}
                          className="h-auto w-full justify-start px-2 py-1.5 text-left text-xs"
                          onClick={() => { setRerunMenu(false); void rerun(nodeId); }}>
                          <span className="min-w-0 flex-1 truncate">from <b>{nodeId}</b></span>
                          <span className="shrink-0 text-2xs text-slate-500">after {rerunFrom.slice(0, rerunFrom.indexOf(nodeId)).join(", ")}</span>
                        </Button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </span>
          )}
          {shows("cancel") && <AsyncButton data-testid="btn-cancel" variant="destructive" disabled={run.requested_action === "cancel"} onClick={() => act("cancel")}>{run.requested_action === "cancel" ? "Cancelling…" : "Cancel"}</AsyncButton>}
          {/* A bin, not a filled red bar: the header is navigation and state, and a destructive action should not be the
              loudest thing in it. The confirmation names the run and says it cannot be undone, which is where the weight
              belongs (asked 2026-11-22: "can we change this to a Bin icon button instead of a big fat delete button?"). */}
          {shows("delete") && <TrashButton testid="btn-delete-run" label="Delete this run" onClick={() => setConfirmDelete(true)} />}
          {/* A revert in flight has no actions: the run is being undone and every button would either race it or lie. */}
          {s === "reverting" && <span className="self-center text-sm text-slate-500" data-testid="run-reverting">Undoing this run's side effects…</span>}
        </div>
        {confirmDelete && <ConfirmDeleteRuns ids={[run.id]} onClose={() => setConfirmDelete(false)} onDone={() => go("/runs")} />}
      </div>
      <ErrorBox error={error ?? (run.error && s === "failed" ? run.error : null)} testid="run-error" />

      {outdated.length > 0 && (
        <div data-testid="run-outdated" className="mb-4 flex flex-wrap items-center gap-2 rounded border border-border bg-accent px-3 py-2 text-sm text-primary">
          {keepOwn
            ? <span>Resume will run {outdated.length === 1 ? "step" : "steps"} <b>{outdated.map((o) => o.id).join(", ")}</b> as {outdated.length === 1 ? "it was" : "they were"} when this run started (version {run.workflow_version}), not as changed in the designer since (version {d.current.version}).</span>
            : <span>{outdated.length === 1 ? "Step" : "Steps"} <b>{outdated.map((o) => o.id).join(", ")}</b> {outdated.length === 1 ? "was" : "were"} changed in the designer since this run started. <b>Resume will use the new version</b> (version {d.current.version}) for {outdated.length === 1 ? "it" : "them"}. Completed steps keep their results.</span>}
          <Button variant="outline" type="button" data-testid="run-keep-own"  onClick={() => setKeepOwn(!keepOwn)}>{keepOwn ? `Use version ${d.current.version} instead` : "Keep this run's version"}</Button>
        </div>
      )}
      {loose.map((g: any) => <GateCard key={g.id} gate={g} onAnswered={answered} />)}
      {inSteps.length > 0 && (
        <div data-testid="gate-notice" className="mb-4 flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>This run is waiting for your answer at {inSteps.length === 1 ? "step" : "steps"} <b>{inSteps.map((g: any) => g.node_id ?? "?").join(", ")}</b>.</span>
          {/* The gate's form lives in its own step's tab now, so "go to it" has to bring that step into view and then scroll —
              scrolling alone would find nothing, because the form is not in the DOM until its step is selected (task 15.93). */}
          <Button variant="outline" data-testid="gate-notice-go" onClick={() => { const g = inSteps[0]; if (g?.node_run_id != null) selectStep(g.node_run_id); reveal(`gate-${g.id}`); }}>Go to it</Button>
        </div>
      )}

      {Object.keys(usedInputs).length > 0 && (
        <Card asChild className="mb-5 py-2"><details data-testid="run-inputs">
          <summary className="cursor-pointer text-xs font-semibold uppercase text-slate-500">Inputs this run ran with</summary>
          <div className="mt-2"><JsonCode testid="run-inputs-json" maxRows={12} value={JSON.stringify(usedInputs, null, 2)} /></div>
        </details></Card>
      )}
      <RunDiagram definition={run.definition} nodeRuns={d.node_runs} workflow={run.workflow_name} onOpen={openStep} />

      <Card className="mb-5" data-testid="timeline">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="text-xs font-semibold uppercase text-slate-500">Nodes</span>
          <span className="text-2xs text-slate-400" data-testid="nodes-count">
            {roots.length} step{roots.length === 1 ? "" : "s"}{notStarted.length ? ` · ${notStarted.length} not started` : ""}
          </span>
        </div>
        {/* A question in a step you are not looking at would otherwise be reachable only by guessing which tab it is under. */}
        {waitingElsewhere.length > 0 && (
          <div data-testid="waiting-elsewhere" role="status" className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-sm text-amber-900">
            {/* The space is in the text, not in `gap`: `textContent` reads "in: ask" then, which is what a screen reader
                and a copy of the line need (the strip's test case caught it as "in:ask"). */}
            <span>Waiting for your answer in: </span>
            {waitingElsewhere.map((n: any) => (
              <Button key={n.id} variant="link" size="sm" className="px-0 font-semibold" data-testid={`waiting-go-${n.node_id}`} onClick={() => { selectStep(n.id); setOpen(n.id); }}>{n.node_id}</Button>
            ))}
          </div>
        )}
        {roots.length === 0 ? (
          <div data-testid="not-started" className="border-t border-slate-200 px-3 py-3">
            <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-slate-400">Not started yet</div>
            <div className="text-sm text-slate-500">Nothing has run yet.</div>
          </div>
        ) : (
          <Tabs value={shownTab} onValueChange={(v) => { setStepTab(v); setOpen(null); }}>
            {/*
              * The strip is the index: every step, its status, and whether it is asking something — so the one-step-at-a-time
              * panel below does not hide the fact that another step failed or is waiting. Wrapping `flex-wrap` rather than
              * scrolling sideways: a ten-step workflow must not make the card scroll horizontally (AGENTS.md).
              */}
            <TabsList aria-label="Steps" data-testid="node-tabs" className="mx-3 mb-2 flex h-auto flex-wrap justify-start">
              {roots.map((n: any) => {
                const asking = waiting.some((g: any) => g.node_run_id === n.id);
                return (
                  <TabsTrigger key={n.id} value={String(n.id)} data-testid={`node-tab-${n.node_id}`} data-node-id={n.node_id} data-status={n.status} data-asking={asking ? "true" : undefined}
                    className="gap-1.5" title={`${n.node_id} · ${n.node_type} · ${String(n.status).replace("_", " ")}`}>
                    <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${STEP_DOT[n.status] ?? "bg-slate-300"}`} />
                    <span className="max-w-40 truncate">{n.node_id}</span>
                    {n.item_index != null && <span className="text-2xs text-slate-500">[{n.item_index}]</span>}
                    {asking && <span className="rounded bg-amber-200 px-1 text-2xs font-semibold text-amber-900" data-testid={`node-asking-${n.node_id}`}>?</span>}
                  </TabsTrigger>
                );
              })}
              {notStarted.length > 0 && <TabsTrigger value={PENDING_TAB} data-testid="node-tab-pending" className="gap-1.5" title="Steps of this workflow that have not started"><span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />Not started<span className="text-2xs text-slate-500">{notStarted.length}</span></TabsTrigger>}
            </TabsList>
            {roots.map((n: any) => <TabsContent key={n.id} value={String(n.id)} className="mt-0">{row(n, 0)}</TabsContent>)}
            {notStarted.length > 0 && (
              <TabsContent value={PENDING_TAB} className="mt-0">
                <div data-testid="not-started" className="border-t border-slate-200 px-3 py-2">
                  {notStarted.map((d: any) => {
              const agent = (d.type === "map" ? d.node : d)?.type === "agent";
              const editable = agent && STOPPED.includes(s);
              return (
                <div key={d.id} data-testid={`pending-step-${d.id}`} className="border-b border-slate-100 py-1.5 last:border-b-0">
                  <Button variant="ghost" type="button" className={`flex w-full items-center gap-3 text-left text-sm ${editable ? "" : "cursor-default"}`} aria-expanded={openPending === d.id} disabled={!editable} onClick={() => setOpenPending(openPending === d.id ? null : d.id)}>
                    <span aria-hidden="true" className="w-3 text-xs text-slate-400">{editable ? (openPending === d.id ? "▾" : "▸") : ""}</span>
                    <span className="w-64 truncate font-medium text-slate-600">{d.id}</span>
                    <span className="w-14 text-xs text-slate-500">{d.type}</span>
                    {editable && <span className="ml-auto text-xs text-primary">{openPending === d.id ? "Hide" : "Change"}</span>}
                  </Button>
                  {editable && openPending === d.id && (
                    <div className="mt-2 pl-6">
                      <StepEditor runId={id} nodeId={d.id} def={d.type === "map" ? d.node : d} adapter={(d.type === "map" ? d.node : d)?.agent ?? run.definition?.agent ?? defaultAdapter} status="pending" onSaved={load} current={currentStep(d.id)} />
                    </div>
                  )}
                </div>
              );
                  })}
                </div>
              </TabsContent>
            )}
          </Tabs>
        )}
      </Card>

      <Card className="mb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Revert</span>
          <Select className="w-56" data-testid="revert-to"  value={revertTo} onChange={(e) => setRevertTo(e.target.value)}>
            <option value="">everything</option>
            {topLevel.map((n) => <option key={n} value={n}>only what ran after “{n}”</option>)}
          </Select>
          <AsyncButton data-testid="btn-revert" variant="destructive" disabled={["pending", "running", "reverting", "reverted"].includes(s)} onClick={() => act("revert", revertTo ? { to: revertTo } : {})}>Revert run</AsyncButton>
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
                    <li key={i}>{m.node_id}{m.item_index != null ? `[${m.item_index}]` : ""}: {m.kind} {m.ref} {m.url && <a className="text-primary underline" href={m.url}>link</a>} — {m.reason}{m.how_to_undo ? ` (how to undo: ${m.how_to_undo})` : ""}</li>
                  ))}
                </ul>
              </>
            ) : <div className="mt-1 text-green-800" data-testid="revert-clean">Nothing left to undo by hand.</div>}
          </div>
        )}
      </Card>

      {d.side_effects.length > 0 && (
        <Card className="mb-5" data-testid="side-effects">
          <div className="label">Side effects</div>
          <ul className="text-sm">
            {d.side_effects.map((e: any) => (
              <li key={e.id} data-testid={`effect-${e.id}`}>
                <span className="font-medium">{e.kind}</span> {e.ref} {e.url && <a className="text-primary underline" href={e.url} target="_blank" rel="noreferrer">link</a>}
                {e.irreversible ? <span className="ml-2 rounded bg-red-100 px-1.5 text-xs text-red-800">irreversible</span> : null}
                {e.reverted_at ? <span className="ml-2 rounded bg-orange-100 px-1.5 text-xs text-orange-800">reverted</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Replay runId={id} count={d.messages ?? 0} />
    </div>
  );
}


/**
 * Change an agent step of a stopped run, for that run only: its model (saved when picked) and its
 * prompt (saved a moment after typing stops; kept as a draft until then, so a refresh loses
 * nothing). Each saved change is written to the run's record. See changeStep in ops.ts.
 */
function StepEditor({ runId, nodeId, def, adapter, status, error, onSaved, current, unsetModelSteps = [] }: {
  runId: number; nodeId: string; def: any; adapter: string; status: string; error?: string | null; onSaved: () => void;
  current?: { version: number; prompt: string; model: string | null } | null;
  /**
   * The other agent steps of this run that have no model of their own and have not finished. A step with no model
   * runs on the CLI's default, which is what gets refused; so one model chosen here can be given to all of them
   * (run #51 needed the same edit three times, once per step, because the first failure stopped the run and left
   * the rest pending).
   */
  unsetModelSteps?: string[];
}) {
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
      {/* The other failure class that is about a setting rather than the work: the model, or the account behind it.
          "CLI default" is the usual cause — chief passes no model at all, so the CLI uses whatever its own
          configuration names, which can need a sign-in this machine does not have. */}
      {status === "failed" && MODEL_AUTH_ERROR.test(error ?? "") && (
        <p data-testid="step-model-hint" className="mb-2 text-sm text-amber-900">
          This step was refused by its model or account, not by the work. It ran on <b>{def?.model ?? "the CLI's default model"}</b>
          {!def?.model && <> — and a CLI's default can need an account this machine is not signed in to</>}. Pick a model
          here, then press Resume: only this step and the ones after it run again.
        </p>
      )}
      <ErrorBox error={problem} testid="step-model-error" />
      {newer && (
        <div data-testid="step-newer" className="mb-2 flex flex-wrap items-center gap-2 rounded border border-border bg-accent px-2 py-1.5 text-xs text-primary">
          <span>The workflow has changed since this run started: version {newer.version} has a different {newer.prompt !== saved && (newer.model ?? null) !== (def?.model ?? null) ? "prompt and model" : newer.prompt !== saved ? "prompt" : "model"} for this step.</span>
          <AsyncButton data-testid="step-use-newer" variant="outline" className="px-2 py-1 text-xs" onClick={useNewer}>Use version {newer.version}'s</AsyncButton>
        </div>
      )}
      <ModelSelect adapter={adapter} value={def?.model} testid="step-model-select" onChange={(v) => void send({ model: v || null })} />
      {/* One model for the steps that failed the same way. Shown only for the class of failure that a model
          setting actually fixes, and only while this step has one chosen to copy. */}
      {status === "failed" && MODEL_AUTH_ERROR.test(error ?? "") && unsetModelSteps.length > 0 && def?.model && (
        <div data-testid="step-model-others" className="mb-2 flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-950">
          <span>
            {unsetModelSteps.length === 1 ? "One more step of this run has" : `${unsetModelSteps.length} more steps of this run have`} no model
            of their own ({unsetModelSteps.join(", ")}), so they would run on the CLI's default and be refused the same way.
          </span>
          <AsyncButton data-testid="step-model-others-apply" variant="outline" className="border-amber-400 px-2 py-1 text-xs"
            onClick={async () => {
              setProblem(null);
              try {
                // One call, so the steps cannot end up half changed.
                await api("POST", `/api/runs/${runId}/steps/model`, { model: def.model, nodes: unsetModelSteps });
                onSaved();
              } catch (e: any) { setProblem(e.message); }
            }}>
            Use {def.model} for {unsetModelSteps.length === 1 ? "it" : "them"} too
          </AsyncButton>
        </div>
      )}
      <label className="mb-1 block">
        <span className="label">Prompt for this run</span>
        <Textarea data-testid="step-prompt" rows={6} className="mono text-xs" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div data-testid="step-edit-status" data-state={state} className="text-xs text-slate-500">
        {state === "saving" ? "Saving…" : prompt !== saved && state !== "error" ? "Changes are saved a moment after you stop typing." : "Saved for this run."}
        {" "}For this run only: the workflow is not changed.{" "}
        {status === "interrupted" ? "A new model continues the step's session; a new prompt starts the step again from the beginning." : waitingForAnswer ? "A new prompt withdraws the step's question and starts it again (then press Resume); a new model is used when it continues after your answer." : status === "pending" ? "The step uses this when the run gets to it." : "Press Resume to run the step with this."}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, get, usd } from "./api";
import { SHOW_COST } from "./features";
import { AsyncButton, ErrorBox, Modal, Spinner, TrashButton, useDraft } from "./ui";
import { FormattedMarkdown } from "./text-view";

/** One tool call the agent made: what it ran, on what, and what came back. */
interface Action { tool: string; input: unknown; result: string | null; isError: boolean }
import { designerBridge } from "./designer/bridge";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";

interface Change { workflow: string; before: any; after: any; summary: string[] }
/** A schedule the assistant wrote, as the answer recorded it (task 15.33). */
interface Schedule { action: "create" | "update" | "delete"; workflow: string; id: number | null; cron?: string; inputs?: Record<string, unknown>; enabled?: boolean; description: string }
/** How each stored reach value reads in the panel's one line: the settings' words, short enough to sit beside a folder. */
const REACH_TOOLS: Record<string, string> = { none: "no tools", "read-only": "read-only tools", default: "all the CLI's tools" };

interface Turn { id: number; ts: string; role: "user" | "assistant"; text: string; meta?: { adapter: string; model: string | null; cost_usd: number; resumed: boolean; run_id: number | null; error?: string | null; workflow?: string | null; change?: Change | null; change_error?: string | null; schedule?: Schedule | null; schedule_error?: string | null; options?: { question: string; options: string[] } | null; compacted_from?: number | null } }

const sameCanvas = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The assistant (task 9.64): a floating button with the chief logo in the bottom right corner of
 * every page, opened from the sidebar: it is a panel of chief, not a floating helper. The run on show, if any, is the assistant's context; otherwise
 * it answers about chief as a whole (workflows, runs, gates). One conversation, kept in the
 * database; the typed question is a draft until it is sent; whether the panel is open is kept too.
 *
 * In the designer (task 9.65, `designing` is the open workflow's name, "" for a new one) the
 * workflow on the canvas is the context and the assistant builds and changes it: the canvas is
 * sent with the question, and a changed workflow that comes back is put on the canvas, where the
 * designer's autosave stores it like a change made by hand. Each change can be undone from here.
 */
export function Assistant({ runId, designing = null, open, setOpen }: { runId: number | null; designing?: string | null; open: boolean; setOpen: (v: boolean) => void }) {
  const [info, setInfo] = useState<{ adapter: string; model?: string; conversation: Turn[]; tools?: string; mcp?: string; reach?: string; folder?: string; actions?: Action[] } | null>(null);
  const [question, setQuestion, clearQuestion] = useDraft<string>("assistant:question", "");
  /** The question being answered right now, shown at the end of the conversation while the agent works. */
  const [pending, setPending] = useState<string | null>(null);
  /** The Stop was pressed and the CLI is being signalled: the button shows a spinner until it is done. */
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Answers whose change was not put on the canvas because the canvas had been edited meanwhile. */
  const [held, setHeld] = useState<number[]>([]);
  const inDesigner = designing != null;
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // `workflow` and `run_id` go with it, so what the panel says it is using is the CLI that will actually answer this
  // page's question rather than the default setting (reported 2026-11-22: it said "from cursor" beside an answer from
  // opencode).
  const load = () => {
    const q = new URLSearchParams();
    if (designing != null) q.set("workflow", designing);
    if (runId != null) q.set("run_id", String(runId));
    const qs = q.toString();
    return get(`/api/assistant${qs ? `?${qs}` : ""}`).then(setInfo).catch((e) => setError(e.message));
  };
  // The panel is chief bot, and it answers with the default agent CLI unless a step or the run says
  // otherwise — which is a server-side setting, so a change to it has to reach an open panel.
  useEffect(() => {
    const follow = () => { void load(); };
    window.addEventListener("chief:settings", follow);
    return () => window.removeEventListener("chief:settings", follow);
  }, []);
  // The textarea mounts with the panel, so the ref is set before this effect runs: no timer needed.
  useEffect(() => { if (!open) return; void load(); input.current?.focus(); }, [open]);
  // The box is as tall as its text, between its smallest and largest size (set on the element).
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [question, open]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [info?.conversation.length, pending, open]);

  /** Stop the answer being written: the CLI is signalled, and what is already recorded stays. */
  const stop = async () => {
    try { await api("DELETE", "/api/assistant/pending"); } catch (e: any) { setError(e.message); }
  };
  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    setPending(q); setError(null);
    // The box is emptied as the message goes; if sending fails, the text is put back so nothing typed is lost.
    clearQuestion();
    try {
      // In the designer the canvas goes along, exactly as it is now (the working copy, valid or not).
      const sent = inDesigner ? designerBridge.get()?.snapshot() ?? null : null;
      const r = await api("POST", "/api/assistant", { question: q, ...(info?.model ? { model: info.model } : {}), ...(sent ? { workflow: { definition: sent.definition, base_dir: sent.baseDir.trim() || undefined } } : runId != null ? { run_id: runId } : {}) });
      setInfo((i) => ({ adapter: i?.adapter ?? r.adapter, conversation: r.conversation }));
      if (r.change) {
        // Put on the canvas at once, unless the canvas was edited by hand while the agent worked: that is not overwritten.
        const canvas = designerBridge.get();
        if (canvas && sent && sameCanvas(canvas.snapshot().definition, sent.definition)) canvas.apply(r.change.after, `The assistant changed the canvas: ${r.change.summary.join("; ")}.`);
        else setHeld((h) => [...h, r.conversation.at(-1)?.id]);
      }
    } catch (e: any) {
      setError(e.message);
      setQuestion((cur) => cur || q);
      void load();
    } finally { setPending(null); }
  };
  /**
   * New chat starts a **conversation**, it does not delete one: the old chat stays in the history, where it can be
   * picked up again (asked 2026-11-22). `clear` is only for the explicit Delete on a thread.
   */
  const reset = async () => {
    setError(null);
    try { await api("POST", "/api/assistant/threads"); setHistoryOpen(false); await load(); await loadThreads(); } catch (e: any) { setError(e.message); }
  };
  /** Past conversations, and the one in view. */
  const [threads, setThreads] = useState<{ id: number; title: string; updated_at: string; current: number; turns: number }[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const loadThreads = () => get("/api/assistant/threads").then(setThreads).catch(() => {});
  useEffect(() => { void loadThreads(); }, [open]);
  /**
   * Escape closes the dropdown wherever the focus is, and a press anywhere else closes it too.
   *
   * Not an invisible full-page overlay: that is what a menu usually uses, and here it covered the very button that opens the
   * menu — so the second click landed on the overlay and the button could never be pressed again (found by the case timing
   * out on it). A listener on the document asks "was this press inside the menu, or on the button that toggles it?", which is
   * the real question and takes nothing away from the page.
   */
  useEffect(() => {
    if (!historyOpen) return;
    const onDocKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setHistoryOpen(false); };
    const onPress = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest("#assistant-history-list") || t?.closest('[data-testid="assistant-history"]')) return;
      setHistoryOpen(false);
    };
    window.addEventListener("keydown", onDocKey);
    document.addEventListener("pointerdown", onPress);
    return () => { window.removeEventListener("keydown", onDocKey); document.removeEventListener("pointerdown", onPress); };
  }, [historyOpen]);
  const openThread = async (id: number) => {
    setError(null);
    try { await api("POST", `/api/assistant/threads/${id}/use`); setHistoryOpen(false); await load(); await loadThreads(); }
    catch (e: any) { setError(e.message); }
  };
  /**
   * The conversation a delete is being confirmed for. Deleting one is a real delete — its messages go with it and there is
   * no undo — so it is asked once, the way a run is (asked 2026-11-22: *"users should be able to delete a chat session
   * history completely"*).
   */
  const [removingThread, setRemovingThread] = useState<{ id: number; title: string } | null>(null);
  const deleteThread = async (id: number) => {
    setError(null);
    try { await api("DELETE", `/api/assistant/threads/${id}`); await load(); await loadThreads(); }
    catch (e: any) { setError(e.message); }
  };
  /**
   * Rewrite what was typed into something the assistant can act on (asked 2026-11-23: *"my random thoughts or words
   * can be rephrased in a better agent-friendly prompt"*).
   *
   * The same mechanism as the designer's Refine — `POST /api/prompts/refine` with the bot's own CLI and model — with
   * the `question` kind, whose rules are written for a message rather than for a step prompt. **What was typed is kept
   * as a draft**, so "Back to my text" survives a refresh: the no-data-loss rule applies to a rewrite as much as to
   * typing.
   */
  const [refined, setRefined, clearRefined] = useDraft<{ mine: string; refined: string; cost: number } | null>("refine:assistant:question", null);
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const refine = async () => {
    setRefining(true);
    setRefineError(null);
    try {
      const r = await api("POST", "/api/prompts/refine", { text: question, kind: "question", ...(info?.adapter ? { adapter: info.adapter } : {}), ...(info?.model ? { model: info.model } : {}) });
      // Refined twice: "my text" stays what the person typed, not the first rewrite.
      setRefined((cur) => ({ mine: cur && cur.refined === question ? cur.mine : question, refined: r.text, cost: r.cost_usd }));
      setQuestion(r.text);
    } catch (e: any) { setRefineError(e.message); } finally { setRefining(false); }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(question); }
    // The dropdown is a layer over the panel, so Escape closes it first; the panel closes on the next press.
    if (e.key === "Escape") { if (historyOpen) setHistoryOpen(false); else setOpen(false); }
  };

  /** Put one side of a change on the canvas: the workflow as it was before it (undo) or after it. */
  const put = (t: Turn, side: "before" | "after") => {
    const c = t.meta?.change;
    const canvas = designerBridge.get();
    if (!c || !canvas) return;
    canvas.apply(c[side], side === "before" ? "The assistant's change was undone." : `The assistant's change is on the canvas: ${c.summary.join("; ")}.`);
    setHeld((h) => h.filter((id) => id !== t.id));
  };
  /** A change belongs to the workflow it was made on: it can be put back only while that workflow is open. */
  const fits = (c: Change) => inDesigner && [c.before?.name ?? "", c.after?.name ?? ""].includes(designing ?? "");

  const turns = info?.conversation ?? [];
  const suggestions = inDesigner
    ? designing ? ["Explain this workflow step by step", "Design the data format between the steps: what each step returns and what the next ones read", "What could go wrong in this workflow, and how would you fix it?", "Run this workflow every weekday at 9am", "Add a step where I approve the result before the last step"] : ["What can a workflow do? Show me a small example on the canvas"]    : runId != null
    ? ["What went wrong, and what should I do next?", `Summarise run #${runId} in plain words`, "What did each step produce?"]
    : ["Which runs failed, and why?", "What is waiting for me?", "What do my workflows do?"];
  /** The choices the latest answer offers, until the next message is sent. */
  const offered = !pending && turns.at(-1)?.role === "assistant" ? turns.at(-1)!.meta?.options ?? null : null;
  const context = inDesigner ? (designing ? `designing ${designing}` : "designing a new workflow") : runId != null ? `about run #${runId}` : "about chief";

  if (!open) return null;
  return (
    <>
      {/* A panel, not an overlay: it takes its own column beside the page, so the page keeps its layout and the
          agent reads as part of chief rather than as a bubble over it. Full width under 768 px, where there is no
          room for two columns. */}
      <aside id="assistant-panel" data-testid="assistant-panel" data-run={runId ?? ""} data-designing={designing ?? undefined}
        role="complementary" aria-label="chief bot"
        className="fixed inset-0 z-40 flex min-h-0 w-full shrink-0 flex-col border-r border-slate-200 bg-surface md:static md:z-auto md:w-[380px]">
          {/* `relative`: the conversation dropdown is anchored to this row and floats over the conversation rather than
              pushing it down (asked 2026-11-22: *"can we have a dropdown list to select the chat session history instead of
              this? this looks so confusing"*). */}
          <div className="relative flex items-center gap-2 border-b border-slate-200 px-3 py-2">
            {/* No logo here: the rail item that opened this panel already carries the sparkle, and three copies of the
                mark on one screen (rail, header, and the label under it) was the first thing reported about it
                (2026-11-22 — "too many chief icons everywhere when the agent mode is open"). */}
            {/* No "?" here: the panel is the whole feature, and what it can reach and what it has said are controls
                and content in the panel itself. Asked 2026-11-22: "remove this". */}
            <span className="text-sm font-semibold">chief bot</span>
            <span data-testid="assistant-context" className={`truncate rounded-full px-2 py-0.5 text-2xs ${inDesigner ? "bg-purple-100 text-purple-900" : runId != null ? "bg-accent text-primary" : "bg-slate-100 text-slate-600"}`} title={inDesigner ? "The assistant is given the workflow on the canvas and can build and change it" : runId != null ? "The assistant is given this run's full record" : "The assistant is given your workflows, recent runs and waiting gates"}>
              {context}
            </span>
            <div className="ml-auto flex items-center gap-1">
              {/* Past conversations: the answer to "the user may wanna continue the previous conversation".
                  A clock, not the word — a glyph reads at a glance in a header that already carries New and ×
                  (asked 2026-11-22). The name stays in `title` and `aria-label`, so it is still said in words. */}
              <Button variant="ghost" type="button" data-testid="assistant-history" aria-expanded={historyOpen} aria-controls="assistant-history-list" title={threads.length> 1 ? `Past conversations (${threads.length})` : "Past conversations"}
                aria-label="Past conversations"
                onClick={() => { setHistoryOpen(!historyOpen); void loadThreads(); }}
                className={`relative h-8 w-8 rounded p-0 ${historyOpen ? "bg-slate-200 text-slate-900" : "text-slate-600 hover:bg-slate-100"}`}>
                <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="6.2" />
                  <path d="M8 4.6V8l2.3 1.6" />
                </svg>
                {/* More than one conversation is worth saying, and it is the only sign that history exists at all. */}
                {threads.length > 1 && (
                  <span data-testid="assistant-history-count" className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-primary px-0.5 text-center text-[9px] font-semibold leading-3 text-primary-foreground">{threads.length}</span>
                )}
              </Button>
              {/* A plus, like the two glyphs beside it. This header is the panel's chrome — what it is, what it is using, and
                  three ways to steer it — and "New" was the only word in it, in the only box, which made starting a
                  conversation look like the panel's primary action (asked 2026-11-22: "can we change this to a plus icon
                  button instead?"). The word stays in `aria-label` and `title`, so it is still said in words. */}
              <AsyncButton data-testid="assistant-new" variant="ghost" className="h-8 w-8 px-0 text-slate-600" disabled={!!pending}
                aria-label="New conversation" title="New conversation: this one stays in the history" onClick={reset}>
                <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
              </AsyncButton>
              {/* The × is a glyph too, and now nothing in this header is boxed (asked 2026-11-22: "this can be just a
                  text/icon button"). */}
              <Button variant="ghost" className="h-8 w-8 px-0 text-slate-600 hover:bg-slate-100 hover:text-slate-900" type="button" data-testid="assistant-close" aria-label="Close chief bot" onClick={() => setOpen(false)}>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </Button>
            </div>
            {historyOpen && (
            <>
              {/*
                * A dropdown, not a strip that pushes the conversation down: the list of conversations is a place to *pick*
                * one, so it belongs over the conversation for as long as the choice takes. Each row is a title and a bin;
                * the bin is always visible (the × that only appeared on hover is why nobody could find delete), and it
                * asks before it removes, because a conversation's messages go with it for good.
                */}
              <div id="assistant-history-list" data-testid="assistant-history-list" role="menu" aria-label="Past conversations"
                className="absolute right-2 top-full z-20 mt-1 max-h-80 w-72 overflow-auto rounded-md border border-border bg-surface p-1 shadow-lg">
                {threads.length === 0 && <div className="px-2 py-2 text-xs text-slate-500" data-testid="assistant-history-empty">No conversations yet.</div>}
                {threads.map((t) => (
                  <div key={t.id} data-testid={`assistant-thread-${t.id}`} data-current={t.current ? "true" : undefined}
                    className={`flex items-center gap-1 rounded px-1 ${t.current ? "bg-primary/10" : "hover:bg-accent"}`}>
                    <Button variant="ghost" type="button" role="menuitem" data-testid={`assistant-thread-open-${t.id}`} onClick={() => void openThread(t.id)}
                      title={t.title || "untitled conversation"} className="h-auto min-w-0 flex-1 items-start justify-start gap-1 px-1 py-1.5 text-left">
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-xs">{t.title || "untitled conversation"}</span>
                        <span className="text-2xs text-slate-400">{t.turns === 0 ? "nothing asked yet" : `${t.turns} ${t.turns === 1 ? "exchange" : "exchanges"}`}</span>
                      </span>
                      {/* Which one is in view: said with a dot, and by the row's tint. */}
                      {t.current ? <span data-testid={`assistant-thread-current-${t.id}`} className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="in view" /> : null}
                    </Button>
                    <TrashButton testid={`assistant-thread-delete-${t.id}`} size="sm" label={`Delete ${t.title || "this conversation"}`}
                      title="Delete this conversation and everything in it. It cannot be undone."
                      onClick={() => setRemovingThread({ id: t.id, title: t.title })} />
                  </div>
                ))}
              </div>
            </>
          )}
          </div>

          <div ref={list} data-testid="assistant-conversation" className="flex-1 space-y-2 overflow-auto bg-slate-50 p-3">
            {turns.length === 0 && !pending && (
              <div className="text-sm text-slate-600" data-testid="assistant-empty">
                {inDesigner
                  ? <p>Tell me what the workflow should do, or what to change, and I'll build it on the canvas — and ask me anything else while you work: a question about chief, a run, or something you want to look up. I can also add or change a schedule for it ("every weekday at 9am"). Every change I make can be undone here. I run nothing and choose no models.</p>
                  : <p>Ask about {runId != null ? `run #${runId}` : "your workflows, runs and gates"}. I answer from what chief has recorded; I have no tools and change nothing.</p>}
              </div>
            )}
            {turns.map((t, i) => t.role === "user" ? (
              <div key={t.id} data-testid="assistant-turn-user" data-index={i}
                className="ml-8 whitespace-pre-wrap rounded-lg bg-slate-200 px-3 py-1.5 text-sm text-slate-900 dark:bg-slate-700 dark:text-slate-100">{t.text}</div>
            ) : (
              <div key={t.id} data-testid="assistant-turn-assistant" data-index={i} data-error={t.meta?.error ? "true" : undefined}
                className="mr-8 border-l-2 border-slate-200 px-2 py-1 text-sm">
                {/* A Stop is not a failure: said in grey, in the panel's own voice, and the conversation carries on. Every
                    other error stays red, because those are things a person has to act on. */}
                {t.meta?.error === "stopped"
                  ? <div className="text-sm text-slate-500" data-testid="assistant-stopped">Stopped. Ask something else — this conversation goes on.</div>
                  : t.meta?.error ? <div className="text-red-700">I could not answer: {t.meta.error}</div> : <div className="md text-sm"><FormattedMarkdown text={t.text} /></div>}
                {t.meta?.change && (
                  <div data-testid="assistant-change" data-held={held.includes(t.id) ? "true" : undefined} className="mt-2 rounded border border-purple-200 bg-purple-50 px-2 py-1.5 text-xs text-purple-950">
                    <div className="font-semibold">{held.includes(t.id) ? "Not put on the canvas: you edited it while I worked. Apply replaces what is there with my version; or ask me again." : `Changed ${t.meta.change.workflow}`}</div>
                    <ul className="mt-0.5 list-disc pl-4">{t.meta.change.summary.map((line) => <li key={line}>{line}</li>)}</ul>
                    {fits(t.meta.change) ? (
                      <div className="mt-1.5 flex gap-1.5">
                        {held.includes(t.id)
                          ? <Button variant="outline" className="px-2 py-0.5 text-xs" type="button" data-testid="assistant-apply"  onClick={() => put(t, "after")}>Apply</Button>
                          : <>
                            {(t.meta.change.before?.nodes ?? []).length > 0 && <Button variant="outline" className="px-2 py-0.5 text-xs" type="button" data-testid="assistant-undo"  onClick={() => put(t, "before")}>Undo</Button>}
                            <Button variant="outline" className="px-2 py-0.5 text-xs" type="button" data-testid="assistant-apply"  onClick={() => put(t, "after")}>Apply again</Button>
                          </>}
                      </div>
                    ) : <div className="mt-1 text-purple-800">Open {t.meta.change.workflow} in the designer to undo or apply this.</div>}
                  </div>
                )}
                {t.meta?.change_error && (
                  <div data-testid="assistant-change-error" className="mt-2 whitespace-pre-wrap rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-950"><b>The canvas was not changed.</b> chief did not accept the workflow I wrote:{"\n"}{t.meta.change_error}</div>
                )}
                {t.meta?.schedule && (
                  // Teal for a schedule that is now there, amber for one that is now gone: a delete is the one of the three
                  // that leaves nothing behind to check, so its line says exactly what was removed and what to write to put
                  // it back (asked 2026-11-22: chief bot can delete a schedule). The id is in the line because it is what the
                  // person quotes back — "delete #3", "move #3 to 18:00".
                  <div data-testid="assistant-schedule" data-action={t.meta.schedule.action}
                    className={`mt-2 rounded border px-2 py-1.5 text-xs ${t.meta.schedule.action === "delete" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-teal-200 bg-teal-50 text-teal-950"}`}>
                    <div className="font-semibold">{t.meta.schedule.action === "create"
                      ? `Scheduled ${t.meta.schedule.workflow}${t.meta.schedule.id != null ? ` as #${t.meta.schedule.id}` : ""}`
                      : t.meta.schedule.action === "delete"
                        ? `Removed schedule #${t.meta.schedule.id} of ${t.meta.schedule.workflow}`
                        : `Changed schedule #${t.meta.schedule.id} of ${t.meta.schedule.workflow}`}</div>
                    <div className="mt-0.5">{t.meta.schedule.description}</div>
                    {t.meta.schedule.action === "delete"
                      ? <div className="mt-0.5">Runs it already started are kept. To bring it back: <span className="mono">{t.meta.schedule.cron} {JSON.stringify(t.meta.schedule.inputs ?? {})}</span></div>
                      /* The list is a page of its own; this says where it went rather than making a second list here. */
                      : <div className="mt-0.5 text-teal-800">It is on the <a href="#/schedules" className="underline">Schedules</a> page.</div>}
                  </div>
                )}
                {t.meta?.schedule_error && (
                  <div data-testid="assistant-schedule-error" className="mt-2 whitespace-pre-wrap rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-950"><b>No schedule was written.</b> chief did not accept what I asked for:{"\n"}{t.meta.schedule_error}</div>
                )}
                {/* Said where it happened, in words: a conversation that suddenly answers from a fresh session looks like
                    it forgot things, and this is the line that explains why it did not (task 15.98). */}
                {t.meta?.compacted_from ? (
                  <div data-testid="assistant-compacted" className="mb-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-2xs text-slate-600" title="The conversation outgrew the CLI's session, so chief had it summarised and started a fresh session with those notes. Nothing was thrown away.">
                    Context compacted · started from notes ({Math.round(t.meta.compacted_from / 1000)}k tokens)
                  </div>
                ) : null}
                <div className="mt-1 text-2xs text-slate-500" data-testid="assistant-turn-meta">{t.meta?.adapter}{t.meta?.model ? ` · ${t.meta.model}` : ""}{SHOW_COST ? ` · ${usd(t.meta?.cost_usd)}` : ""}{t.meta?.run_id != null ? ` · run #${t.meta.run_id}` : ""}{t.meta?.resumed ? " · continued" : ""}</div>
              </div>
            ))}
            {pending && (
              <>
                <div data-testid="assistant-turn-pending" className="ml-8 whitespace-pre-wrap rounded-lg bg-slate-200 px-3 py-1.5 text-sm text-slate-900 dark:bg-slate-700 dark:text-slate-100">{pending}</div>
                <div className="mr-8 flex items-center gap-2 rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm text-slate-500"><Spinner /> {inDesigner ? "Working on the workflow…" : "Reading what chief has recorded…"}</div>
              </>
            )}
          </div>

          <div className="border-t border-slate-200 p-2">
            <ErrorBox error={error} testid="assistant-error" />
            {turns.length === 0 && !pending && (
              // Full width and wrapped, one to a line: a suggestion is a whole sentence ("What can a workflow do? Show me a
              // small example on the canvas"), and `Button`'s base class is `whitespace-nowrap` — so a row of pills ran out
              // of the panel and was cut off under the box beside it (reported 2026-11-22: "this part is overlapped by the
              // other section, can we make it text wrapping?"). `rounded-lg` rather than a pill, because two lines in a pill
              // read as a lozenge rather than as a sentence.
              <div className="mb-2 flex flex-col gap-1">
                {suggestions.map((s, i) => (
                  <Button variant="outline" className="h-auto w-full justify-start whitespace-normal rounded-lg border border-slate-300 px-2.5 py-1.5 text-left text-sm leading-snug" key={s} type="button" data-testid={`assistant-suggestion-${i}`} onClick={() => ask(s)}>{s}</Button>
                ))}
              </div>
            )}
            {offered && (
              <div data-testid="assistant-options" className="mb-2">
                {offered.question && <div className="mb-1 text-xs font-medium text-slate-700">{offered.question}</div>}
                <div className="flex flex-col items-start gap-1">
                  {offered.options.map((o, i) => (
                    <Button variant="outline" className="h-auto w-full justify-start whitespace-normal rounded-lg border border-slate-300 px-2.5 py-1.5 text-left text-sm leading-snug" key={o} type="button" data-testid={`assistant-option-${i}`} onClick={() => ask(o)}>{o}</Button>
                  ))}
                  {/* Always there: the person's own answer, typed in the box below. */}
                  <Button variant="outline" className="h-auto w-full justify-start whitespace-normal rounded-lg border border-dashed border-slate-400 px-2.5 py-1.5 text-left text-sm leading-snug" type="button" data-testid="assistant-option-own" onClick={() => input.current?.focus()}>Something else: type your own below</Button>
                </div>
              </div>
            )}
            {/* The question box takes the panel's width and grows with what is typed, up to a third of the window. */}
            <Textarea ref={input} data-testid="assistant-question" rows={4} className="block w-full resize-none text-sm leading-5" style={{ minHeight: "6rem", maxHeight: "33vh" }}
              placeholder={inDesigner ? (offered ? "Your own answer…" : "Describe the workflow, or a change…") : runId != null ? `Ask about run #${runId}…` : "Ask about your runs…"}
              value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={onKey} disabled={!!pending} />
            {/*
              * One line, not four controls. The model, the CLI and what it may reach are **settings**, chosen once in
              * Settings › chief bot; they used to sit here as a picker and two dropdowns on every reply, which made the
              * strip above the composer read as configuration rather than as conversation (asked 2026-11-22: "why do we
              * need this feature?"). What is left says what is in force right now, and where to change it.
              */}
            {info && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-slate-500">
                <span data-testid="assistant-reach" title={`changing this is in Settings`}>
                  {info.adapter}{info.model ? ` · ${info.model}` : ""} · {REACH_TOOLS[info.tools ?? "read-only"] ?? info.tools} · {info.mcp === "all" ? "every MCP server" : "no MCP"}
                </span>
                <span className="text-slate-400" data-testid="assistant-folder">in {info.folder}</span>
                <a href="#/settings" className="ml-auto shrink-0 text-primary hover:underline" data-testid="assistant-settings-link">Settings</a>
              </div>
            )}
            {/* What the agent did while answering. An agent whose actions are invisible is a chat box, so the calls sit
                with the answer: the tool, its target, and the result, one line each. */}
            {!!info?.actions?.length && (
              <details data-testid="assistant-actions" className="mt-1.5 rounded border border-slate-200 bg-slate-50 px-2 py-1">
                <summary className="cursor-pointer text-2xs font-medium text-slate-600" data-testid="assistant-actions-summary">
                  What it did ({info.actions.length} {info.actions.length === 1 ? "call" : "calls"})
                </summary>
                <ol className="mt-1 space-y-0.5">
                  {info.actions.slice(-12).map((a, i) => (
                    <li key={i} data-testid={`assistant-action-${i}`} className="mono truncate text-2xs text-slate-600" title={`${a.tool} ${JSON.stringify(a.input)}`}>
                      <span className={a.isError ? "text-red-700" : "text-slate-800"}>{a.tool}</span>
                      {a.input != null && <span className="text-slate-500"> {JSON.stringify(a.input).slice(0, 80)}</span>}
                      {a.result != null && <span className="text-slate-400"> → {a.result.replace(/\s+/g, " ").slice(0, 60)}</span>}
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {refineError && <div data-testid="assistant-refine-error" className="mt-1 text-2xs text-destructive">{refineError}</div>}
            {refined && (
              <div data-testid="assistant-refined" className="mt-1.5 flex flex-wrap items-center gap-2 text-2xs text-slate-600">
                <span>Rewritten by {info?.adapter ?? "the agent CLI"}{SHOW_COST && refined.cost ? ` (${usd(refined.cost)})` : ""}. Check it says what you meant.</span>
                <Button variant="link" size="sm" className="h-auto px-0" type="button" data-testid="assistant-refine-undo"
                  onClick={() => { setQuestion(refined.mine); clearRefined(); }}>Back to my text</Button>
                <Button variant="ghost" size="sm" className="h-auto px-1 text-2xs text-slate-500" type="button" data-testid="assistant-refine-keep" onClick={clearRefined}>Keep it</Button>
              </div>
            )}
            <div className="mt-1.5 flex items-center gap-2">
              {/* While it works there is no hint to give: Enter does nothing (a second question cannot start until this one
                  ends), and the Stop button beside it is the only thing to press. */}
              {!pending && (
                // A ghost glyph and a word, like the panel's other chrome: it helps with the box rather than acting on the
                // conversation (the same argument as the bin, 15.94).
                <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 px-1.5 text-2xs text-slate-600"
                  type="button" data-testid="assistant-refine" disabled={!question.trim() || refining}
                  title={question.trim() ? `Ask ${info?.adapter ?? "the agent CLI"} to rewrite this so the assistant understands exactly what you want. You can go back to your own words.` : "Type something first"}
                  onClick={() => void refine()}>
                  <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 shrink-0" fill="currentColor">
                    <path d="M8 1.5l1.4 3.9 3.9 1.4-3.9 1.4L8 12.1 6.6 8.2 2.7 6.8l3.9-1.4z" />
                    <path d="M12.6 10.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
                  </svg>
                  {refining ? "Refining…" : "Refine"}
                </Button>
              )}
              {!pending && <span className="hidden shrink-0 text-2xs text-slate-400 sm:inline">Enter sends · Shift+Enter new line</span>}
              <span className="flex-1" />
              {/*
                * While an answer is being written the primary slot **becomes** Stop, rather than a small Stop sitting beside
                * a spinner-labelled Ask nobody can press (asked 2026-11-22: *"can we add a Cancel button to interrupt the
                * ongoing agent's thinking process"*). One target, in the place the hand already is, and the panel keeps the
                * conversation: stopping ends this answer, not the chat.
                *
                * The word is Stop, not Cancel: on a run, Cancel means the run is finished for good (task 15.90). Here the
                * thread survives and the next question continues it, so "Cancel" would promise the wrong thing.
                */}
              {pending
                ? <AsyncButton data-testid="assistant-cancel" variant="outline" className="shrink-0" busy={stopping} onClick={async () => { setStopping(true); await stop(); setStopping(false); }} title="Stop this answer. The conversation stays: ask something else straight after">Stop</AsyncButton>
                : <AsyncButton data-testid="assistant-send" variant="default" className="shrink-0" disabled={!question.trim()} onClick={() => ask(question)}>Ask</AsyncButton>}
            </div>
          </div>
      </aside>

      {/*
        * Deleting a conversation, asked once. Its messages are deleted with it — the server removes every row of the
        * thread, not just the title — and the panel says so before it happens rather than after.
        */}
      {removingThread && (
        <Modal title={`Delete \u201c${removingThread.title || "this conversation"}\u201d?`} testid="confirm-thread-delete" onClose={() => setRemovingThread(null)}>
          <p className="mb-3 text-sm">The conversation and everything in it — the questions, the answers, the tool calls — will be deleted. <b>This cannot be undone.</b></p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="confirm-thread-delete-keep" onClick={() => setRemovingThread(null)}>Keep</Button>
            <AsyncButton variant="destructive" data-testid="confirm-thread-delete-yes"
              onClick={async () => { const id = removingThread.id; setRemovingThread(null); setHistoryOpen(false); await deleteThread(id); }}>
              Delete conversation
            </AsyncButton>
          </div>
        </Modal>
      )}
    </>
  );
}

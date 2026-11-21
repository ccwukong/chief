import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, get, usd } from "./api";
import { SHOW_COST } from "./features";
import { AsyncButton, ErrorBox, Help, Spinner, useDraft } from "./ui";
import { FormattedMarkdown } from "./text-view";
import { ModelSelect } from "./designer/panel";
import { designerBridge } from "./designer/bridge";

interface Change { workflow: string; before: any; after: any; summary: string[] }
/** A schedule the assistant wrote, as the answer recorded it (task 15.33). */
interface Schedule { action: "create" | "update"; workflow: string; id: number | null; cron?: string; inputs?: Record<string, unknown>; enabled?: boolean; description: string }
interface Turn { id: number; ts: string; role: "user" | "assistant"; text: string; meta?: { adapter: string; model: string | null; cost_usd: number; resumed: boolean; run_id: number | null; error?: string | null; workflow?: string | null; change?: Change | null; change_error?: string | null; schedule?: Schedule | null; schedule_error?: string | null; options?: { question: string; options: string[] } | null } }

const sameCanvas = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The assistant (task 9.64): a floating button with the chief logo in the bottom right corner of
 * every page. It opens a chat panel. The run on show, if any, is the assistant's context; otherwise
 * it answers about chief as a whole (workflows, runs, gates). One conversation, kept in the
 * database; the typed question is a draft until it is sent; whether the panel is open is kept too.
 *
 * In the designer (task 9.65, `designing` is the open workflow's name, "" for a new one) the
 * workflow on the canvas is the context and the assistant builds and changes it: the canvas is
 * sent with the question, and a changed workflow that comes back is put on the canvas, where the
 * designer's autosave stores it like a change made by hand. Each change can be undone from here.
 */
export function Assistant({ runId, designing = null }: { runId: number | null; designing?: string | null }) {
  const [open, setOpen] = useDraft<boolean>("ui:assistant-open", false);
  const [info, setInfo] = useState<{ adapter: string; conversation: Turn[] } | null>(null);
  const [question, setQuestion, clearQuestion] = useDraft<string>("assistant:question", "");
  const [model, setModel] = useDraft<string>("assistant:model", "");
  /** The question being answered right now, shown at the end of the conversation while the agent works. */
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Answers whose change was not put on the canvas because the canvas had been edited meanwhile. */
  const [held, setHeld] = useState<number[]>([]);
  const inDesigner = designing != null;
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const load = () => get(`/api/assistant`).then(setInfo).catch((e) => setError(e.message));
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

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    setPending(q); setError(null);
    // The box is emptied as the message goes; if sending fails, the text is put back so nothing typed is lost.
    clearQuestion();
    try {
      // In the designer the canvas goes along, exactly as it is now (the working copy, valid or not).
      const sent = inDesigner ? designerBridge.get()?.snapshot() ?? null : null;
      const r = await api("POST", "/api/assistant", { question: q, ...(model ? { model } : {}), ...(sent ? { workflow: { definition: sent.definition, base_dir: sent.baseDir.trim() || undefined } } : runId != null ? { run_id: runId } : {}) });
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
  const reset = async () => {
    setError(null);
    try { await api("DELETE", "/api/assistant"); await load(); } catch (e: any) { setError(e.message); }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(question); }
    if (e.key === "Escape") setOpen(false);
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
    ? designing ? ["Explain this workflow step by step", "Design the data format between the steps: what each step returns and what the next ones read", "What could go wrong in this workflow, and how would you fix it?", "Run this workflow every weekday at 9am", "Add a step where I approve the result before the last step"] : ["What can a workflow do? Show me a small example on the canvas"]
    : runId != null
    ? ["What went wrong, and what should I do next?", `Summarise run #${runId} in plain words`, "What did each step produce?"]
    : ["Which runs failed, and why?", "What is waiting for me?", "What do my workflows do?"];
  /** The choices the latest answer offers, until the next message is sent. */
  const offered = !pending && turns.at(-1)?.role === "assistant" ? turns.at(-1)!.meta?.options ?? null : null;
  const context = inDesigner ? (designing ? `designing ${designing}` : "designing a new workflow") : runId != null ? `about run #${runId}` : "about chief";

  return (
    <>
      <button type="button" data-testid="assistant-button" aria-label={open ? "Close the assistant" : "Open the assistant"} title={open ? "Close the assistant" : "Ask the assistant"}
        aria-expanded={open} aria-controls="assistant-panel" onClick={() => setOpen(!open)}
        className="fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-slate-200 bg-surface shadow-lg hover:shadow-xl">
        <img src="/logo.svg" alt="" className="h-8 w-8 rounded-md" />
      </button>
      {open && (
        <div id="assistant-panel" data-testid="assistant-panel" data-run={runId ?? ""} data-designing={designing ?? undefined} role="dialog" aria-label="Assistant"
          className="fixed bottom-20 right-4 z-50 flex h-[640px] max-h-[calc(100vh-6rem)] w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-2xl">
          <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
            <img src="/logo.svg" alt="" className="h-6 w-6 rounded-md" />
            <span className="text-sm font-semibold">Assistant<Help id="assistant" /></span>
            <span data-testid="assistant-context" className={`truncate rounded-full px-2 py-0.5 text-2xs ${inDesigner ? "bg-purple-100 text-purple-900" : runId != null ? "bg-blue-100 text-blue-900" : "bg-slate-100 text-slate-600"}`} title={inDesigner ? "The assistant is given the workflow on the canvas and can build and change it" : runId != null ? "The assistant is given this run's full record" : "The assistant is given your workflows, recent runs and waiting gates"}>
              {context}
            </span>
            <div className="ml-auto flex items-center gap-1">
              {turns.length > 0 && <AsyncButton data-testid="assistant-new" className="btn px-2 py-1 text-xs" disabled={!!pending} onClick={reset}>New chat</AsyncButton>}
              <button type="button" data-testid="assistant-close" aria-label="Close the assistant" className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900" onClick={() => setOpen(false)}>
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
          </div>

          <div ref={list} data-testid="assistant-conversation" className="flex-1 space-y-2 overflow-auto bg-slate-50 p-3">
            {turns.length === 0 && !pending && (
              <div className="text-sm text-slate-600" data-testid="assistant-empty">
                {inDesigner
                  ? <p>Tell me what the workflow should do, or what to change: I add, remove and connect steps and write their prompts, directly on the canvas. I can also add or change a schedule for it: "every weekday at 9am". Every change I make can be undone here. I run nothing and choose no models.</p>
                  : <p>Ask about {runId != null ? `run #${runId}` : "your workflows, runs and gates"}. I answer from what chief has recorded; I have no tools and change nothing.</p>}
              </div>
            )}
            {turns.map((t, i) => t.role === "user" ? (
              <div key={t.id} data-testid="assistant-turn-user" data-index={i} className="ml-8 whitespace-pre-wrap rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white">{t.text}</div>
            ) : (
              <div key={t.id} data-testid="assistant-turn-assistant" data-index={i} data-error={t.meta?.error ? "true" : undefined} className="mr-8 rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm">
                {t.meta?.error ? <div className="text-red-700">I could not answer: {t.meta.error}</div> : <div className="md text-sm"><FormattedMarkdown text={t.text} /></div>}
                {t.meta?.change && (
                  <div data-testid="assistant-change" data-held={held.includes(t.id) ? "true" : undefined} className="mt-2 rounded border border-purple-200 bg-purple-50 px-2 py-1.5 text-xs text-purple-950">
                    <div className="font-semibold">{held.includes(t.id) ? "Not put on the canvas: you edited it while I worked. Apply replaces what is there with my version; or ask me again." : `Changed ${t.meta.change.workflow}`}</div>
                    <ul className="mt-0.5 list-disc pl-4">{t.meta.change.summary.map((line) => <li key={line}>{line}</li>)}</ul>
                    {fits(t.meta.change) ? (
                      <div className="mt-1.5 flex gap-1.5">
                        {held.includes(t.id)
                          ? <button type="button" data-testid="assistant-apply" className="btn px-2 py-0.5 text-xs" onClick={() => put(t, "after")}>Apply</button>
                          : <>
                            {(t.meta.change.before?.nodes ?? []).length > 0 && <button type="button" data-testid="assistant-undo" className="btn px-2 py-0.5 text-xs" onClick={() => put(t, "before")}>Undo</button>}
                            <button type="button" data-testid="assistant-apply" className="btn px-2 py-0.5 text-xs" onClick={() => put(t, "after")}>Apply again</button>
                          </>}
                      </div>
                    ) : <div className="mt-1 text-purple-800">Open {t.meta.change.workflow} in the designer to undo or apply this.</div>}
                  </div>
                )}
                {t.meta?.change_error && (
                  <div data-testid="assistant-change-error" className="mt-2 whitespace-pre-wrap rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-950"><b>The canvas was not changed.</b> chief did not accept the workflow I wrote:{"\n"}{t.meta.change_error}</div>
                )}
                {t.meta?.schedule && (
                  <div data-testid="assistant-schedule" data-action={t.meta.schedule.action} className="mt-2 rounded border border-teal-200 bg-teal-50 px-2 py-1.5 text-xs text-teal-950">
                    <div className="font-semibold">{t.meta.schedule.action === "create" ? `Scheduled ${t.meta.schedule.workflow}` : `Changed schedule #${t.meta.schedule.id} of ${t.meta.schedule.workflow}`}</div>
                    <div className="mt-0.5">{t.meta.schedule.description}</div>
                    {/* The list is a page of its own; this says where it went rather than making a second list here. */}
                    <div className="mt-0.5 text-teal-800">It is on the <a href="#/schedules" className="underline">Schedules</a> page.</div>
                  </div>
                )}
                {t.meta?.schedule_error && (
                  <div data-testid="assistant-schedule-error" className="mt-2 whitespace-pre-wrap rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-950"><b>No schedule was written.</b> chief did not accept what I asked for:{"\n"}{t.meta.schedule_error}</div>
                )}
                <div className="mt-1 text-2xs text-slate-500" data-testid="assistant-turn-meta">{t.meta?.adapter}{t.meta?.model ? ` · ${t.meta.model}` : ""}{SHOW_COST ? ` · ${usd(t.meta?.cost_usd)}` : ""}{t.meta?.run_id != null ? ` · run #${t.meta.run_id}` : ""}{t.meta?.resumed ? " · continued" : ""}</div>
              </div>
            ))}
            {pending && (
              <>
                <div data-testid="assistant-turn-pending" className="ml-8 whitespace-pre-wrap rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white">{pending}</div>
                <div className="mr-8 flex items-center gap-2 rounded-lg border border-slate-200 bg-surface px-3 py-2 text-sm text-slate-500"><Spinner /> {inDesigner ? "Working on the workflow…" : "Reading what chief has recorded…"}</div>
              </>
            )}
          </div>

          <div className="border-t border-slate-200 p-2">
            <ErrorBox error={error} testid="assistant-error" />
            {turns.length === 0 && !pending && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {suggestions.map((s, i) => (
                  <button key={s} type="button" data-testid={`assistant-suggestion-${i}`} className="rounded-full border border-slate-300 bg-surface px-2.5 py-0.5 text-xs text-slate-700 hover:bg-slate-100" onClick={() => ask(s)}>{s}</button>
                ))}
              </div>
            )}
            {offered && (
              <div data-testid="assistant-options" className="mb-2">
                {offered.question && <div className="mb-1 text-xs font-medium text-slate-700">{offered.question}</div>}
                <div className="flex flex-col items-start gap-1">
                  {offered.options.map((o, i) => (
                    <button key={o} type="button" data-testid={`assistant-option-${i}`} className="rounded border border-slate-300 bg-surface px-2.5 py-1 text-left text-xs text-slate-800 hover:border-blue-400 hover:bg-blue-50" onClick={() => ask(o)}>{o}</button>
                  ))}
                  {/* Always there: the person's own answer, typed in the box below. */}
                  <button type="button" data-testid="assistant-option-own" className="rounded border border-dashed border-slate-400 bg-surface px-2.5 py-1 text-left text-xs text-slate-600 hover:border-blue-400 hover:bg-blue-50" onClick={() => input.current?.focus()}>Something else: type your own below</button>
                </div>
              </div>
            )}
            {/* The question box takes the panel's width and grows with what is typed, up to a third of the window. */}
            <textarea ref={input} data-testid="assistant-question" rows={4} className="input block w-full resize-none text-sm leading-5" style={{ minHeight: "6rem", maxHeight: "33vh" }}
              placeholder={inDesigner ? (offered ? "Your own answer…" : "Describe the workflow, or a change…") : runId != null ? `Ask about run #${runId}…` : "Ask about your runs…"}
              value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={onKey} disabled={!!pending} />
            <div className="mt-1.5 flex items-center gap-2 [&_label]:mb-0 [&_label]:min-w-0 [&_label]:flex-1 [&_select]:py-0.5 [&_select]:text-xs [&_.label]:hidden">
              {info ? <ModelSelect adapter={info.adapter} value={model || undefined} onChange={setModel} testid="assistant-model" /> : <span className="flex-1" />}
              <span className="hidden shrink-0 text-2xs text-slate-400 sm:inline">Enter sends · Shift+Enter new line</span>
              <AsyncButton data-testid="assistant-send" className="btn btn-primary shrink-0" disabled={!question.trim() || !!pending} busy={!!pending} onClick={() => ask(question)}>Ask</AsyncButton>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

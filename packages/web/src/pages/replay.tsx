import { useEffect, useMemo, useRef, useState } from "react";
import { get } from "../api";
import { JsonCode, jsonProblem } from "../json-editor";
import { looksLikeJson } from "../text-view";
import { Button } from "../components/ui/button";
import { Select } from "../components/ui/select";
import { Card } from "../components/ui/card";

interface Msg { id: number; node_id: string | null; node_run_id: number | null; ts: string; direction: "in" | "out" | "user" | "system"; kind: string; content: string; meta: any }

/**
 * One line for an event chief wrote into the record: its payload, as `key value · key value`.
 *
 * Events have no `content` — the payload lives in `meta`, because it is what the engine reported rather than something a
 * worker was sent or said. Without this the row read "(no content)" and the facts were two clicks away in Details, which is
 * why a separate event-log panel existed. `node_id` is already in the row's own label, so it is left out here.
 */
function payloadLine(meta: any): string {
  if (!meta || typeof meta !== "object") return "";
  return Object.entries(meta)
    .filter(([k, v]) => k !== "node_id" && v != null && v !== "" && v !== false)
    .map(([k, v]) => `${k.replace(/_/g, " ")} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

const WHO: Record<string, [string, string]> = {
  in: ["→ to worker", "bg-accent text-primary"],
  out: ["← from worker", "bg-green-50 text-green-900"],
  user: ["● you", "bg-amber-50 text-amber-900"],
  system: ["· chief", "bg-slate-100 text-slate-700"],
};

/**
 * Plays back everything recorded for a run, in order: prompts as sent, agent replies, tool calls
 * and their results, script input and output, your answers, status changes and errors.
 * It reads the stored record; nothing is executed again.
 */
export function Replay({ runId, count }: { runId: number; count: number }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [node, setNode] = useState("");
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const last = useRef(0);

  // `count` comes from the run detail and grows as the run goes on: fetch only what is new.
  useEffect(() => {
    let live = true;
    get<Msg[]>(`/api/runs/${runId}/transcript?after=${last.current}`).then((more) => {
      if (!live || !more.length) return;
      last.current = more[more.length - 1].id;
      setMsgs((cur) => [...cur, ...more.filter((m) => !cur.some((c) => c.id === m.id))]);
    }).catch(() => {});
    return () => { live = false; };
  }, [runId, count]);

  const nodes = useMemo(() => [...new Set(msgs.map((m) => m.node_id).filter(Boolean))] as string[], [msgs]);
  const shown = useMemo(() => (node ? msgs.filter((m) => m.node_id === node) : msgs), [msgs, node]);
  const at = Math.min(pos, Math.max(0, shown.length - 1));
  const cur = shown[at];

  useEffect(() => {
    if (!playing) return;
    if (at >= shown.length - 1) { setPlaying(false); return; }
    const t = setTimeout(() => setPos(at + 1), 900);
    return () => clearTimeout(t);
  }, [playing, at, shown.length]);

  // Keep the current message in view inside the list of messages. Only the list is scrolled, never the
  // page: scrolling the page here moved a run that had just been opened down to its replay.
  useEffect(() => {
    const row = document.querySelector<HTMLElement>(`[data-replay-row="${cur?.id}"]`);
    let list = row?.parentElement ?? null;
    while (list && !/(auto|scroll)/.test(getComputedStyle(list).overflowY)) list = list.parentElement;
    if (!row || !list || list === document.scrollingElement || list.matches("main, [data-testid='run-panel-scroll']")) return;
    const r = row.getBoundingClientRect(), l = list.getBoundingClientRect();
    if (r.top < l.top) list.scrollTop -= l.top - r.top;
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
  }, [cur?.id]);

  return (
    <Card asChild className="mb-5"><details data-testid="replay" open>
      <summary className="cursor-pointer text-sm font-semibold">Replay <span className="font-normal text-slate-500" data-testid="replay-count">({msgs.length} recorded messages)</span></summary>
      <p className="mt-1 text-xs text-slate-500">Everything this run sent and received, in order. Step through it to see what happened; nothing is run again.</p>
      <div className="my-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" data-testid="replay-first"  disabled={at === 0} onClick={() => { setPlaying(false); setPos(0); }}>⏮ First</Button>
        <Button variant="outline" data-testid="replay-prev"  disabled={at === 0} onClick={() => { setPlaying(false); setPos(at - 1); }}>◀ Previous</Button>
        <Button variant="default" data-testid="replay-play"  disabled={shown.length < 2} onClick={() => { if (!playing && at >= shown.length - 1) setPos(0); setPlaying(!playing); }}>{playing ? "⏸ Pause" : "▶ Play"}</Button>
        <Button variant="outline" data-testid="replay-next"  disabled={at >= shown.length - 1} onClick={() => { setPlaying(false); setPos(at + 1); }}>Next ▶</Button>
        <span className="mono text-xs text-slate-600" data-testid="replay-position">{shown.length ? `${at + 1} / ${shown.length}` : "0 / 0"}</span>
        <Select className="ml-auto w-48" data-testid="replay-node"  value={node} onChange={(e) => { setNode(e.target.value); setPos(0); setPlaying(false); }}>
          <option value="">all nodes</option>
          {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
      </div>
      <div className="flex flex-col gap-3 md:flex-row">
        <div className="max-h-96 w-full shrink-0 md:w-80 overflow-auto rounded border border-slate-200 text-xs" data-testid="replay-list">
          {shown.map((m, i) => (
            <Button variant="ghost" key={m.id} data-replay-row={m.id} data-testid={`replay-row-${m.id}`} data-kind={m.kind} data-direction={m.direction} aria-current={i === at ? "true" : undefined} className={`flex w-full items-center justify-start gap-2 border-b border-slate-100 px-2 py-1 text-left ${i === at ? "bg-accent" : "hover:bg-slate-50"}`} onClick={() => { setPlaying(false); setPos(i); }}>
              <span className="mono text-slate-400">{new Date(m.ts).toLocaleTimeString([], { hour12: false })}</span>
              <span className={`rounded px-1 ${WHO[m.direction]?.[1] ?? ""}`}>{m.kind}</span>
              <span className="truncate text-slate-600">{m.node_id ?? ""}{m.meta?.name ? ` · ${String(m.meta.name).split("__").pop()}` : ""}</span>
              {(m.meta?.is_error || /failed|error/.test(m.kind)) && <span className="ml-auto text-red-700">!</span>}
            </Button>
          ))}
          {shown.length === 0 && <div className="p-3 text-slate-500">Nothing recorded yet.</div>}
        </div>
        <div className="min-w-0 flex-1">
          {cur && (
            <>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs" data-testid="replay-head">
                <span className={`rounded px-1.5 py-0.5 font-semibold ${WHO[cur.direction]?.[1] ?? ""}`}>{WHO[cur.direction]?.[0] ?? cur.direction}</span>
                <b data-testid="replay-kind">{cur.kind}</b>
                {cur.node_id && <span className="text-slate-600">node {cur.node_id}{cur.node_run_id ? ` (#${cur.node_run_id})` : ""}</span>}
                {cur.meta?.name && <span className="mono text-slate-600">{cur.meta.name}</span>}
                {cur.meta?.is_error && <span className="rounded bg-red-100 px-1.5 text-red-800">error</span>}
                <span className="ml-auto text-slate-400">{new Date(cur.ts).toLocaleTimeString()}</span>
              </div>
              {looksLikeJson(cur.content) && !jsonProblem(cur.content)
                ? <JsonCode testid="replay-content" maxRows={20} value={cur.content} />
                : cur.content || payloadLine(cur.meta)
                  ? <pre data-testid="replay-content" className="mono max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs">{cur.content || payloadLine(cur.meta)}</pre>
                  // A transition chief reported with nothing in it (`run_started`, `run_completed`): the head above already
                  // says which one it was and when. A "(nothing reported)" box here would be a third way of saying nothing.
                  : null}
              {cur.meta && Object.keys(cur.meta).length > 0 && (
                <details className="mt-1 text-xs text-slate-600"><summary className="cursor-pointer">Details</summary><div className="mt-1"><JsonCode testid="replay-meta" maxRows={12} value={JSON.stringify(cur.meta, null, 2)} /></div></details>
              )}
            </>
          )}
        </div>
      </div>
    </details></Card>
  );
}

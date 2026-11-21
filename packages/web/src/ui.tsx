import { JsonEditor } from "./json-editor";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { HELP } from "./help";
import { api, STATUS_COLOR } from "./api";

export function Status({ value, testid }: { value: string; testid?: string }) {
  return <span data-testid={testid} data-status={value} className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[value] ?? "bg-slate-200"}`}>{value.replace("_", " ")}</span>;
}

export function ErrorBox({ error, testid = "error" }: { error: string | null; testid?: string }) {
  if (!error) return null;
  return <div data-testid={testid} className="mb-3 whitespace-pre-wrap rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>;
}

/**
 * The "?" next to a setting. Shows what the setting is for and an example, on hover, on keyboard
 * focus and on click. The text comes from help.ts. The bubble is positioned against the window,
 * not its panel, so that a scrolling side panel does not cut it off.
 */
export function Help({ id }: { id: string }) {
  const entry = HELP[id];
  // Shown while the pointer is over it, or while it is pinned (by a click, or by reaching it with the keyboard).
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  // The bubble's box on the page: where it starts, and how tall it may be. A zero height means "not placed
  // yet", during the render that opens it.
  const [pos, setPos] = useState({ top: 0, left: 0, maxHeight: 0 });
  const btn = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const open = hover || pinned;
  // Keep the whole bubble on the page without ever covering the "?" it belongs to: it goes below the "?"
  // when there is more room there and above it otherwise, and its height is the room on that side (it
  // scrolls past that). A bubble laid over its own button swallows the click that would close it.
  useLayoutEffect(() => {
    if (!open || !btn.current || !bubble.current) return;
    const r = btn.current.getBoundingClientRect(), edge = 8, gap = 6;
    const below = window.innerHeight - edge - (r.bottom + gap), above = r.top - gap - edge;
    const down = below >= above;
    const maxHeight = Math.max(60, down ? below : above);
    const h = Math.min(bubble.current.offsetHeight, maxHeight);
    const top = down ? r.bottom + gap : Math.max(edge, r.top - gap - h);
    const left = Math.max(edge, Math.min(r.left - edge, window.innerWidth - 328));
    if (Math.abs(pos.top - top) < 0.5 && pos.left === left && pos.maxHeight === maxHeight) return;
    setPos({ top, left, maxHeight });
  }, [open, pos.top, pos.left, pos.maxHeight]);
  if (!entry) return null;
  return (
    <span className="ml-1 inline-block align-middle" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button ref={btn} type="button" data-testid={`help-${id}`} aria-label="What is this?" aria-expanded={open}
        className="h-4 w-4 rounded-full border border-slate-400 bg-surface text-2xs font-bold leading-none text-slate-600 hover:bg-slate-200 focus:outline-2 focus:outline-blue-500"
        // Inside a <label>: without preventDefault a click would move the cursor into the field.
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPinned((p) => !p); }}
        onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) setPinned(true); }}
        onBlur={() => setPinned(false)}
        onKeyDown={(e) => { if (e.key === "Escape") { setPinned(false); setHover(false); } }}>?</button>
      {open && (
        <span ref={bubble} role="tooltip" data-testid={`help-text-${id}`}
          style={{ position: "fixed", top: pos.top, left: pos.left, maxHeight: pos.maxHeight ? `${pos.maxHeight}px` : "calc(100vh - 16px)" }}
          className="z-50 block w-80 overflow-auto rounded border border-slate-300 bg-surface p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-slate-700 shadow-xl">
          {entry.text}
          {entry.use && <><span className="mt-2 block font-semibold text-slate-500">Use case</span><span data-testid={`help-use-${id}`} className="block">{entry.use}</span></>}
          {entry.example && <><span className="mt-2 block font-semibold text-slate-500">Example</span><code className="mono mt-0.5 block whitespace-pre-wrap rounded bg-slate-100 p-1.5 text-slate-800">{entry.example}</code></>}
        </span>
      )}
    </span>
  );
}

/** `hint` is text under the field; it may be marked up (a warning in amber, for instance). */
export function Field({ label, children, hint, help }: { label: string; children: ReactNode; hint?: ReactNode; help?: string }) {
  return (
    <label className="mb-3 block min-w-0">
      <span className="label">{label}{help && <Help id={help} />}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Modal({ title, children, onClose, testid }: { title: string; children: ReactNode; onClose: () => void; testid?: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div data-testid={testid} className="max-h-[85vh] w-[640px] max-w-[95vw] overflow-auto rounded bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A small turning circle, in the current text colour. */
export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg data-testid="spinner" viewBox="0 0 24 24" className={`animate-spin ${className}`} fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A button for an action that takes a moment (it calls the server). While its `onClick` is
 * running the label is replaced by a spinner, the button keeps its size, and it cannot be
 * clicked again. Every such button in the UI is one of these.
 */
export function AsyncButton({ onClick, busy, disabled, className = "btn", children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & { onClick: () => unknown; busy?: boolean }) {
  const [running, setRunning] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const spinning = running || !!busy;
  const click = async () => {
    if (spinning) return;
    setRunning(true);
    try { await onClick(); } finally { if (mounted.current) setRunning(false); }
  };
  return (
    <button {...rest} className={`${className} relative`} disabled={disabled || spinning} aria-busy={spinning || undefined} onClick={click}>
      <span className={spinning ? "invisible" : undefined}>{children}</span>
      {spinning && <span className="absolute inset-0 flex items-center justify-center"><Spinner /></span>}
    </button>
  );
}

/** Runs that have stopped for good. Only these can be deleted. */
export const FINISHED = ["completed", "failed", "reverted", "cancelled"];

/** The confirmation before deleting runs: says what goes and that it cannot be undone. */
export function ConfirmDeleteRuns({ ids, onDone, onClose }: { ids: number[]; onDone: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const one = ids.length === 1;
  const confirm = async () => {
    setBusy(true); setError(null);
    try { await api("POST", "/api/runs/delete", { ids }); onDone(); } catch (e: any) { setError(e.message); setBusy(false); }
  };
  return (
    <Modal title={one ? `Delete run #${ids[0]}?` : `Delete ${ids.length} runs?`} onClose={onClose} testid="confirm-delete">
      <ErrorBox error={error} testid="confirm-delete-error" />
      <p className="mb-2 text-sm">{one ? "The run and everything recorded for it" : "These runs and everything recorded for them"} (steps, gate answers, side effects, the replay) will be deleted. <b>This cannot be undone.</b></p>
      <p className="mb-4 text-sm text-slate-600">What {one ? "the run" : "they"} changed outside chief stays as it is. To undo it, revert {one ? "the run" : "each run"} before deleting.</p>
      <div className="flex justify-end gap-2">
        <button data-testid="confirm-delete-keep" className="btn" disabled={busy} onClick={onClose}>Keep</button>
        <AsyncButton data-testid="confirm-delete-yes" className="btn btn-danger" busy={busy} onClick={confirm}>{one ? "Delete run" : `Delete ${ids.length} runs`}</AsyncButton>
      </div>
    </Modal>
  );
}

export const PAGE_SIZES = [25, 50, 100];

/**
 * Paging for a list page: the range shown and the total, the page size, previous and next.
 * Every list page uses it, so that no list grows without end.
 */
export function Pager({ page, perPage, total, onPage, onPerPage, sizes = PAGE_SIZES, testid = "pager" }: { page: number; perPage: number; total: number; onPage: (p: number) => void; onPerPage: (n: number) => void; sizes?: number[]; testid?: string }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const from = total ? (page - 1) * perPage + 1 : 0, to = Math.min(page * perPage, total);
  return (
    <div data-testid={testid} className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-600">
      <span data-testid={`${testid}-range`}>{total ? `${from}–${to} of ${total}` : "None"}</span>
      <label className="flex items-center gap-2">Per page
        <select data-testid={`${testid}-size`} className="input w-20" value={perPage} onChange={(e) => onPerPage(Number(e.target.value))}>
          {sizes.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <div className="ml-auto flex items-center gap-2">
        <button data-testid={`${testid}-prev`} className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <span data-testid={`${testid}-page`} className="whitespace-nowrap">Page {page} of {pages}</span>
        <button data-testid={`${testid}-next`} className="btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

/** Text area bound to a JSON value. Invalid JSON is flagged and not propagated. */
export function JsonField({ value, onChange, testid, rows = 4, placeholder }: { value: unknown; onChange: (v: unknown) => void; testid?: string; rows?: number; placeholder?: string }) {
  const asText = (v: unknown) => (v === undefined || v === null ? "" : JSON.stringify(v, null, 2));
  const [text, setText] = useState(asText(value));
  const [bad, setBad] = useState(false);
  useEffect(() => { if (!bad) setText((t) => { try { return JSON.stringify(t.trim() ? JSON.parse(t) : undefined) === JSON.stringify(value ?? undefined) ? t : asText(value); } catch { return asText(value); } }); }, [value, bad]);
  return (
    <>
      <JsonEditor testid={testid} rows={rows} placeholder={placeholder} invalid={bad} value={text}
        onChange={(t) => {
          setText(t);
          if (!t.trim()) { setBad(false); onChange(undefined); return; }
          try { onChange(JSON.parse(t)); setBad(false); } catch { setBad(true); }
        }} />
      {bad && <span className="text-xs text-red-700">The last valid value is kept.</span>}
    </>
  );
}

export function useHashRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

export const go = (path: string) => { window.location.hash = path; };

// ── drafts: everything typed is kept in chief's database until it is saved or sent ──────────
// Drafts live in the `draft` schema of the one SQLite file (not in browser storage), so they
// survive a refresh and are the same in every browser. They are loaded once at start-up and
// every change is written through immediately.

const cache = new Map<string, unknown>();
let seq = Date.now() * 1000;
let inFlight = 0;
const track = (d: number) => { inFlight += d; (window as any).__chiefDraftWrites = inFlight; };

function send(method: string, url: string, body?: unknown) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  track(1);
  // keepalive lets the request finish even if the page is being refreshed right now (browsers cap it at 64 KB).
  fetch(url, { method, body: payload, headers: payload ? { "Content-Type": "application/json" } : undefined, keepalive: !payload || payload.length < 60_000 })
    .catch(() => { /* the draft stays in memory; the next change tries again */ })
    .finally(() => track(-1));
}

/** Load all drafts from the database. Called once before the app renders. */
export async function loadDrafts(): Promise<void> {
  track(0);
  try {
    const res = await fetch("/api/drafts");
    if (res.ok) for (const [k, v] of Object.entries(await res.json())) cache.set(k, v);
  } catch { /* start without drafts */ }
  // Drafts used to be kept in browser storage; nothing is stored there any more.
  try { for (const k of Object.keys(localStorage)) if (k.startsWith("chief:draft:")) localStorage.removeItem(k); } catch { /* ignore */ }
}

export function readDraft<T = any>(key: string): T | null {
  return cache.has(key) ? (cache.get(key) as T) : null;
}
export function writeDraft(key: string, value: unknown) {
  cache.set(key, value);
  send("PUT", `/api/drafts/${encodeURIComponent(key)}`, { value, seq: ++seq });
}
export function removeDraft(key: string) {
  if (!cache.has(key)) return;
  cache.delete(key);
  send("DELETE", `/api/drafts/${encodeURIComponent(key)}?seq=${++seq}`);
}
/** Remove every draft whose key starts with `prefix` (for example all fields of one gate). */
export function removeDrafts(prefix: string) {
  let any = false;
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) { cache.delete(k); any = true; }
  if (any) send("DELETE", `/api/drafts?prefix=${encodeURIComponent(prefix)}&seq=${++seq}`);
}

/**
 * State that survives a page refresh. It is written to the database on every change and removed
 * when it equals `initial` again or when `clear` is called (after a save or a submit).
 */
/** Below this window width the designer gives its canvas the room: icon sidebar, slim block rail, panel on demand. A 14-inch laptop is about 1512 wide. */
export const COMPACT_BELOW = 1600;
/** The window's width, kept up to date. */
export function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export function useDraft<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(() => readDraft<T>(key) ?? initial);
  useEffect(() => {
    if (JSON.stringify(value) === JSON.stringify(initial)) removeDraft(key); else writeDraft(key, value);
    // `initial` is a constant per call site.
  }, [key, value]);
  const clear = useCallback(() => { removeDraft(key); setValue(initial); }, [key]);
  return [value, setValue, clear];
}

import { JsonEditor } from "./json-editor";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { HELP } from "./help";
import { api, STATUS_COLOR } from "./api";
import { Button } from "./components/ui/button";
import { Spinner as UiSpinner } from "./components/ui/spinner";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { Label } from "./components/ui/label";
import { cn } from "./lib/utils";
import { Select } from "./components/ui/select";
import { Badge } from "./components/ui/badge";

/**
 * A run's or a step's status: shadcn's badge shape, with chief's own status colours.
 *
 * `STATUS_COLOR` is what the run record uses everywhere (and what E9.30-1 and the diagram check), so the badge takes its
 * palette from there rather than inventing a second one.
 */
export function Status({ value, testid }: { value: string; testid?: string }) {
  // A status is a badge; its colour is chief's own (`STATUS_COLOR`), which the badge takes through `className`.
  return (
    <Badge data-testid={testid} data-status={value} variant="outline"
      className={cn("border-transparent font-semibold", STATUS_COLOR[value] ?? "bg-slate-200")}>
      {value.replace("_", " ")}
    </Badge>
  );
}

/**
 * A delete button: a drawn bin, no fill, no border, no shadow.
 *
 * Asked for three times on 2026-11-22, on three different screens — the run page's header, the runs list's toolbar and each
 * row of that list: *"can we change this to a Bin icon button instead of a big fat delete button?"*. A destructive action
 * inside a header or a list row should not be the loudest thing on the page; the weight belongs in the confirmation, which
 * names what goes and says it cannot be undone. One component, so the three bins cannot drift into three sizes.
 *
 * `label` is the accessible name and is required: a glyph has no text for a screen reader to read.
 */
export function TrashButton({ testid, label, title, size = "md", disabled, onClick }: {
  testid: string; label: string; title?: string; size?: "sm" | "md"; disabled?: boolean; onClick: () => void;
}) {
  return (
    <Button variant="ghost" type="button" data-testid={testid} aria-label={label} title={title ?? `${label}…`} disabled={disabled} onClick={onClick}
      className={cn("shrink-0 px-0 text-slate-500 hover:bg-red-50 hover:text-destructive", size === "sm" ? "h-7 w-7" : "h-8 w-8")}>
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 4.5h11M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3M4.2 4.5l.6 8.3c0 .5.4.9.9.9h4.6c.5 0 .9-.4.9-.9l.6-8.3M6.6 7v4M9.4 7v4" />
      </svg>
    </Button>
  );
}

export function ErrorBox({ error, testid = "error" }: { error: string | null; testid?: string }) {
  if (!error) return null;
  return (
    <div data-testid={testid} role="alert"
      className="mb-3 whitespace-pre-wrap rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-700">
      {error}
    </div>
  );
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
      <Button variant="outline" className="h-4 w-4 rounded-full border border-slate-400 font-bold leading-none focus:outline-2 focus:outline-ring" ref={btn} type="button" data-testid={`help-${id}`} aria-label="What is this?" aria-expanded={open} // Inside a <label>: without preventDefault a click would move the cursor into the field.
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPinned((p) => !p); }}
        onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) setPinned(true); }}
        onBlur={() => setPinned(false)}
        onKeyDown={(e) => { if (e.key === "Escape") { setPinned(false); setHover(false); } }}>?</Button>
      {open && (
        <span ref={bubble} role="tooltip" data-testid={`help-text-${id}`}
          style={{ position: "fixed", top: pos.top, left: pos.left, maxHeight: pos.maxHeight ? `${pos.maxHeight}px` : "calc(100vh - 16px)" }}
          className="z-50 block w-80 overflow-auto rounded border border-slate-300 bg-surface p-3 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-slate-700 shadow-xl">
          {/* `pre-line`, so an entry written as one line per idea reads as lines instead of collapsing into
              a single blob: the four building blocks are a list, not a paragraph (reported 2026-11-21: "too
              clunky and poorly arranged, impossible to read"). */}
          <span className="block whitespace-pre-line">{entry.text}</span>
          {entry.use && <><span className="mt-2 block font-semibold text-slate-500">Use case</span><span data-testid={`help-use-${id}`} className="block">{entry.use}</span></>}
          {entry.example && <><span className="mt-2 block font-semibold text-slate-500">Example</span><code data-testid={`help-example-${id}`} className="mono mt-0.5 block whitespace-pre-wrap rounded bg-slate-100 p-1.5 text-slate-800">{entry.example}</code></>}
        </span>
      )}
    </span>
  );
}

/** `hint` is text under the field; it may be marked up (a warning in amber, for instance). */
export function Field({ label, children, hint, help }: { label: string; children: ReactNode; hint?: ReactNode; help?: string }) {
  return (
    <label className="mb-3 block min-w-0">
      <Label asChild><span className="label">{label}{help && <Help id={help} />}</span></Label>
      {children}
      {/* The explanation under a field is body text, not a footnote: at 12 px it was the smallest thing on the page a
          person has to actually read (asked 2026-11-22). */}
      {/* A hint may carry a path (a default workspace, the home folder): a long one must wrap, not widen the page
          (found at 375 px in E9.28-2, 2026-11-23). */}
      {hint && <span className="mt-1 block text-sm text-slate-500 [overflow-wrap:anywhere]">{hint}</span>}
    </label>
  );
}

/**
 * A dialog: shadcn's, on Radix.
 *
 * chief's own version re-implemented the four hard parts by hand — the focus trap, the scroll lock, `aria-modal` and
 * Escape — and got three of them partly right. Radix does all four, which is the one place a shadcn component replaces
 * behaviour rather than styling. `testid` stays on the content, so every case that finds a dialog still finds it.
 */
export function Modal({ title, children, onClose, testid }: { title: string; children: ReactNode; onClose: () => void; testid?: string }) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent data-testid={testid} aria-describedby={undefined} className="max-h-[85vh] w-[640px] overflow-auto">
        <div className="mb-3 flex items-center justify-between gap-3">
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** A small turning circle, in the current text colour: one spinner for the whole app. */
export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <UiSpinner className={className} />;
}

/**
 * A button for an action that takes a moment (it calls the server). While its `onClick` is
 * running the label is replaced by a spinner, the button keeps its size, and it cannot be
 * clicked again. Every such button in the UI is one of these.
 */
export function AsyncButton({ onClick, busy, disabled, className, variant = "outline", size = "default", children, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  onClick: () => unknown; busy?: boolean; variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  size?: "default" | "sm" | "xs" | "lg" | "icon" | "icon-sm";
}) {
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
    <Button variant={variant} size={size} {...rest} className={cn("relative", className)} disabled={disabled || spinning} aria-busy={spinning || undefined} onClick={click}>
      {/* The button's own layout is inherited by this wrapper, so an icon and a label given to an
          `inline-flex` button stay on one line: as a plain `<span>` it was a block-level-ish inline box
          and the two stacked (reported 2026-11-21: "the icon and the text should be inline"). */}
      <span className={`contents ${spinning ? "invisible" : ""}`}>{children}</span>
      {spinning && <span className="absolute inset-0 flex items-center justify-center"><Spinner /></span>}
    </Button>
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
        <Button variant="outline" data-testid="confirm-delete-keep"  disabled={busy} onClick={onClose}>Keep</Button>
        <AsyncButton data-testid="confirm-delete-yes" variant="destructive" busy={busy} onClick={confirm}>{one ? "Delete run" : `Delete ${ids.length} runs`}</AsyncButton>
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
        <Select className="w-20" data-testid={`${testid}-size`}  value={perPage} onChange={(e) => onPerPage(Number(e.target.value))}>
          {sizes.map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
      </label>
      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" data-testid={`${testid}-prev`}  disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <span data-testid={`${testid}-page`} className="whitespace-nowrap">Page {page} of {pages}</span>
        <Button variant="outline" data-testid={`${testid}-next`}  disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
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
  // A `?query` in the hash is the page's own business (`#/runs?tab=runs`), not part of its path: it is kept out of the
  // parts so a page still matches on its name, and `hashQuery` reads it.
  const read = () => window.location.hash.replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

export const go = (path: string) => { window.location.hash = path; };

/** The `?name=value` pairs in the hash, for a page whose view is part of its address (`#/runs?tab=runs`). */
export function hashQuery(): URLSearchParams {
  const q = window.location.hash.split("?")[1];
  return new URLSearchParams(q ?? "");
}

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

export interface RightPanelResize {
  width: number;
  min: number;
  max: number;
  dragging: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  reset: () => void;
}

/**
 * Horizontal resize for a right-hand side panel (task 15.126).
 *
 * The width is stored in `draft` under `draftKey` (written once when a drag ends, never on every move),
 * clamped to `[min, max]` and never wider than the viewport so 375 px never scrolls sideways.
 * Supports pointer drag, ArrowLeft / ArrowRight (Shift for 64 px), and double-click to reset.
 */
export function useRightPanelResize({
  draftKey,
  defaultWidth,
  minWidth = 360,
  maxWidth,
}: {
  draftKey: string;
  defaultWidth: number | ((winWidth: number) => number);
  minWidth?: number;
  maxWidth?: (winWidth: number) => number;
}): RightPanelResize {
  const [savedWidth, setSavedWidth] = useDraft(draftKey, 0);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const winWidth = useWindowWidth();

  const bounds = (vw: number) => {
    const lo = Math.min(minWidth, vw);
    const rawHi = vw < 640 ? vw : (maxWidth ? maxWidth(vw) : Math.round(vw * 0.85));
    const hi = Math.min(vw, Math.max(lo, rawHi));
    return { lo, hi };
  };
  const clamp = (w: number, vw = window.innerWidth) => {
    const { lo, hi } = bounds(vw);
    return Math.round(Math.min(Math.max(w, lo), hi));
  };

  const { lo: min, hi: max } = bounds(winWidth);
  const resolvedDefault = typeof defaultWidth === "function" ? defaultWidth(winWidth) : defaultWidth;
  const width = clamp(dragWidth ?? (savedWidth || resolvedDefault), winWidth);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startW = width;
    let last = startW, moved = false;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev: PointerEvent) => {
      const next = clamp(startW + (startX - ev.clientX));
      if (next !== startW) moved = true;
      last = next;
      setDragWidth(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (moved) setSavedWidth(last);
      setDragWidth(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") { e.preventDefault(); setSavedWidth(clamp(width + step)); }
    if (e.key === "ArrowRight") { e.preventDefault(); setSavedWidth(clamp(width - step)); }
  };

  const reset = () => setSavedWidth(0);

  return { width, min, max, dragging: dragWidth !== null, onPointerDown, onKeyDown, reset };
}

/** Left-edge resize handle for a right-hand slide-over panel (task 15.126). */
export function PanelResizeHandle({ testid, label, resize }: { testid: string; label: string; resize: RightPanelResize }) {
  return (
    <div
      data-testid={testid}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      aria-valuenow={resize.width}
      aria-valuemin={resize.min}
      aria-valuemax={resize.max}
      title="Drag to resize · double-click to reset"
      className={`group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none ${resize.dragging ? "bg-primary/30" : "hover:bg-primary/20 focus-visible:bg-primary/20"}`}
      onPointerDown={resize.onPointerDown}
      onDoubleClick={resize.reset}
      onKeyDown={resize.onKeyDown}
    >
      <span className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${resize.dragging ? "bg-primary" : "bg-transparent group-hover:bg-primary group-focus-visible:bg-primary"}`} />
    </div>
  );
}

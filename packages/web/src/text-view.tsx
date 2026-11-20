import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDraft } from "./ui";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown as formatted text. HTML tags in the text are left out, never rendered (the raw view
 * shows them), and links open in a new tab: what an agent wrote cannot change the page.
 */
export function FormattedMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={{
      a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" />,
      // A ```json block is coloured like the results are.
      code: ({ node: _n, className, children, ...p }) => /language-json/.test(className ?? "") && typeof children === "string"
        ? <code className={className} data-lang="json" {...p}><JsonColours text={children} /></code>
        : <code className={className} {...p}>{children}</code>,
    }}>
      {text}
    </Markdown>
  );
}

/** Whether a text is JSON (an object or a list), as results and gate questions are. */
export const looksLikeJson = (text: string | null | undefined) => !!text && /^\s*[{[]/.test(text);

// Keys, strings, numbers, and true / false / null. Works on a cut-off text too (a preview).
const JSON_TOKEN = /("(?:\\.|[^"\\])*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

/**
 * JSON with its parts in colour: names, text, numbers, and true / false / null. The characters are
 * exactly those of the text (colour only), so it reads, selects and copies as before.
 */
export function JsonColours({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0, k = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) {
      out.push(<span key={k++} data-json={m[2] ? "key" : "string"} className={m[2] ? "text-sky-800" : "text-emerald-700"}>{m[1]}</span>);
      if (m[2]) out.push(m[2]);
    } else if (m[3] !== undefined) out.push(<span key={k++} data-json="number" className="text-amber-700">{m[3]}</span>);
    else out.push(<span key={k++} data-json="word" className="text-purple-700">{m[4]}</span>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/** Whether an element's content is taller than the element (it is clipped). Follows size changes. */
function useOverflow(ref: React.RefObject<HTMLElement>, deps: unknown[]) {
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOver(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  }, deps);
  return over;
}

/**
 * A labelled block of recorded text on the run page: the prompt, what a step wrote, its result.
 * Markdown is shown formatted, with a switch to the raw text exactly as recorded. The block shows
 * a good part of the text and grows to all of it on Expand; nothing is ever cut off for good.
 */
export function TextSection({ label, text, testid, markdown = false, empty = "(none)" }: { label: ReactNode; text: string | null | undefined; testid: string; markdown?: boolean; empty?: string }) {
  const [raw, setRaw] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const has = text != null && text !== "";
  const over = useOverflow(box, [text, raw, expanded]);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(t); }, [copied]);
  const formatted = markdown && !raw;
  // A result or a gate question is JSON: shown parsed (a readable tree, text with its real line
  // breaks) or as the JSON text itself, in colour. The choice is remembered for the next blocks.
  const json = !formatted && !markdown && has && looksLikeJson(text);
  const parsed = useMemo(() => { if (!json) return undefined; try { return { value: JSON.parse(text!) }; } catch { return undefined; } }, [json, text]);
  const [jsonView, setJsonView] = useDraft<"parsed" | "json">("ui:json-view", "parsed");
  const showTree = !!parsed && jsonView === "parsed";
  const tool ="rounded px-1.5 py-0.5 text-2xs font-medium";
  return (
    <div className="mb-3" data-testid={`${testid}-section`}>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="label mb-0">{label}</span>
        {has && (
          <div className="ml-auto flex items-center gap-1">
            {markdown && (
              <div className="flex rounded border border-slate-300 bg-surface p-0.5" role="group" aria-label="How to show the text">
                <button type="button" data-testid={`${testid}-formatted`} aria-pressed={!raw} className={`${tool} ${!raw ? "bg-accent text-white" : "text-slate-600 hover:bg-slate-100"}`} onClick={() => setRaw(false)}>Formatted</button>
                <button type="button" data-testid={`${testid}-raw`} aria-pressed={raw} className={`${tool} ${raw ? "bg-accent text-white" : "text-slate-600 hover:bg-slate-100"}`} onClick={() => setRaw(true)}>Raw markdown</button>
              </div>
            )}
            {parsed && (
              <div className="flex rounded border border-slate-300 bg-surface p-0.5" role="group" aria-label="How to show the JSON">
                <button type="button" data-testid={`${testid}-parsed`} aria-pressed={showTree} className={`${tool} ${showTree ? "bg-accent text-white" : "text-slate-600 hover:bg-slate-100"}`} onClick={() => setJsonView("parsed")}>Parsed</button>
                <button type="button" data-testid={`${testid}-json`} aria-pressed={!showTree} className={`${tool} ${!showTree ? "bg-accent text-white" : "text-slate-600 hover:bg-slate-100"}`} onClick={() => setJsonView("json")}>JSON</button>
              </div>
            )}
            <button type="button" data-testid={`${testid}-copy`} className={`${tool} border border-slate-300 bg-surface text-slate-600 hover:bg-slate-100`} onClick={() => navigator.clipboard?.writeText(text!).then(() => setCopied(true)).catch(() => {})}>{copied ? "Copied" : "Copy"}</button>
            {(over || expanded) && (
              <button type="button" data-testid={`${testid}-expand`} aria-expanded={expanded} className={`${tool} border border-slate-300 bg-surface text-slate-600 hover:bg-slate-100`} onClick={() => setExpanded(!expanded)}>{expanded ? "Collapse" : "Expand"}</button>
            )}
          </div>
        )}
      </div>
      <div className="relative">
        <div ref={box} data-testid={testid} data-format={formatted ? "formatted" : "raw"} data-lang={json ? "json" : undefined} data-view={json ? (showTree ? "parsed" : "json") : undefined} data-expanded={expanded}
          className={`overflow-auto rounded border border-slate-200 p-3 ${json ? "bg-slate-50 leading-relaxed text-slate-700" : "bg-surface"} ${expanded ? "" : "max-h-[28rem]"} ${formatted ? "md text-sm" : showTree ? "text-sm" : "mono whitespace-pre-wrap break-words"}`}>
          {!has ? <span className="text-slate-500">{empty}</span> : formatted ? <FormattedMarkdown text={text!} /> : showTree ? <JsonTree value={parsed!.value} /> : json ? <JsonColours text={text!} /> : text}
        </div>
        {over && !expanded && (
          <button type="button" data-testid={`${testid}-more`} onClick={() => setExpanded(true)}
            className="absolute inset-x-px bottom-px flex h-10 items-end justify-center rounded-b bg-gradient-to-t from-surface via-surface/90 to-transparent pb-1 text-2xs font-medium text-blue-700 hover:underline">
            Show all
          </button>
        )}
      </div>
    </div>
  );
}

const URL_IN_TEXT = /(https?:\/\/[^\s<>"')\]]+)/g;

/** Text with its links clickable (opening in a new tab). */
function Linked({ text }: { text: string }) {
  const parts = text.split(URL_IN_TEXT);
  return <>{parts.map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">{p}</a> : p))}</>;
}

const label = (v: unknown) => (Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"}` : `${Object.keys(v as object).length} field${Object.keys(v as object).length === 1 ? "" : "s"}`);

/**
 * Parsed JSON as a readable tree: a field's name next to its value, list items numbered, text with
 * its real line breaks and clickable links, nested parts folded open (and foldable).
 */
export function JsonTree({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null) return <span data-json="word" className="text-purple-700">null</span>;
  if (typeof value === "boolean") return <span data-json="word" className="text-purple-700">{String(value)}</span>;
  if (typeof value === "number") return <span data-json="number" className="text-amber-700">{value}</span>;
  if (typeof value === "string") {
    if (!value) return <span className="italic text-slate-400">(empty)</span>;
    return <span data-json="text" className="whitespace-pre-wrap break-words text-slate-800 [overflow-wrap:anywhere]"><Linked text={value} /></span>;
  }
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [String(i + 1), v]) : Object.entries(value as object);
  if (!entries.length) return <span className="italic text-slate-400">{Array.isArray(value) ? "(no items)" : "(no fields)"}</span>;
  const list = Array.isArray(value);
  return (
    <dl data-json-tree={list ? "list" : "object"} className={`grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 ${depth ? "border-l-2 border-slate-200 pl-3" : ""}`}>
      {entries.map(([k, v]) => {
        const nested = v !== null && typeof v === "object" && (Array.isArray(v) ? v.length : Object.keys(v as object).length) > 0;
        return (
          <div key={k} className="contents" data-json-field={list ? undefined : k}>
            <dt className={`py-0.5 font-medium ${list ? "text-slate-400" : "text-sky-800"} [overflow-wrap:anywhere]`}>{list ? `${k}.` : k}</dt>
            <dd className="min-w-0 py-0.5">
              {nested ? (
                <details open={depth < 3} className="group">
                  <summary className="cursor-pointer select-none text-xs text-slate-500">{label(v)}</summary>
                  <div className="mt-1"><JsonTree value={v} depth={depth + 1} /></div>
                </details>
              ) : <JsonTree value={v} depth={depth + 1} />}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * A short preview on a node row. When the text is longer than the preview, a fade and "more"
 * say so; the row opens the full text.
 */
export function Preview({ children, testid, error = false }: { children: ReactNode; testid: string; error?: boolean }) {
  const box = useRef<HTMLPreElement>(null);
  const over = useOverflow(box, [children]);
  return (
    <div className="relative">
      <pre ref={box} data-testid={testid} data-clipped={over} className={`mono max-h-24 overflow-hidden whitespace-pre-wrap break-words rounded p-1.5 ${error ? "bg-red-50 text-red-800" : "bg-slate-50 text-slate-700"}`}>
        {!error && typeof children === "string" && /^\s*[{[]/.test(children) ? <JsonColours text={children} /> : children}
      </pre>
      {over && (
        <span data-testid={`${testid}-more`} className={`pointer-events-none absolute inset-x-0 bottom-0 flex h-8 items-end justify-end rounded-b bg-gradient-to-t ${error ? "from-red-50" : "from-slate-50"} to-transparent px-2 pb-0.5 text-2xs font-medium text-blue-700`}>
          more · click to read all
        </span>
      )}
    </div>
  );
}

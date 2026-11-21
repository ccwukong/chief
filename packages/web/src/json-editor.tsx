/**
 * A small code editor for JSON: colours, line numbers, Tab and Enter that indent, brackets that
 * close themselves, Format, and the place of a syntax error. It is a real <textarea> laid over
 * the coloured text, so what is typed, selected, pasted and undone behaves as in any text box.
 */
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { JsonColours } from "./text-view";

/** Why the text is not JSON, with the line and column when the engine reports a position. Null when it parses (or is empty). */
export function jsonProblem(text: string): string | null {
  if (!text.trim()) return null;
  try { JSON.parse(text); return null; } catch (e: any) {
    const msg = String(e?.message ?? "not valid JSON");
    const at = msg.match(/position (\d+)/);
    if (!at) return msg;
    const before = text.slice(0, Number(at[1])).split("\n");
    return `${msg.replace(/ in JSON at position \d+.*$/, "").replace(/ at position \d+.*$/, "")} (line ${before.length}, column ${before[before.length - 1].length + 1})`;
  }
}

/**
 * JSON for reading: the same colours, line numbers and frame as the editor, without the text box.
 * `testid` is on the text itself, so a test (or a copy) gets exactly the JSON.
 */
export function JsonCode({ value, testid, maxRows = 18, className = "" }: { value: string; testid?: string; maxRows?: number; className?: string }) {
  const lines = Math.max(value.split("\n").length, 1);
  return (
    <div data-json-code="" className={`overflow-auto rounded border border-slate-200 bg-surface ${className}`} style={{ maxHeight: `${maxRows * 1.5 + 1}em` }}>
      <div className="mono flex min-w-max text-xs leading-[1.5]">
        <div aria-hidden="true" className="sticky left-0 z-10 select-none border-r border-slate-200 bg-slate-50 px-2 py-1.5 text-right text-slate-400">
          {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
        </div>
        <pre data-testid={testid} className="m-0 min-w-0 flex-1 whitespace-pre px-2 py-1.5"><JsonColours text={value} /></pre>
      </div>
    </div>
  );
}

const PAIRS: Record<string, string> = { "{": "}", "[": "]" };

export function JsonEditor({ value, onChange, testid, rows = 4, maxRows = 18, placeholder, invalid = false, title }: { value: string; onChange: (v: string) => void; testid?: string; rows?: number; maxRows?: number; placeholder?: string; invalid?: boolean; title?: string }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const pendingCursor = useRef<number | null>(null);
  const lines = Math.max(value.split("\n").length, value ? 1 : (placeholder?.split("\n").length ?? 1), rows);
  const problem = jsonProblem(value);

  /** Replace the selection (or a range) and put the cursor where it belongs once React has rendered the new text. */
  const edit = (from: number, to: number, insert: string, cursor: number) => {
    pendingCursor.current = cursor;
    onChange(value.slice(0, from) + insert + value.slice(to));
  };
  // A controlled text box puts the cursor at the end when its value is replaced: put it back before the next key arrives.
  useLayoutEffect(() => {
    if (pendingCursor.current == null) return;
    area.current?.setSelectionRange(pendingCursor.current, pendingCursor.current);
    pendingCursor.current = null;
  }, [value]);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget, a = el.selectionStart, b = el.selectionEnd;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); edit(a, b, "  ", a + 2); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const line = value.slice(value.lastIndexOf("\n", a - 1) + 1, a);
      const indent = line.match(/^\s*/)![0];
      const opens = /[{[]\s*$/.test(line), closes = /^\s*[}\]]/.test(value.slice(b));
      // Between a bracket and its partner: the cursor goes on an indented line of its own.
      if (opens && closes) edit(a, b, `\n${indent}  \n${indent}`, a + indent.length + 3);
      else edit(a, b, `\n${indent}${opens ? "  " : ""}`, a + 1 + indent.length + (opens ? 2 : 0));
      return;
    }
    if (PAIRS[e.key] && a === b) { e.preventDefault(); edit(a, b, e.key + PAIRS[e.key], a + 1); return; }
    // Typing the closing bracket that is already there steps over it.
    if ((e.key === "}" || e.key === "]") && a === b && value[a] === e.key) { e.preventDefault(); el.setSelectionRange(a + 1, a + 1); }
  };
  const format = () => { try { onChange(JSON.stringify(JSON.parse(value), null, 2)); } catch { /* the problem is shown below */ } };

  const bad = invalid || !!problem;
  return (
    <div data-testid={testid ? `${testid}-code` : undefined} data-valid={!bad}>
      <div className={`relative overflow-auto rounded border bg-surface ${bad ? "border-red-500" : "border-slate-300 focus-within:border-blue-500"}`} style={{ maxHeight: `${maxRows * 1.5 + 1}em` }}>
        <div className="mono flex min-w-max text-xs leading-[1.5]">
          <div aria-hidden="true" className="sticky left-0 z-10 select-none border-r border-slate-200 bg-slate-50 px-2 py-1.5 text-right text-slate-400">
            {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
          </div>
          <div className="relative grid min-w-0 flex-1">
            <pre aria-hidden="true" className="pointer-events-none col-start-1 row-start-1 m-0 whitespace-pre px-2 py-1.5"><JsonColours text={value} />{"\n"}</pre>
            <textarea ref={area} data-testid={testid} title={title} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" rows={lines} placeholder={placeholder}
              className={`col-start-1 row-start-1 h-full w-full resize-none overflow-hidden whitespace-pre border-0 bg-transparent px-2 py-1.5 text-transparent caret-slate-900 outline-none placeholder:text-slate-400 ${bad ? "border-red-500" : ""}`}
              style={{ font: "inherit", lineHeight: "inherit" }} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
          </div>
        </div>
        {value.trim() && !problem && (
          <button type="button" data-testid={testid ? `${testid}-format` : undefined} title="Lay the JSON out with one field per line" onClick={format}
            className="absolute right-1 top-1 z-20 rounded border border-slate-200 bg-surface/90 px-1.5 py-0.5 text-2xs font-medium text-slate-600 hover:bg-slate-100">Format</button>
        )}
      </div>
      {problem && <div data-testid={testid ? `${testid}-problem` : undefined} className="mt-0.5 text-xs text-red-700">{problem}</div>}
    </div>
  );
}

/**
 * Lookup-only template engine: `{{inputs.x}}`, `{{nodes.id.output.path}}`, `{{item}}`,
 * `{{output.side_effects}}`. No expressions, no eval.
 */
const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

export interface TemplateRef { raw: string; path: string[] }

export class TemplateError extends Error {}

/** All template references in a string. Throws on a malformed reference. */
export function parseRefs(text: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  for (const m of text.matchAll(TEMPLATE)) {
    const raw = m[1];
    if (!PATH.test(raw)) throw new TemplateError(`invalid template reference "{{${raw}}}"`);
    refs.push({ raw, path: raw.split(".") });
  }
  if (/\{\{/.test(text.replace(TEMPLATE, ""))) throw new TemplateError("unclosed \"{{\" in template");
  return refs;
}

/** Template references in any JSON-like value (strings are scanned, containers are walked). */
export function collectRefs(value: unknown): TemplateRef[] {
  if (typeof value === "string") return parseRefs(value);
  if (Array.isArray(value)) return value.flatMap(collectRefs);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectRefs);
  return [];
}

export function lookup(scope: any, path: string[]): { found: boolean; value: any } {
  let cur = scope;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return { found: false, value: undefined };
      cur = cur[Number(seg)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined };
      cur = cur[seg];
    }
  }
  return { found: true, value: cur };
}

export interface RenderOptions {
  /** Max characters a single substituted value may add to a string. Larger values are truncated. */
  maxValueChars?: number;
  onTruncate?: (ref: string, originalChars: number) => void;
}

const stringify = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/**
 * Render a string. A string that is exactly one reference returns the referenced value
 * unchanged (so `over: "{{nodes.x.output.items}}"` yields the array itself).
 */
export function renderString(text: string, scope: any, opts: RenderOptions = {}): unknown {
  const refs = parseRefs(text);
  if (!refs.length) return text;
  const resolve = (ref: TemplateRef) => {
    const r = lookup(scope, ref.path);
    if (!r.found) throw new TemplateError(`cannot resolve "{{${ref.raw}}}"`);
    return r.value;
  };
  const single = text.trim().match(/^\{\{\s*([^{}]*?)\s*\}\}$/);
  if (single) return resolve(refs[0]);
  return text.replace(TEMPLATE, (_m, raw: string) => {
    let s = stringify(resolve({ raw, path: raw.split(".") }));
    if (opts.maxValueChars && s.length > opts.maxValueChars) {
      opts.onTruncate?.(raw, s.length);
      s = s.slice(0, opts.maxValueChars) + `\n…[truncated by chief: ${s.length - opts.maxValueChars} more characters]`;
    }
    return s;
  });
}

/** Render every string inside a JSON-like value. */
export function renderValue(value: unknown, scope: any, opts: RenderOptions = {}): unknown {
  if (typeof value === "string") return renderString(value, scope, opts);
  if (Array.isArray(value)) return value.map((v) => renderValue(v, scope, opts));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderValue(v, scope, opts)]));
  }
  return value;
}

/** Rough token estimate (about four characters per token). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

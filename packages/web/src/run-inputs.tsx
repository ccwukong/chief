/**
 * Run inputs, and the form that asks for them (tasks 15.119–15.121).
 *
 * A workflow may **declare** each input it wants — a label, a type, whether a value must be given — in
 * `input-fields`. Where it does not, the input is still asked for: labelled by its path and typed from
 * its default. The server decides that union (`describeInputs` in `packages/chief/src/workflow/inputs.ts`);
 * this file renders it, and mirrors the same rule for the designer's unsaved working copy and the run
 * page, which have a definition in hand rather than a response.
 *
 * What a run is given stays **one JSON object**: a field writes to its dotted path, so depth costs the
 * form nothing and the JSON view is the same value, not a second one.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Checkbox } from "./components/ui/checkbox";
import { Select } from "./components/ui/select";
import { JsonEditor } from "./json-editor";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";

export interface InputRef { path: string; has_default: boolean; default?: unknown }

/** The form language: the ask gate's types plus `number`, and `json` for a value no control expresses. */
export type FieldType = "text" | "long-text" | "number" | "choose-one" | "choose-many" | "yes-no" | "json";

export interface InputField extends InputRef {
  label: string;
  type: FieldType;
  required: boolean;
  declared: boolean;
  description?: string;
  options?: { label: string; value: unknown; detail?: string }[];
}

export type Obj = Record<string, unknown>;
export const isObject = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** The defaults with the given values over them: objects merge level by level, anything else is replaced. Same rule as the server. */
export function mergeInputs(defaults: unknown, given: unknown): Obj {
  const out: Obj = isObject(defaults) ? { ...defaults } : {};
  if (!isObject(given)) return out;
  for (const [k, v] of Object.entries(given)) out[k] = isObject(v) && isObject(out[k]) ? mergeInputs(out[k], v) : v;
  return out;
}

/** The value at a dotted path, and whether it is there at all (an empty text is there). */
export function getPath(obj: unknown, dotted: string): { found: boolean; value?: unknown } {
  let cur: any = obj;
  for (const seg of dotted.split(".")) {
    if (!cur || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false };
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

export const hasPath = (obj: unknown, dotted: string) => getPath(obj, dotted).found;

/** Set a value at a dotted path, creating the objects on the way. Returns a new object; the input is not changed. */
export function setInputPath(obj: unknown, dotted: string, value: unknown): Obj {
  const segs = dotted.split(".").filter(Boolean);
  const root: Obj = isObject(obj) ? { ...obj } : {};
  let cur: Obj = root;
  for (const seg of segs.slice(0, -1)) {
    cur[seg] = isObject(cur[seg]) ? { ...(cur[seg] as Obj) } : {};
    cur = cur[seg] as Obj;
  }
  cur[segs[segs.length - 1]] = value;
  return root;
}

/** Remove a value at a dotted path (a pruned empty section is left alone). */
export function deleteInputPath(obj: unknown, dotted: string): Obj {
  const segs = dotted.split(".").filter(Boolean);
  const root: Obj = isObject(obj) ? { ...obj } : {};
  let cur: Obj = root;
  for (const seg of segs.slice(0, -1)) {
    if (!isObject(cur[seg])) return root;
    cur[seg] = { ...(cur[seg] as Obj) };
    cur = cur[seg] as Obj;
  }
  delete cur[segs[segs.length - 1]];
  return root;
}

/** The `{{inputs.<path>}}` references in any value (a definition, a node), each once. Client-side mirror of the server's list. */
export function inputRefsOf(value: unknown): string[] {
  const seen = new Set<string>();
  for (const m of JSON.stringify(value ?? "").matchAll(/\{\{\s*inputs\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g)) seen.add(m[1]);
  return [...seen];
}

export function parseInputs(text: string): Obj | null {
  try { const v = JSON.parse(text.trim() || "{}"); return isObject(v) ? v : null; } catch { return null; }
}

export const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** The type an input is asked with when nobody declared one: the JSON type of its default, `text` when it has none. */
export function inferFieldType(value: unknown, has: boolean): FieldType {
  if (!has) return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "yes-no";
  if (value && typeof value === "object") return "json";
  // Prose is not a one-line field (see the server's own rule, 15.119).
  if (typeof value === "string" && (/[\r\n]/.test(value) || value.length > 80)) return "long-text";
  return "text";
}

/**
 * The inputs a definition asks for, mirroring `describeInputs` on the server: declared fields in their
 * order, then inputs the prompts use that nobody declared, then declared fields no prompt reads. A
 * declaration wins for label, type and required; the value side (`has_default`, `default`) is the same
 * either way. Used where a definition is in hand — the designer's unsaved copy, and the run page.
 */
export function describeInputsOf(def: any): InputField[] {
  const given = new Map<string, any>();
  for (const f of Array.isArray(def?.["input-fields"]) ? def["input-fields"] : []) given.set(f.path, f);
  const out: InputField[] = [];
  const one = (path: string, d: any): InputField => {
    const r = getPath(def?.inputs ?? {}, path);
    const base: InputRef = r.found ? { path, has_default: true, default: r.value } : { path, has_default: false };
    if (d) return { ...base, label: d.label, type: d.type, required: !!d.required, declared: true, ...(d.description ? { description: d.description } : {}), ...(d.options ? { options: d.options } : {}) };
    return { ...base, label: path, type: inferFieldType(base.default, base.has_default), required: false, declared: false };
  };
  for (const path of inputRefsOf({ nodes: def?.nodes, edges: def?.edges })) {
    const d = given.get(path);
    given.delete(path);
    out.push(one(path, d));
  }
  for (const d of given.values()) out.push(one(d.path, d));
  return out;
}

/** The values to start from: the workflow's own default where it has one, an empty text where it does not. */
export function templateFromFields(fields: InputField[]): Obj {
  let out: Obj = {};
  for (const f of fields) out = setInputPath(out, f.path, f.has_default ? f.default ?? "" : "");
  return out;
}

export function templateText(fields: InputField[]): string {
  return fields.length ? pretty(templateFromFields(fields)) : "";
}

/** The fields the template leaves as an empty text that were not filled in: a blank that would start a run about nothing. */
export function blankInputs(fields: InputField[], given: unknown): string[] {
  return fields.filter((f) => { const r = getPath(given, f.path); return r.found && r.value === ""; }).map((f) => f.path);
}

/**
 * Fields this input data set has not answered. A workflow default is not an answer: the set is the values for
 * one run, and the default is the sample on the workflow. `0` and `false` count; an empty text does not.
 */
export function unfilledInputs(fields: InputField[], given: unknown): InputField[] {
  return fields.filter((f) => {
    const r = getPath(given, f.path);
    return !r.found || r.value == null || r.value === "";
  });
}

/** Required fields with no value. An empty text is no answer. */
export function missingRequired(fields: InputField[], given: unknown): InputField[] {
  return fields.filter((f) => {
    if (!f.required) return false;
    const r = getPath(given, f.path);
    return !r.found || r.value == null || r.value === "";
  });
}

/** Group by the first path segment, which is the block a section belongs to: the order of first appearance. */
export function groupBySection(fields: InputField[]): { section: string | null; fields: InputField[] }[] {
  const out: { section: string | null; fields: InputField[] }[] = [];
  for (const f of fields) {
    const section = f.path.includes(".") ? f.path.split(".")[0] : null;
    const last = out[out.length - 1];
    if (last && last.section === section) last.fields.push(f);
    else out.push({ section, fields: [f] });
  }
  return out;
}

// ── the controls ─────────────────────────────────────────────────────────────

/**
 * A number field keeps a text of its own while it is being typed (`4` then `48`), and writes a **number**
 * only when what is there can be one, so the run record holds a number rather than "48". Anything else is
 * put back to the last value that could be a number when the field is left.
 */
function NumberField({ value, onChange, testid, disabled }: { value: unknown; onChange: (v: unknown) => void; testid: string; disabled?: boolean }) {
  const asText = (v: unknown) => (typeof v === "number" ? String(v) : typeof v === "string" ? v : "");
  const [text, setText] = useState(() => asText(value));
  // The JSON view may change the number under this field; follow it unless the text is what produced it.
  useEffect(() => {
    const n = text.trim() === "" ? null : Number(text);
    if (n !== (typeof value === "number" ? value : null)) setText(asText(value));
  }, [value]);
  return (
    <Input data-testid={testid} inputMode="decimal" disabled={disabled} value={text}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === "") return onChange("");
        if (Number.isFinite(Number(t))) onChange(Number(t));
      }}
      onBlur={() => { if (text.trim() !== "" && !Number.isFinite(Number(text))) setText(asText(value)); }} />
  );
}

/** A value as one readable line: whitespace collapsed, so a paragraph cannot stretch a row. */
export const preview = (v: unknown): string => {
  const s = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  return s.replace(/\s+/g, " ").trim();
};


/** A path as words, for a field nobody declared: `long_text_mbr_review` reads as "Long text mbr review". */
const words = (path: string) => {
  const last = path.split(".").pop() ?? path;
  const t = last.replace(/[-_]+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : last;
};
const labelOf = (f: InputField) => (f.declared ? f.label : words(f.path));
const showPath = (f: InputField) => !f.declared || f.label !== f.path;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);


/** One input's control, by its type. `id` is the test-id stem, so every type is findable the same way. */
export function FieldInput({ field, value, onChange, stem, disabled }: { field: InputField; value: unknown; onChange: (v: unknown) => void; stem: string; disabled?: boolean }) {
  const testid = `${stem}-input`;
  switch (field.type) {
    case "long-text": {
      // A paragraph gets a box sized to it: rows follow the content, within a page-friendly bound, and it can be
      // dragged bigger. One line of a 500-word review was the "worst UX" report of 2026-11-24.
      const t = typeof value === "string" ? value : value == null ? "" : String(value);
      const lines = Math.min(10, Math.max(3, t.split("\n").length + Math.floor(t.length / 110)));
      return <Textarea data-testid={testid} rows={lines} disabled={disabled} className="min-h-[4.5rem] resize-y font-normal" spellCheck value={t} onChange={(e) => onChange(e.target.value)} />;
    }
    case "number":
      return <NumberField value={value} onChange={onChange} testid={testid} disabled={disabled} />;
    case "yes-no":
      return (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox data-testid={testid} disabled={disabled} checked={value === true} onCheckedChange={(v) => onChange(!!v)} />
          <span className="text-slate-700">Yes</span>
        </label>
      );
    case "choose-one": {
      const at = (field.options ?? []).findIndex((o) => same(o.value, value));
      return (
        <Select data-testid={testid} className="w-full" disabled={disabled} value={at < 0 ? "" : String(at)}
          onChange={(e) => onChange(e.target.value === "" ? (field.required ? undefined : "") : field.options?.[Number(e.target.value)]?.value)}>
          <option value="">{field.required ? "Choose…" : "—"}</option>
          {(field.options ?? []).map((o, i) => <option key={i} value={String(i)}>{o.label}</option>)}
        </Select>
      );
    }
    case "choose-many": {
      const picked: unknown[] = Array.isArray(value) ? value : [];
      return (
        <ul className="space-y-1">
          {(field.options ?? []).map((o, i) => (
            <li key={i}>
              <label className="flex items-start gap-2 rounded bg-surface px-2 py-1 text-sm">
                <Checkbox className="mt-0.5" data-testid={`${testid}-${i}`} disabled={disabled} checked={picked.some((p) => same(p, o.value))}
                  onCheckedChange={(v) => onChange(v ? [...picked, o.value] : picked.filter((p) => !same(p, o.value)))} />
                <span><span className="font-medium">{o.label}</span>{o.detail && <span className="block text-xs text-slate-500">{o.detail}</span>}</span>
              </label>
            </li>
          ))}
        </ul>
      );
    }
    case "json":
      // No control can hold this; saying so is better than a text box that would quietly change its type.
      return <p data-testid={`${testid}-json-only`} className="text-sm text-slate-600">An object or a list: edit it in the JSON below.</p>;
    default:
      return <Input data-testid={testid} disabled={disabled} value={typeof value === "string" ? value : value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />;
  }
}

/**
 * The form and the JSON as **the tab component, used as a tab component**: one `Tabs` root owning the list, both
 * panels and the wiring between them — `aria-controls`, `aria-labelledby`, one `role="tabpanel"` visible at a time.
 *
 * It was the tabs' *appearance* with none of their behaviour: the triggers were inside a `Tabs` while the panels were
 * hand-rolled `<div hidden>` siblings outside it, so every trigger pointed at an id that did not exist and the page had
 * **no tabpanel at all** (measured 2026-11-24: `tabpanels: 0`, both `aria-controls` dangling). A screen reader
 * announced two tabs that controlled nothing.
 *
 * Both panels are `forceMount`ed **and the inactive one hidden by its own `data-state`**, because a switch must not
 * throw away what the view it is not showing holds — which defaults were opened, the caret in the JSON. `forceMount`
 * alone was not enough: Radix only sets `hidden` when *it* controls presence, so both panels rendered at once, which is
 * the opposite of a switch (measured 2026-11-24).
 */
export function InputFormWithJson({ fields, text, setText, stem, disabled, children }: {
  fields: InputField[];
  text: string;
  setText: (t: string) => void;
  stem: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const parsed = parseInputs(text);
  const [lastGood, setLastGood] = useState<Obj>(() => parsed ?? {});
  const [view, setView] = useState<"form" | "json">("form");
  // An invalid text is not a reason to sit in a view that cannot be used: the person is sent to the JSON, where the
  // problem is, rather than left on a paused form wondering what to do.
  useEffect(() => { if (!parsed) setView("json"); }, [parsed]);
  useEffect(() => { if (parsed) setLastGood(parsed); }, [text]);
  const shown = parsed ?? lastGood;
  return (
    <Tabs value={view} onValueChange={(v) => setView(v as "form" | "json")} data-testid={`${stem}-views`} data-view={view} className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {/* The component's own tab look, at the size of a control rather than a footnote: a track with the active tab
            standing out. Not a black filled button — that was a segmented control wearing tab roles. */}
        <TabsList data-testid={`${stem}-view-switch`} aria-label="How to fill in the inputs"
          className="h-9 gap-0.5 border border-slate-300 bg-slate-100 p-0.5">
          <TabsTrigger value="form" data-testid={`${stem}-view-form`}
            className="gap-1.5 px-3 text-sm font-medium text-slate-600 data-[state=active]:bg-surface data-[state=active]:font-semibold data-[state=active]:text-slate-900 data-[state=active]:shadow-sm">
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 4.5h10M3 8h10M3 11.5h6" /></svg>
            Form
          </TabsTrigger>
          <TabsTrigger value="json" data-testid={`${stem}-view-json`}
            className="gap-1.5 px-3 text-sm font-medium text-slate-600 data-[state=active]:bg-surface data-[state=active]:font-semibold data-[state=active]:text-slate-900 data-[state=active]:shadow-sm">
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5c-2 0-2 1.2-2 2.3 0 1.2-.4 1.7-1.5 2.2 1.1.5 1.5 1 1.5 2.2 0 1.1 0 2.3 2 2.3M10 3.5c2 0 2 1.2 2 2.3 0 1.2.4 1.7 1.5 2.2-1.1.5-1.5 1-1.5 2.2 0 1.1 0 2.3-2 2.3" /></svg>
            JSON
          </TabsTrigger>
        </TabsList>
        <span className="text-xs text-slate-500" data-testid={`${stem}-view-note`}>
          {view === "form" ? "One field per input. JSON is beside it for anything a field cannot hold." : "The same values as one object."}
        </span>
        {!parsed && <span data-testid={`${stem}-invalid-hint`} className="text-xs font-medium text-destructive">The JSON needs fixing before the fields can be used.</span>}
      </div>
      {children}
      <TabsContent value="form" forceMount data-testid={`${stem}-pane-form`} className="mt-0 data-[state=inactive]:hidden">
        {fields.length === 0 && (
          <p data-testid={`${stem}-no-fields`} className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
            This workflow asks for no fields of its own. Switch to <b>JSON</b> to give it anything.
          </p>
        )}
        <InputForm fields={fields} value={shown} onChange={(next) => setText(JSON.stringify(next, null, 2))} stem={stem} disabled={disabled || !parsed} />
        {!parsed && <p data-testid={`${stem}-paused`} className="mt-1 text-xs text-amber-800">The fields are paused: the JSON is not a valid object.</p>}
      </TabsContent>
      <TabsContent value="json" forceMount data-testid={`${stem}-pane-json`} className="mt-0 data-[state=inactive]:hidden">
        <JsonEditor testid={stem} rows={6} invalid={!parsed} placeholder="{ }" value={text} onChange={setText} />
      </TabsContent>
    </Tabs>
  );
}

/**
 * The form: **every field the workflow asks for, always**, each holding the value the run would get. Nothing to
 * discover and nothing to unfold.
 *
 * It used to fold away every field that had a default — one grey line, "Using the workflow's defaults (5) +", with a
 * `review` link. On an ordinary workflow that made the form **completely invisible**: five inputs, five defaults, not
 * one field on screen (reported 2026-11-24: *"how would anyone be able to know how this thing works and there's a form
 * for the input?"*). The height it saved was not worth a form nobody could see.
 *
 * A field starts with the workflow's own value and says so in small text (`workflow default`), so a person can tell
 * the workflow's value from their own without guessing. Nothing here decides whether the run may start;
 * `missingRequired` does, so the page and the engine agree.
 */
export function InputForm({ fields, value, onChange, stem = "input", disabled, note }: {
  fields: InputField[];
  value: Obj;
  onChange: (next: Obj) => void;
  stem?: string;
  disabled?: boolean;
  note?: (f: InputField) => string | undefined;
}) {
  const one = (f: InputField) => {
    const n = note?.(f);
    const cur = getPath(value, f.path);
    const held = cur.found ? cur.value : undefined;
    // Untouched: it is the workflow's value, and saying so is the difference between "this is what the run will use"
    // and "where did that come from?".
    const fromWorkflow = f.has_default && preview(held) === preview(f.default) && preview(f.default) !== "";
    return (
      <div key={f.path} data-testid={`${stem}-field-${f.path}`} data-type={f.type} data-declared={f.declared} className="mb-3 min-w-0">
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-semibold">{labelOf(f)}</span>
          {f.required && <span className="text-red-700" title="needs a value">*</span>}
          {/* The path, so a field can be connected to the prompt that reads it — and so a label can differ from it. */}
          {showPath(f) && <code className="mono text-2xs text-slate-500">{`{{inputs.${f.path}}}`}</code>}
          {fromWorkflow && (
            <span data-testid={`${stem}-from-workflow-${f.path}`} className="rounded bg-slate-100 px-1.5 py-0.5 text-2xs text-slate-600"
              title="The value the workflow itself holds. Change it for this run, or leave it.">workflow default</span>
          )}
        </div>
        {f.description && <p className="mb-1 text-xs text-slate-500">{f.description}</p>}
        <FieldInput field={f} value={held} disabled={disabled} stem={`${stem}-${f.path}`} onChange={(v) => onChange(setInputPath(value, f.path, v))} />
        {n && <p className="mt-1 text-xs text-slate-500">{n}</p>}
      </div>
    );
  };

  // The blocks, when the paths are sections (`planner.prlink`): one heading per section, in order.
  const sections = groupBySection(fields);
  return (
    <div data-testid={`${stem}-form`} data-fields={fields.length}>
      {sections.map((g, i) => (
        <div key={g.section ?? `top-${i}`} className="min-w-0">
          {g.section && fields.length > 1 && <div data-testid={`${stem}-section-${g.section}`} className="mb-1 mt-1 text-2xs font-semibold uppercase tracking-wide text-slate-500">{g.section}</div>}
          {g.fields.map(one)}
        </div>
      ))}
    </div>
  );
}

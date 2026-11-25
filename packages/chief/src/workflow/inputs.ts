/**
 * Run inputs: the values a workflow is given when it runs, under `{{inputs.…}}` in templates.
 * A workflow declares defaults (`inputs:`); a run (or a schedule) gives its own values as a JSON
 * object of the same shape, at any depth, which is laid over the defaults level by level.
 */
import { collectRefs, lookup } from "./template.ts";

export type Inputs = Record<string, unknown>;

const isObject = (v: unknown): v is Inputs => !!v && typeof v === "object" && !Array.isArray(v);

/** The defaults with the given values over them: objects merge level by level, anything else is replaced. */
export function mergeInputs(defaults: unknown, given: unknown): Inputs {
  const out: Inputs = isObject(defaults) ? { ...defaults } : {};
  if (!isObject(given)) return out;
  for (const [k, v] of Object.entries(given)) out[k] = isObject(v) && isObject(out[k]) ? mergeInputs(out[k], v) : v;
  return out;
}

/** Every `{{inputs.<path>}}` a workflow refers to, as dotted paths, each once, in order of first use. */
export function inputRefs(def: any): string[] {
  const seen = new Set<string>();
  for (const n of def?.nodes ?? []) {
    let refs: ReturnType<typeof collectRefs>;
    try { refs = collectRefs(n); } catch { continue; }
    for (const r of refs) if (r.path[0] === "inputs" && r.path.length > 1) seen.add(r.path.slice(1).join("."));
  }
  return [...seen];
}

export interface InputRef { path: string; has_default: boolean; default?: unknown }

/** The form language a field is asked with (15.119): the ask gate's types plus `number`, and `json` for a value no field expresses. */
export type FieldType = "text" | "long-text" | "number" | "choose-one" | "choose-many" | "yes-no" | "json";

/** One input as a screen asks for it: declared by the workflow when it says so, inferred from the prompt and the default when it does not. */
export interface InputField extends InputRef {
  label: string;
  type: FieldType;
  required: boolean;
  declared: boolean;
  description?: string;
  options?: { label: string; value: unknown; detail?: string }[];
}

/** The type an input is asked with when nobody declared one: the JSON type of its default, `text` when it has none. */
export function inferFieldType(value: unknown, has: boolean): FieldType {
  if (!has) return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "yes-no";
  if (value && typeof value === "object") return "json";
  // Prose is not a one-line field: a paragraph in a text box is a field nobody can read, and it was exactly what a
  // workflow whose defaults hold a cover letter or a review looked like (found in a browser, 2026-11-24).
  if (typeof value === "string" && (/[\r\n]/.test(value) || value.length > 80)) return "long-text";
  return "text";
}

/** The declared fields of a workflow, or none. A definition without any behaves exactly as before this existed. */
export function declaredFields(def: any): any[] {
  const list = def?.["input-fields"];
  return Array.isArray(list) ? list : [];
}

/**
 * The inputs a workflow asks for: the declared fields in their order, then the inputs its prompts use
 * that nobody declared, then a declared field the prompts do not use (the author asked for it). A
 * declaration wins for label, type and required; `path`, `has_default` and `default` say what the run
 * would get either way. The run's inputs stay one free-form JSON object — this describes, it does not
 * restrict what a run may carry.
 */
export function describeInputs(def: any): InputField[] {
  const given = new Map<string, any>(declaredFields(def).map((f: any) => [f.path, f]));
  const out: InputField[] = [];
  for (const path of inputRefs(def)) {
    const r = lookup(def?.inputs ?? {}, path.split("."));
    const base = r.found ? { path, has_default: true, default: r.value } : { path, has_default: false };
    const d = given.get(path);
    if (d) {
      given.delete(path);
      out.push({ ...base, label: d.label, type: d.type, required: !!d.required, declared: true, ...(d.description ? { description: d.description } : {}), ...(d.options ? { options: d.options } : {}) });
    } else {
      const type = inferFieldType(base.default, base.has_default);
      out.push({ ...base, label: path, type, required: false, declared: false });
    }
  }
  // Declared and never read: the author asked for these, so they are asked for too.
  for (const d of given.values()) {
    const r = lookup(def?.inputs ?? {}, d.path.split("."));
    const base = r.found ? { path: d.path, has_default: true, default: r.value } : { path: d.path, has_default: false };
    out.push({ ...base, label: d.label, type: d.type, required: !!d.required, declared: true, ...(d.description ? { description: d.description } : {}), ...(d.options ? { options: d.options } : {}) });
  }
  return out;
}

/**
 * The declared fields that must be given a value and have none. An empty text is no answer: a
 * required field left blank is the case this exists for, and the shape 15.116 fills in gives one.
 */
export function missingRequired(def: any, given: unknown): InputField[] {
  return describeInputs(def).filter((f) => {
    if (!f.declared || !f.required) return false;
    const r = lookup(given ?? {}, f.path.split("."));
    return !r.found || r.value == null || r.value === "";
  });
}

/** The message a run or schedule is refused with when a declared field has no value: the label, then the path so the fix is unambiguous. */
export function requiredFieldsMessage(what: string, fields: InputField[]): string {
  const list = fields.map((f) => `“${f.label}” (inputs.${f.path})`).join(", ");
  return `cannot ${what}: ${fields.length === 1 ? "a required input has" : "required inputs have"} no value: ${list}. Give ${fields.length === 1 ? "it" : "them"} when starting the run (--input ${fields[0].path}=… or in the inputs), or give the field a default in the workflow's inputs`;
}

/** The referenced inputs that `inputs` (already merged over the defaults) does not hold. */
export function missingInputs(def: any, inputs: unknown): string[] {
  return inputRefs(def).filter((path) => !lookup(inputs, path.split(".")).found);
}

/** Dotted paths in `inputs` that end in the same name as `path`: the likely intended place of a value that was not found. */
export function similarInputs(inputs: unknown, path: string): string[] {
  const name = path.split(".").pop()!;
  const found: string[] = [];
  const walk = (v: unknown, at: string[]) => {
    if (!isObject(v)) return;
    for (const [k, child] of Object.entries(v)) { if (k === name) found.push([...at, k].join(".")); walk(child, [...at, k]); }
  };
  walk(inputs, []);
  return found.filter((f) => f !== path);
}

/** The message a run or schedule is refused with when inputs are missing. `inputs` (what the run has) lets it say where a value of that name is. */
export function missingInputsMessage(what: string, missing: string[], inputs?: unknown): string {
  const list = missing.map((m) => { const near = similarInputs(inputs, m); return `inputs.${m}${near.length ? ` (the inputs have ${near.map((n) => `inputs.${n}`).join(", ")}: write {{inputs.${near[0]}}} in the prompt, or move the value)` : ""}`; }).join(", ");
  const first = missing[0];
  return `cannot ${what}: ${missing.length === 1 ? "an input it uses has" : "inputs it uses have"} no value: ${list}. Give ${missing.length === 1 ? "it" : "them"} when starting the run (--input ${first}=… or in the inputs JSON), or set it in the workflow's inputs (the Workflow tab of the designer, \`inputs\` in the YAML)`;
}

/** Set a nested value by dotted path (`params.prlink`), creating the objects on the way. */
export function setInputPath(inputs: Inputs, dotted: string, value: unknown): Inputs {
  const segs = dotted.split(".").filter(Boolean);
  if (!segs.length) throw new Error("an input needs a name");
  let cur: Inputs = inputs;
  for (const seg of segs.slice(0, -1)) {
    if (!isObject(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Inputs;
  }
  cur[segs[segs.length - 1]] = value;
  return inputs;
}

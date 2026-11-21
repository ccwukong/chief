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

/** The inputs a workflow uses, with the default each has (if any). */
export function describeInputs(def: any): InputRef[] {
  return inputRefs(def).map((path) => {
    const r = lookup(def?.inputs ?? {}, path.split("."));
    return r.found ? { path, has_default: true, default: r.value } : { path, has_default: false };
  });
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

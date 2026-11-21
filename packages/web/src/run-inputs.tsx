/**
 * Run inputs: what a workflow refers to as {{inputs.…}}, and the form that gives them when a run
 * starts. The server lists the inputs a workflow uses (`input_refs` of GET /api/workflows/:name);
 * what is typed is a JSON object of the same shape, laid over the workflow's defaults level by level.
 */
import { Help } from "./ui";
import { JsonEditor } from "./json-editor";

export interface InputRef { path: string; has_default: boolean; default?: unknown }

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** The defaults with the given values over them: objects merge level by level, anything else is replaced. Same rule as the server. */
export function mergeInputs(defaults: unknown, given: unknown): Obj {
  const out: Obj = isObject(defaults) ? { ...defaults } : {};
  if (!isObject(given)) return out;
  for (const [k, v] of Object.entries(given)) out[k] = isObject(v) && isObject(out[k]) ? mergeInputs(out[k], v) : v;
  return out;
}

export function hasPath(obj: unknown, dotted: string): boolean {
  let cur: any = obj;
  for (const seg of dotted.split(".")) {
    if (!cur || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, seg)) return false;
    cur = cur[seg];
  }
  return true;
}

function setPath(obj: Obj, dotted: string, value: unknown) {
  const segs = dotted.split(".");
  let cur = obj;
  for (const seg of segs.slice(0, -1)) { if (!isObject(cur[seg])) cur[seg] = {}; cur = cur[seg] as Obj; }
  cur[segs[segs.length - 1]] = value;
}

/**
 * A JSON object with every input the workflow uses, each left blank to be filled in for this run.
 * The values stored in the workflow are deliberately not copied in: what a run is about (a pull
 * request link, a ticket) differs from run to run, and a filled-in box would suggest it does not.
 */
export function inputTemplate(refs: InputRef[]): Obj {
  const out: Obj = {};
  for (const r of refs) setPath(out, r.path, "");
  return out;
}

/** The inputs the workflow uses that the text gives as an empty text: a blank of the template that was not filled in. */
export function blankInputs(refs: InputRef[], given: unknown): string[] {
  return refs.filter((r) => hasPath(given, r.path) && r.path.split(".").reduce((cur: any, seg) => cur?.[seg], given) === "").map((r) => r.path);
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

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * The inputs field: a label and the JSON editor, nothing else. The editor's hint, shown while it is
 * empty, is the shape of the inputs the workflow's prompts use, with blanks.
 */
export function RunInputsEditor({ refs, value, onChange, testid = "new-run-inputs", rows = 3, label = "Inputs (JSON, optional)" }: { refs: InputRef[]; value: string; onChange: (v: string) => void; testid?: string; rows?: number; label?: string }) {
  const parsed = parseInputs(value);
  const template = inputTemplate(refs);
  return (
    <div data-testid={`${testid}-editor`}>
      <div className="mb-1"><span className="label mb-0">{label}<Help id="new-run-inputs" /></span></div>
      <div><JsonEditor testid={testid} rows={rows} invalid={!parsed} placeholder={refs.length ? pretty(template) : "{ }   leave empty to use the workflow's own inputs"} value={value} onChange={onChange} /></div>
      {!parsed && <div className="text-xs text-red-700">Inputs must be a JSON object.</div>}
    </div>
  );
}

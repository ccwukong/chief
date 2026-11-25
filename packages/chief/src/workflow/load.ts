import YAML from "yaml";
import { collectRefs, lookup, TemplateError, type TemplateRef } from "./template.ts";
import { checkShorthand, workflowSchema, type Workflow, type WorkflowNode } from "./schema.ts";

export interface ValidationResult { ok: boolean; errors: string[]; warnings: string[]; workflow?: Workflow }

/** Parse YAML or JSON text into a plain object. */
export function parseText(text: string): unknown {
  return YAML.parse(text);
}

export function toYaml(wf: Workflow): string {
  const out: any = { ...wf, edges: wf.edges.map((e) => `${e.from} -> ${e.to}`) };
  if (!Object.keys(out.inputs ?? {}).length) delete out.inputs;
  return YAML.stringify(out, { lineWidth: 0 });
}

/** Nodes in dependency order. Throws when the graph has a cycle. */
export function topoOrder(wf: Workflow): string[] {
  const indeg = new Map(wf.nodes.map((n) => [n.id, 0]));
  for (const e of wf.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const order: string[] = [];
  const queue = wf.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const e of wf.edges.filter((x) => x.from === cur)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  if (order.length !== wf.nodes.length) throw new Error("workflow has a cycle");
  return order;
}

export const predecessors = (wf: Workflow, nodeId: string) => wf.edges.filter((e) => e.to === nodeId).map((e) => e.from);

export function ancestors(wf: Workflow, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const stack = predecessors(wf, nodeId);
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...predecessors(wf, cur));
  }
  return seen;
}

function checkRefs(refs: TemplateRef[], where: string, wf: Workflow, nodeId: string, allowed: { item?: boolean; output?: boolean }, errors: string[]) {
  const anc = ancestors(wf, nodeId);
  for (const r of refs) {
    const [root, second, third] = r.path;
    if (root === "inputs") continue;
    if (root === "backlog") { errors.push(`${where}: {{${r.raw}}} is no longer available; the backlog was removed`); continue; }
    if (root === "item") { if (!allowed.item) errors.push(`${where}: {{item}} is only available inside a map node`); continue; }
    if (root === "output" || root === "side_effects") { if (!allowed.output) errors.push(`${where}: {{${root}}} is only available in compensate`); continue; }
    if (root === "nodes") {
      if (!wf.nodes.some((n) => n.id === second)) errors.push(`${where}: {{${r.raw}}} refers to unknown node "${second}"`);
      else if (!anc.has(second)) errors.push(`${where}: {{${r.raw}}} refers to "${second}", which does not run before "${nodeId}"`);
      else if (third !== "output" && third !== "reply") errors.push(`${where}: use {{nodes.${second}.output…}} (the step's result) or {{nodes.${second}.reply}} (what it wrote besides the result)`);
      continue;
    }
    errors.push(`${where}: unknown template root "${root}" in {{${r.raw}}}${root === "input" ? `; write {{inputs${r.raw.slice(5)}}}` : ""}`);
  }
}

/** Every string inside a JSON-like value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

// `{input.prlink}`, `{inputs.x}`, `{nodes.a.output}`, `{item}`: a placeholder written with single braces.
// It would reach the agent as plain text, so it is an error with the correction, not something to guess at.
const SINGLE_BRACE = /(?<!\{)\{\s*(inputs?|nodes|item)((?:\.[A-Za-z0-9_-]+)*)\s*\}(?!\})/g;

function checkNearMisses(value: unknown, where: string, errors: string[]) {
  for (const text of strings(value)) {
    for (const m of text.matchAll(SINGLE_BRACE)) {
      if (m[1] === "nodes" && !m[2]) continue;
      const root = m[1] === "input" ? "inputs" : m[1];
      errors.push(`${where}: "${m[0]}" is not a placeholder and would be sent to the agent as it is written; write {{${root}${m[2]}}} (two braces${m[1] === "input" ? ", and `inputs`" : ""})`);
    }
  }
}

function checkNodeTemplates(node: any, wf: Workflow, topId: string, inMap: boolean, errors: string[]) {
  const where = `node "${node.id ?? topId}"`;
  const { compensate, node: inner, ...rest } = node;
  checkNearMisses({ ...rest, compensate }, where, errors);
  try {
    checkRefs(collectRefs(rest), where, wf, topId, { item: inMap }, errors);
    if (compensate) checkRefs(collectRefs(compensate), `${where} compensate`, wf, topId, { item: inMap, output: true }, errors);
  } catch (e) {
    if (e instanceof TemplateError) errors.push(`${where}: ${e.message}`); else throw e;
  }
  if (inner) checkNodeTemplates(inner, wf, topId, true, errors);
}

/**
 * The format between steps (task 9.66): an agent step's output schema is what the steps after it
 * can rely on. A placeholder that reads a field that schema does not name is reported, the way a
 * consumer that reads a field its producer's schema lacks would be. A step without a schema
 * promises nothing, so nothing is checked for it.
 */
function contractWarnings(wf: Workflow): string[] {
  const schemas = new Map<string, any>();
  for (const n of wf.nodes) {
    const s = n.type === "agent" ? n["output-schema"] : undefined;
    if (s && typeof s === "object" && !Array.isArray(s)) schemas.set(n.id, s);
  }
  const out = new Set<string>();
  for (const n of wf.nodes) {
    let refs: TemplateRef[];
    try { refs = collectRefs(n); } catch { continue; }
    for (const r of refs) {
      const [root, id, third, ...rest] = r.path;
      if (root !== "nodes" || third !== "output" || !schemas.has(id)) continue;
      let cur: any = schemas.get(id);
      const walked: string[] = [];
      for (const seg of rest) {
        // A list, a plain type or "any": the schema says nothing more about what is inside.
        if (cur == null || typeof cur !== "object" || Array.isArray(cur)) break;
        walked.push(seg);
        if (!(seg in cur)) {
          // Every agent result carries the changes it reports, whatever its schema.
          if (walked.length > 1 || seg !== "side_effects") out.add(`node "${n.id}": {{${r.raw}}} reads "${walked.join(".")}", which the output schema of "${id}" does not name (it names: ${Object.keys(cur).join(", ") || "nothing"}); add the field to that schema or read one it names`);
          break;
        }
        cur = cur[seg];
      }
    }
  }
  return [...out];
}

/** A declaration that contradicts itself (15.119): every rule here is one a person could not satisfy at run time. */
function checkInputFields(wf: Workflow, errors: string[]) {
  const list = (wf as any)["input-fields"] as any[] | undefined;
  if (!list?.length) return;
  const seen = new Set<string>();
  for (const f of list) {
    const at = `input-fields: "${f.path}"`;
    if (seen.has(f.path)) errors.push(`${at}: declared twice`);
    seen.add(f.path);
    const r = lookup(wf.inputs ?? {}, String(f.path).split("."));
    // A default is a value the run always has, so asking for a value and having one cannot both be true.
    if (f.required && r.found && r.value !== "") errors.push(`${at}: \`required\` with a default (inputs.${f.path}) says two things: it is given when the run starts, and it is not. Remove one`);
    const choice = f.type === "choose-one" || f.type === "choose-many";
    if (choice) {
      if (!f.options?.length) errors.push(`${at}: a ${f.type} field needs \`options\` to choose from`);
      for (const [i, o] of (f.options ?? []).entries()) {
        if (!o || typeof o !== "object" || !("value" in o)) errors.push(`${at}: option ${i + 1} has no \`value\` (what the step receives when it is picked)`);
      }
    } else if (f.options) errors.push(`${at}: \`options\` only belongs on a choose-one or choose-many field`);
    // A value that is not a text is not asked for in a text box: the type would be a lie.
    if (r.found && r.value !== "" && typeof r.value === "object" && r.value !== null) errors.push(`${at}: the default is an object or a list, which no ${f.type} field can hold; leave the field undeclared (it is then edited as JSON)`);
  }
}

/** Schema + graph + template validation. Environment-dependent checks (MCP servers, sandbox paths) live in the engine. */
export function validateWorkflow(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (raw && typeof raw === "object") {
    for (const n of (raw as any).nodes ?? []) {
      for (const cand of [n, n?.node, n?.compensate, n?.node?.compensate]) {
        if (cand && "sandbox" in cand && (typeof cand.sandbox !== "object" || cand.sandbox === null)) {
          errors.push(`node "${n.id}": the script sandbox cannot be disabled; \`sandbox\` only accepts { network, write, env }`);
          delete cand.sandbox;
        }
      }
    }
  }
  if (raw && typeof raw === "object") {
    for (const n of (raw as any).nodes ?? []) {
      if (n && typeof n === "object" && "unselected-to-backlog" in n) {
        errors.push(`node "${n.id}": \`unselected-to-backlog\` is no longer available; the backlog was removed. Items that were not picked are in the gate's output as \`unselected\``);
        delete n["unselected-to-backlog"];
      }
    }
  }
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) errors.push(`${i.path.join(".") || "workflow"}: ${i.message}`);
    return { ok: false, errors, warnings };
  }
  if (errors.length) return { ok: false, errors, warnings };
  const wf: Workflow = {
    ...parsed.data,
    edges: parsed.data.edges.map((e) => {
      if (typeof e !== "string") return e;
      const [from, to] = e.split("->").map((s) => s.trim());
      return { from, to };
    }),
  };
  // The inner step's default id goes first, where a written one would be, so that an export is the same text before and after a round trip.
  for (const n of wf.nodes) if (n.type === "map" && !n.node.id) n.node = { id: `${n.id}-item`, ...n.node };

  const ids = new Set<string>();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  for (const e of wf.edges) {
    if (!ids.has(e.from)) errors.push(`edge "${e.from} -> ${e.to}": unknown node "${e.from}"`);
    if (!ids.has(e.to)) errors.push(`edge "${e.from} -> ${e.to}": unknown node "${e.to}"`);
    if (e.from === e.to) errors.push(`edge "${e.from} -> ${e.to}": a node cannot depend on itself`);
  }
  if (!errors.length) {
    try { topoOrder(wf); } catch (e: any) { errors.push(e.message); }
  }
  if (!errors.length) checkInputFields(wf, errors);
  if (!errors.length) {
    for (const n of wf.nodes) {
      checkNodeTemplates(n, wf, n.id, false, errors);
      const exec: any[] = n.type === "map" ? [n.node] : [n];
      for (const x of exec) {
        if (x.type === "agent") errors.push(...checkShorthand(x["output-schema"]).map((m) => `node "${n.id}": ${m}`));
        if (x.type === "script") {
          const sb = x.sandbox ?? {};
          if ((sb.network || sb.write?.length) && !x.compensate) {
            warnings.push(`node "${n.id}": widens the sandbox without a \`compensate\`; its effects will be listed as manual on revert`);
          }
        }
        if (x.irreversible && x.compensate) warnings.push(`node "${n.id}": marked irreversible but declares a compensation`);
      }
      if (n.type === "gate" && n.kind === "select" && n.from === undefined) errors.push(`node "${n.id}": a select gate needs \`from\``);
      if (n.type === "gate" && n.kind === "ask" && !n.prompt?.trim()) errors.push(`node "${n.id}": an ask gate needs \`prompt\`: describe in plain words what you should be asked`);
      if (n.type === "gate" && n.kind !== "ask" && n.prompt !== undefined) warnings.push(`node "${n.id}": \`prompt\` is only used by an ask gate; a ${n.kind} gate shows \`message\` and does not follow instructions`);
    }
    if (!errors.length) warnings.push(...contractWarnings(wf));
    if (wf.budget?.["warn-usd"] && wf.budget["max-usd"] && wf.budget["warn-usd"] > wf.budget["max-usd"]) {
      warnings.push("budget: warn-usd is above max-usd");
    }
  }
  return { ok: errors.length === 0, errors, warnings, workflow: errors.length ? undefined : wf };
}

/** Executable nodes of a workflow, with map inner nodes flattened in. */
export function executableNodes(wf: Workflow): { top: WorkflowNode; node: any }[] {
  const out: { top: WorkflowNode; node: any }[] = [];
  for (const n of wf.nodes) {
    if (n.type === "map") out.push({ top: n, node: n.node });
    else if (n.type !== "gate") out.push({ top: n, node: n });
  }
  return out;
}

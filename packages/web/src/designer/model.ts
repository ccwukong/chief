/** Helpers for turning the designer's canvas state into a workflow definition and back. */

export type NodeDef = Record<string, any> & { id: string; type: "agent" | "script" | "gate" | "map" };

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export const isWidened = (sb: any) => !!(sb?.network || sb?.write?.length || sb?.env?.length);

function cleanSandbox(sb: any) {
  if (!isWidened(sb)) return undefined;
  return { network: !!sb.network, write: (sb.write ?? []).filter(Boolean), env: (sb.env ?? []).filter(Boolean) };
}

function cleanCompensate(c: any) {
  if (!c) return undefined;
  const out: any = {};
  if (c.prompt?.trim()) out.prompt = c.prompt;
  else if (c.run?.trim()) out.run = c.run.trim();
  else return undefined;
  for (const k of ["interpreter", "model", "timeout"]) if (!isEmpty(c[k])) out[k] = c[k];
  if (c.mcp?.length) out.mcp = c.mcp;
  const sb = cleanSandbox(c.sandbox);
  if (sb) out.sandbox = sb;
  return out;
}

/** Drop empty optional fields so the definition only says what the user set. */
export function cleanNode(n: any, inner = false): any {
  const out: any = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === "sandbox" || k === "compensate" || k === "node") continue;
    // No `mcp` field means "all connected servers"; an empty list means "none".
    if (k === "mcp" && n.type === "agent") { if (Array.isArray(v)) out.mcp = v; continue; }
    if (k === "position" && inner) continue;
    // Only an ask gate has an instruction (and a model for it); the fixed forms have their own fields.
    if (n.type === "gate" && n.kind !== "ask" && (k === "prompt" || k === "model" || k === "agent")) continue;
    if (n.type === "gate" && n.kind === "ask" && ["message", "from", "modes", "value", "summary", "options"].includes(k)) continue;
    if (k === "confirm" && v !== false) continue;
    if (k === "irreversible" && !v) continue;
    if (isEmpty(v)) continue;
    out[k] = v;
  }
  if (n.type === "script") { const sb = cleanSandbox(n.sandbox); if (sb) out.sandbox = sb; }
  if (n.type === "agent" || n.type === "script") { const c = cleanCompensate(n.compensate); if (c) out.compensate = c; }
  if (n.type === "map") out.node = cleanNode(n.node ?? { type: "agent", prompt: "" }, true);
  if (inner && isEmpty(out.id)) delete out.id;
  return out;
}

export interface Widening { node_id: string; what: string }

const describe = (sb: any) => [sb?.network ? "network access" : null, sb?.write?.length ? `write to ${sb.write.join(", ")}` : null, sb?.env?.length ? `environment variables ${sb.env.join(", ")}` : null].filter(Boolean).join("; ");

/** Script nodes (including map inner nodes and script compensations) that ask for more than the default sandbox. */
export function widenings(nodes: any[]): Widening[] {
  const out: Widening[] = [];
  for (const top of nodes) {
    const n = top.type === "map" ? top.node : top;
    if (!n) continue;
    if (n.type === "script" && isWidened(n.sandbox)) out.push({ node_id: top.id, what: describe(n.sandbox) });
    if (n.compensate?.run && isWidened(n.compensate.sandbox ?? n.sandbox) && !(n.type === "script" && !n.compensate.sandbox)) out.push({ node_id: `${top.id} (compensation)`, what: describe(n.compensate.sandbox ?? n.sandbox) });
  }
  return out;
}

export function newNode(kind: string, server: string | null, taken: Set<string>): NodeDef {
  const base = kind === "agent" ? (server ?? "agent") : kind;
  let id = base, i = 2;
  while (taken.has(id)) id = `${base}-${i++}`;
  if (kind === "agent") return { id, type: "agent", prompt: "", ...(server ? { mcp: [server] } : {}) };
  if (kind === "script") return { id, type: "script", run: "" };
  // A new gate is described in plain words; the fixed forms are a choice in its panel.
  if (kind === "gate") return { id, type: "gate", kind: "ask", prompt: "" };
  return { id, type: "map", over: "", mode: "sequential", "max-parallel": 3, "on-error": "fail", node: { type: "agent", prompt: "" } };
}

/** Positions for nodes that have none: one row per dependency level. */
export function autoLayout(nodes: any[], edges: { from: string; to: string }[]): Record<string, { x: number; y: number }> {
  const depth: Record<string, number> = {};
  const visit = (id: string, seen: Set<string>): number => {
    if (depth[id] !== undefined) return depth[id];
    if (seen.has(id)) return 0;
    seen.add(id);
    const preds = edges.filter((e) => e.to === id).map((e) => e.from);
    return (depth[id] = preds.length ? Math.max(...preds.map((p) => visit(p, seen))) + 1 : 0);
  };
  const perLevel: Record<number, number> = {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    const d = visit(n.id, new Set());
    const col = (perLevel[d] = (perLevel[d] ?? 0) + 1) - 1;
    out[n.id] = n.position ?? { x: 60 + col * 260, y: 40 + d * 130 };
  }
  return out;
}

/**
 * Positions for a definition that arrives without a complete layout (from the assistant): a step
 * keeps its own position if it has one, else the one a step with its id has on the canvas now;
 * the others are laid out by dependency level and moved aside when that spot is taken.
 */
export function placeNodes(nodes: any[], edges: { from: string; to: string }[], onCanvas: Record<string, { x: number; y: number }>): any[] {
  const placed = nodes.map((n) => ({ ...n, position: n.position ?? onCanvas[n.id] }));
  const layout = autoLayout(nodes.map(({ position: _p, ...n }) => n), edges);
  const taken = placed.filter((n) => n.position).map((n) => n.position as { x: number; y: number });
  const hits = (p: { x: number; y: number }) => taken.some((t) => Math.abs(t.x - p.x) < 230 && Math.abs(t.y - p.y) < 100);
  for (const n of placed) {
    if (n.position) continue;
    const p = { ...layout[n.id] };
    for (let i = 0; i < 50 && hits(p); i++) p.x += 260;
    n.position = p;
    taken.push(p);
  }
  return placed;
}

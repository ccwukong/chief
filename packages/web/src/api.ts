/** Thin client for the chief HTTP API (see packages/chief/src/server/app.ts). */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  if (!res.ok) throw new Error(typeof data === "object" && data?.error ? data.error : `${res.status} ${res.statusText}`);
  return data as T;
}

export const get = <T = any>(path: string) => api<T>("GET", path);

/** One page of a list endpoint: the items, and the total from the `X-Total-Count` header. */
export async function getPage<T = any>(path: string, page: number, perPage: number): Promise<{ items: T[]; total: number }> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}limit=${perPage}&offset=${(page - 1) * perPage}`);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return { items: data, total: Number(res.headers.get("X-Total-Count") ?? data.length) };
}

export const usd = (n: number | null | undefined) => `$${(n ?? 0).toFixed(4)}`;
/** A token count as a person reads it: 1164981 is 1,164,981. Uses one locale so the separators do not depend on the browser. */
export const tokenCount = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US");
export const pretty = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** An adapter's name as a person reads it. One list, so the shell, the designer and Settings agree. */
export const AGENT_NAME: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", antigravity: "Antigravity", opencode: "OpenCode", hermes: "Hermes" };
export const agentName = (a: string) => AGENT_NAME[a] ?? a;
/** A list as a person reads it: "A", "A and B", "A, B and C". */
export function agentList(names: string[]): string {
  const n = names.map(agentName);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

export const STATUS_COLOR: Record<string, string> = {
  pending: "bg-slate-200 text-slate-700",
  running: "bg-blue-100 text-blue-800",
  waiting_gate: "bg-amber-100 text-amber-800",
  paused: "bg-purple-100 text-purple-800",
  interrupted: "bg-purple-100 text-purple-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-slate-300 text-slate-700",
  reverting: "bg-orange-100 text-orange-800",
  reverted: "bg-orange-100 text-orange-800",
};

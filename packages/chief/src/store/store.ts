import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dbPath } from "../paths.ts";
import { migrations } from "./migrations/index.ts";
import type {
  EventRow, GateRow, McpServerRow, NodeRunRow, NodeRunStatus, RunRow, RunStatus,
  MessageDirection, MessageRow, ScheduleRow, SideEffectRow, WorkflowRow, AssistantRow,
} from "./types.ts";

const MAX_MESSAGE_CHARS = 2_000_000;
/** A definition without its name and the canvas positions of its nodes (neither changes what runs). */
const withoutPositions = (d: any) => ({ ...d, name: undefined, nodes: (d?.nodes ?? []).map(({ position: _p, ...n }: any) => n) });
/** Events that are also part of a run's record as they are (status changes and chief's own decisions). */
const RECORDED_EVENTS = /^(run_(?!created$)|node_|budget_|revert_|restarted$|scheduled$|engine_error$|output_truncated$|side_effect$)/;

const now = () => new Date().toISOString();
const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const p = (s: string | null | undefined) => (s == null ? null : JSON.parse(s));

/** Rename `<name>_json` columns to `<name>` and parse them. */
function parseRow<T>(row: any): T {
  if (!row) return row;
  const out: any = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith("_json")) out[k.slice(0, -5)] = p(v as string | null);
    else out[k] = v;
  }
  return out as T;
}

/**
 * A small adapter over `node:sqlite` that gives the rest of this file the surface it expects:
 * `exec`, `query(...).get/all`, `run(sql, params)` returning `{ changes, lastInsertRowid }`, and
 * `transaction(fn)` (called as `tx(fn)()` or `tx(fn)().immediate()`).
 *
 * Two differences that matter and are handled here rather than at every call site:
 * - `node:sqlite` binds parameters spread out (`run(...params)`) and refuses `undefined` and
 *   booleans; this wraps them into `null` and `0`/`1`, which is what SQLite accepts.
 * - a transaction is `BEGIN IMMEDIATE` (the old `.immediate()`), so two processes writing the 5
 *   rows of one step cannot interleave.
 */
class Database {
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  exec(sql: string) { this.db.exec(sql); }

  close() { this.cache.clear(); this.db.close(); }

  private statement(sql: string): StatementSync {
    let st = this.cache.get(sql);
    if (!st) { st = this.db.prepare(sql); this.cache.set(sql, st); }
    return st;
  }

  private static bind(params: any[]) {
    return params.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
  }

  query(sql: string) {
    const st = this.statement(sql);
    return {
      get: (...params: any[]) => st.get(...Database.bind(params)),
      all: (...params: any[]) => st.all(...Database.bind(params)),
    };
  }

  run(sql: string, params: any[] = []) {
    const r = this.statement(sql).run(...Database.bind(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** `db.transaction(fn)()` as before; `.immediate()` is kept so call sites read the same. */
  transaction<T>(fn: () => T) {
    const run = () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        this.db.exec("COMMIT");
        return out;
      } catch (e) {
        try { this.db.exec("ROLLBACK"); } catch { /* the transaction was already closed */ }
        throw e;
      }
    };
    (run as any).immediate = run;
    return run as (() => T) & { immediate: () => T };
  }
}

/**
 * Thin repository over the single SQLite file. This is the only module that imports
 * `node:sqlite`. All methods are synchronous, like the driver.
 */
export class Store {
  readonly db: Database;

  constructor(path: string = dbPath()) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close() { this.db.close(); }

  private migrate() {
    // The migrations table itself moved into the `system` schema with migration 003.
    const has = (t: string) => !!this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (has("schema_migrations") && !has("system__migrations")) this.db.exec("ALTER TABLE schema_migrations RENAME TO system__migrations");
    this.db.exec("CREATE TABLE IF NOT EXISTS system__migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const applied = new Set(this.db.query("SELECT id FROM system__migrations").all().map((r: any) => r.id));
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db.run("INSERT INTO system__migrations (id, name, applied_at) VALUES (?, ?, ?)", [m.id, m.name, now()]);
      })();
    }
  }

  /**
   * The schemas of the one database and their tables. Every table is named `<schema>__<table>`;
   * anything else is reported under "(none)" so that it is noticed.
   */
  schemas(): Record<string, { table: string; rows: number }[]> {
    const out: Record<string, { table: string; rows: number }[]> = {};
    for (const { name } of this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]) {
      const i = name.indexOf("__");
      const schema = i > 0 ? name.slice(0, i) : "(none)";
      const rows = (this.db.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as any).n as number;
      (out[schema] ??= []).push({ table: i > 0 ? name.slice(i + 2) : name, rows });
    }
    return out;
  }

  appliedMigrations(): { id: number; name: string }[] {
    return this.db.query("SELECT id, name FROM system__migrations ORDER BY id").all() as any;
  }

  private all<T>(sql: string, params: any[] = []): T[] {
    return (this.db.query(sql).all(...params) as any[]).map((r) => parseRow<T>(r));
  }
  private one<T>(sql: string, params: any[] = []): T | null {
    const r = this.db.query(sql).get(...params);
    return r ? parseRow<T>(r) : null;
  }
  private insert(sql: string, params: any[]): number {
    return Number(this.db.run(sql, params).lastInsertRowid);
  }

  // ── settings ────────────────────────────────────────────────────────────
  getSetting<T = any>(key: string, fallback?: T): T {
    const r = this.db.query("SELECT value_json FROM system__settings WHERE key = ?").get(key) as any;
    return r ? JSON.parse(r.value_json) : (fallback as T);
  }
  setSetting(key: string, value: unknown) {
    this.db.run("INSERT INTO system__settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json", [key, JSON.stringify(value)]);
  }
  allSettings(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const r of this.db.query("SELECT key, value_json FROM system__settings").all() as any[]) out[r.key] = JSON.parse(r.value_json);
    return out;
  }

  // ── workflows ───────────────────────────────────────────────────────────
  listWorkflows(): WorkflowRow[] { return this.all("SELECT * FROM workflow__definitions ORDER BY name"); }
  getWorkflow(nameOrId: string | number): WorkflowRow | null {
    return typeof nameOrId === "number" || /^\d+$/.test(String(nameOrId))
      ? this.one("SELECT * FROM workflow__definitions WHERE id = ?", [Number(nameOrId)]) ?? this.one("SELECT * FROM workflow__definitions WHERE name = ?", [String(nameOrId)])
      : this.one("SELECT * FROM workflow__definitions WHERE name = ?", [nameOrId]);
  }
  /**
   * Insert, or update when the definition changed.
   * `version` mode (an explicit import): every change is a new version.
   * `autosave` mode (the designer saving on every edit): a new version starts only when the
   * current one has been run, and never for a change that only moves nodes on the canvas.
   */
  saveWorkflow(name: string, definition: any, baseDir: string | null, mode: "version" | "autosave" = "version"): WorkflowRow {
    const existing = this.getWorkflow(name);
    const t = now();
    if (!existing) {
      this.insert("INSERT INTO workflow__definitions (name, version, definition_json, base_dir, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)", [name, j(definition), baseDir, t, t]);
    } else if (JSON.stringify(existing.definition) !== JSON.stringify(definition) || existing.base_dir !== baseDir) {
      const layoutOnly = JSON.stringify(withoutPositions(existing.definition)) === JSON.stringify(withoutPositions(definition)) && existing.base_dir === baseDir;
      const wasRun = !!this.db.query("SELECT 1 FROM run__runs WHERE workflow_id = ? AND workflow_version = ? LIMIT 1").get(existing.id, existing.version);
      const bump = mode === "version" || (!layoutOnly && wasRun) ? 1 : 0;
      this.db.run("UPDATE workflow__definitions SET version = version + ?, definition_json = ?, base_dir = ?, updated_at = ? WHERE id = ?", [bump, j(definition), baseDir, t, existing.id]);
    }
    return this.getWorkflow(name)!;
  }
  /** Rename a workflow. Runs, schedules and approvals follow because they refer to its id. */
  renameWorkflow(id: number, name: string) {
    this.db.run("UPDATE workflow__definitions SET name = ?, updated_at = ? WHERE id = ?", [name, now(), id]);
  }
  deleteWorkflow(id: number) {
    this.db.run("DELETE FROM workflow__script_approvals WHERE workflow_id = ?", [id]);
    this.db.run("DELETE FROM workflow__schedules WHERE workflow_id = ?", [id]);
    this.db.run("DELETE FROM workflow__definitions WHERE id = ?", [id]);
  }
  workflowHasRuns(id: number): boolean {
    return !!this.db.query("SELECT 1 FROM run__runs WHERE workflow_id = ? LIMIT 1").get(id);
  }

  // ── script approvals ────────────────────────────────────────────────────
  getApproval(workflowId: number, nodeId: string): string | null {
    const r = this.db.query("SELECT script_hash FROM workflow__script_approvals WHERE workflow_id = ? AND node_id = ?").get(workflowId, nodeId) as any;
    return r?.script_hash ?? null;
  }
  setApproval(workflowId: number, nodeId: string, hash: string) {
    this.db.run("INSERT INTO workflow__script_approvals (workflow_id, node_id, script_hash, approved_at) VALUES (?, ?, ?, ?) ON CONFLICT(workflow_id, node_id) DO UPDATE SET script_hash = excluded.script_hash, approved_at = excluded.approved_at", [workflowId, nodeId, hash, now()]);
  }

  // ── runs ────────────────────────────────────────────────────────────────
  createRun(wf: WorkflowRow, inputs: any, budget: any, parentRunId: number | null = null): RunRow {
    const id = this.insert(
      "INSERT INTO run__runs (workflow_id, workflow_version, definition_json, base_dir, inputs_json, budget_json, parent_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [wf.id, wf.version, j(wf.definition), wf.base_dir, j(inputs ?? {}), j(budget ?? null), parentRunId, now()],
    );
    return this.getRun(id)!;
  }
  getRun(id: number): RunRow | null { return this.one("SELECT * FROM run__runs WHERE id = ?", [id]); }
  /** Runs, newest first, optionally only those of one workflow; `offset` skips the newest ones. */
  listRuns(limit = 50, workflowId?: number, offset = 0): (RunRow & { workflow_name: string })[] {
    return workflowId == null
      ? this.all("SELECT r.*, w.name AS workflow_name FROM run__runs r JOIN workflow__definitions w ON w.id = r.workflow_id ORDER BY r.id DESC LIMIT ? OFFSET ?", [limit, offset])
      : this.all("SELECT r.*, w.name AS workflow_name FROM run__runs r JOIN workflow__definitions w ON w.id = r.workflow_id WHERE r.workflow_id = ? ORDER BY r.id DESC LIMIT ? OFFSET ?", [workflowId, limit, offset]);
  }
  /** How many runs there are, optionally only those of one workflow. */
  countRuns(workflowId?: number): number {
    const r = (workflowId == null
      ? this.db.query("SELECT COUNT(*) AS n FROM run__runs").get()
      : this.db.query("SELECT COUNT(*) AS n FROM run__runs WHERE workflow_id = ?").get(workflowId)) as any;
    return r.n as number;
  }
  /**
   * Delete runs and everything recorded for them, in one transaction. Runs carried over from a
   * deleted run stay, without the link back to it. Callers check that the runs are finished.
   */
  deleteRuns(ids: number[]) {
    if (!ids.length) return;
    const marks = ids.map(() => "?").join(",");
    this.db.transaction(() => {
      for (const t of ["run__messages", "run__events", "run__side_effects", "run__gates", "run__node_runs"]) this.db.run(`DELETE FROM ${t} WHERE run_id IN (${marks})`, ids);
      this.db.run(`UPDATE run__runs SET parent_run_id = NULL WHERE parent_run_id IN (${marks})`, ids);
      this.db.run(`DELETE FROM run__runs WHERE id IN (${marks})`, ids);
    }).immediate();
  }
  runsByStatus(statuses: RunStatus[]): RunRow[] {
    return this.all(`SELECT * FROM run__runs WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`, statuses);
  }
  /** Replace the definition a run follows (a step changed while the run is stopped). */
  updateRunDefinition(id: number, definition: unknown) { this.db.run("UPDATE run__runs SET definition_json = ? WHERE id = ?", [j(definition), id]); }
  childRuns(parentId: number): RunRow[] { return this.all("SELECT * FROM run__runs WHERE parent_run_id = ? ORDER BY id", [parentId]); }
  updateRun(id: number, patch: Partial<Record<"status" | "requested_action" | "owner_pid" | "error" | "started_at" | "finished_at" | "tokens_in" | "tokens_out" | "cost_usd", any>> & { budget?: any }) {
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === "budget") { sets.push("budget_json = ?"); vals.push(j(v)); } else { sets.push(`${k} = ?`); vals.push(v); }
    }
    if (!sets.length) return;
    this.db.run(`UPDATE run__runs SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
  }
  /** Take ownership of a run for this process. Fails if another live process owns it. */
  claimRun(id: number, pid: number, isAlive: (pid: number) => boolean): boolean {
    return this.db.transaction(() => {
      const r = this.db.query("SELECT owner_pid FROM run__runs WHERE id = ?").get(id) as any;
      if (!r) return false;
      if (r.owner_pid && r.owner_pid !== pid && isAlive(r.owner_pid)) return false;
      this.db.run("UPDATE run__runs SET owner_pid = ? WHERE id = ?", [pid, id]);
      return true;
    }).immediate();
  }
  releaseRun(id: number, pid: number) { this.db.run("UPDATE run__runs SET owner_pid = NULL WHERE id = ? AND owner_pid = ?", [id, pid]); }

  // ── node runs ───────────────────────────────────────────────────────────
  createNodeRun(v: { run_id: number; node_id: string; node_type: string; phase?: string; attempt?: number; parent_node_run_id?: number | null; item_index?: number | null; input?: any }): NodeRunRow {
    const id = this.insert(
      "INSERT INTO run__node_runs (run_id, node_id, node_type, phase, attempt, parent_node_run_id, item_index, input_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [v.run_id, v.node_id, v.node_type, v.phase ?? "forward", v.attempt ?? 1, v.parent_node_run_id ?? null, v.item_index ?? null, j(v.input), now()],
    );
    return this.getNodeRun(id)!;
  }
  getNodeRun(id: number): NodeRunRow | null { return this.one("SELECT * FROM run__node_runs WHERE id = ?", [id]); }
  nodeRuns(runId: number): NodeRunRow[] { return this.all("SELECT * FROM run__node_runs WHERE run_id = ? ORDER BY id", [runId]); }
  /** Latest attempt of a node (or of one map child) in the forward phase. */
  latestNodeRun(runId: number, nodeId: string, parentId: number | null = null, itemIndex: number | null = null): NodeRunRow | null {
    return this.one(
      "SELECT * FROM run__node_runs WHERE run_id = ? AND node_id = ? AND phase = 'forward' AND parent_node_run_id IS ? AND item_index IS ? ORDER BY attempt DESC, id DESC LIMIT 1",
      [runId, nodeId, parentId, itemIndex],
    );
  }
  updateNodeRun(id: number, patch: Partial<{ status: NodeRunStatus; input: any; output: any; session_id: string | null; usage: any; state: any; error: string | null; compensated_at: string | null; started_at: string | null; finished_at: string | null }>) {
    const sets: string[] = []; const vals: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (["input", "output", "usage", "state"].includes(k)) { sets.push(`${k}_json = ?`); vals.push(j(v)); } else { sets.push(`${k} = ?`); vals.push(v); }
    }
    if (!sets.length) return;
    this.db.run(`UPDATE run__node_runs SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
  }

  // ── gates ───────────────────────────────────────────────────────────────
  createGate(v: { run_id: number; node_run_id?: number | null; node_id?: string | null; kind: string; reason?: string; payload: any }): GateRow {
    const id = this.insert("INSERT INTO run__gates (run_id, node_run_id, node_id, kind, reason, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [v.run_id, v.node_run_id ?? null, v.node_id ?? null, v.kind, v.reason ?? "node", j(v.payload), now()]);
    return this.getGate(id)!;
  }
  getGate(id: number): GateRow | null { return this.one("SELECT * FROM run__gates WHERE id = ?", [id]); }
  gates(filter: { runId?: number; status?: string } = {}): GateRow[] {
    const w: string[] = []; const v: any[] = [];
    if (filter.runId != null) { w.push("run_id = ?"); v.push(filter.runId); }
    if (filter.status) { w.push("status = ?"); v.push(filter.status); }
    return this.all(`SELECT * FROM run__gates ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY id`, v);
  }
  latestGateFor(nodeRunId: number): GateRow | null { return this.one("SELECT * FROM run__gates WHERE node_run_id = ? ORDER BY id DESC LIMIT 1", [nodeRunId]); }
  latestBudgetGate(runId: number): GateRow | null { return this.one("SELECT * FROM run__gates WHERE run_id = ? AND reason = 'budget' ORDER BY id DESC LIMIT 1", [runId]); }
  answerGate(id: number, answer: any) {
    this.db.run("UPDATE run__gates SET answer_json = ?, status = 'answered', answered_at = ? WHERE id = ?", [j(answer), now(), id]);
  }
  /** Mark an answered gate as consumed so it is not applied twice. */
  consumeGate(id: number) { this.db.run("UPDATE run__gates SET status = 'consumed' WHERE id = ?", [id]); }
  /** Withdraw one waiting gate (its step was changed instead of being answered). */
  cancelGate(id: number) { this.db.run("UPDATE run__gates SET status = 'cancelled' WHERE id = ? AND status = 'waiting'", [id]); }
  cancelGates(runId: number) { this.db.run("UPDATE run__gates SET status = 'cancelled' WHERE run_id = ? AND status = 'waiting'", [runId]); }

  // ── side effects ────────────────────────────────────────────────────────
  addSideEffect(v: { run_id: number; node_run_id: number; kind: string; ref?: string | null; url?: string | null; how_to_undo?: string | null; irreversible?: boolean }) {
    this.insert("INSERT INTO run__side_effects (run_id, node_run_id, kind, ref, url, how_to_undo, irreversible, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [v.run_id, v.node_run_id, v.kind, v.ref ?? null, v.url ?? null, v.how_to_undo ?? null, v.irreversible ? 1 : 0, now()]);
  }
  sideEffects(filter: { runId?: number; nodeRunId?: number }): SideEffectRow[] {
    if (filter.nodeRunId != null) return this.all("SELECT * FROM run__side_effects WHERE node_run_id = ? ORDER BY id", [filter.nodeRunId]);
    return this.all("SELECT * FROM run__side_effects WHERE run_id = ? ORDER BY id", [filter.runId]);
  }
  markReverted(sideEffectId: number) { this.db.run("UPDATE run__side_effects SET reverted_at = ? WHERE id = ?", [now(), sideEffectId]); }

  // ── events ──────────────────────────────────────────────────────────────
  /** Called for every event once it is stored (`chief serve` prints them in its terminal). */
  onEvent: ((e: { runId: number; type: string; payload: any; nodeRunId: number | null }) => void) | null = null;
  addEvent(runId: number, type: string, payload: any = {}, nodeRunId: number | null = null) {
    this.insert("INSERT INTO run__events (run_id, node_run_id, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)", [runId, nodeRunId, now(), type, j(payload)]);
    if (RECORDED_EVENTS.test(type)) {
      // Run-level entries are not attributed to a node, even when their payload names one.
      const nodeId = nodeRunId != null || !type.startsWith("run_") ? payload?.node_id ?? null : null;
      this.addMessage(runId, { node_run_id: nodeRunId, node_id: nodeId, direction: "system", kind: type, content: payload?.error ?? payload?.reason ?? "", meta: payload });
    }
    try { this.onEvent?.({ runId, type, payload, nodeRunId }); } catch { /* a listener never breaks the record */ }
  }
  events(runId: number, afterId = 0, limit = 1000): EventRow[] {
    return this.all("SELECT * FROM run__events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?", [runId, afterId, limit]);
  }

  // ── run messages (the full record of a run) ─────────────────────────────
  private workflowOf = new Map<number, number>();

  /** Append to a run's record. Content is stored in full (capped at 2 MB per message). */
  addMessage(runId: number, v: { node_run_id?: number | null; node_id?: string | null; direction: MessageDirection; kind: string; content?: string; meta?: any }) {
    let wf = this.workflowOf.get(runId);
    if (wf === undefined) {
      wf = (this.db.query("SELECT workflow_id FROM run__runs WHERE id = ?").get(runId) as any)?.workflow_id;
      if (wf === undefined) return;
      this.workflowOf.set(runId, wf);
    }
    let content = v.content ?? "";
    let meta = v.meta;
    if (content.length > MAX_MESSAGE_CHARS) {
      meta = { ...(meta ?? {}), truncated: true, original_chars: content.length };
      content = content.slice(0, MAX_MESSAGE_CHARS);
    }
    let nodeId = v.node_id ?? null;
    if (nodeId == null && v.node_run_id != null) nodeId = (this.db.query("SELECT node_id FROM run__node_runs WHERE id = ?").get(v.node_run_id) as any)?.node_id ?? null;
    this.insert("INSERT INTO run__messages (run_id, workflow_id, node_run_id, node_id, ts, direction, kind, content, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [runId, wf, v.node_run_id ?? null, nodeId, now(), v.direction, v.kind, content, j(meta)]);
  }
  messages(runId: number, filter: { afterId?: number; nodeId?: string; kinds?: string[]; limit?: number } = {}): MessageRow[] {
    const w = ["run_id = ?", "id > ?"]; const p: any[] = [runId, filter.afterId ?? 0];
    if (filter.nodeId) { w.push("node_id = ?"); p.push(filter.nodeId); }
    if (filter.kinds?.length) { w.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`); p.push(...filter.kinds); }
    return this.all(`SELECT * FROM run__messages WHERE ${w.join(" AND ")} ORDER BY id LIMIT ?`, [...p, filter.limit ?? 100_000]);
  }
  /** How many rows a run's record has; `excludeKindPrefix` leaves out kinds that start with it (the conversation about the run). */
  messageCount(runId: number, opts: { excludeKindPrefix?: string } = {}): number {
    if (opts.excludeKindPrefix) return (this.db.query("SELECT COUNT(*) AS n FROM run__messages WHERE run_id = ? AND kind NOT LIKE ? ESCAPE '\\'").get(runId, opts.excludeKindPrefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%") as any).n;
    return (this.db.query("SELECT COUNT(*) AS n FROM run__messages WHERE run_id = ?").get(runId) as any).n;
  }

  /**
   * What each node was given and answered, for the run page: only the message kinds it shows, and only
   * the columns it needs. Reading the whole record here made every page load — and every event, since the
   * page refetches on each one — as expensive as the run's entire transcript, which is megabytes for a
   * run with big tool results (task 15.23).
   */
  runInputs(runId: number): MessageRow[] {
    return this.all(
      "SELECT id, node_run_id, kind, content FROM run__messages WHERE run_id = ? AND node_run_id IS NOT NULL AND kind IN ('prompt', 'stdin', 'gate_question', 'gate_answer') ORDER BY id",
      [runId],
    );
  }

  // ── the assistant's conversation (task 9.64) ─────────────────────────────
  assistantMessages(filter: { roles?: string[]; limit?: number } = {}): AssistantRow[] {
    const w = ["1 = 1"]; const p: any[] = [];
    if (filter.roles?.length) { w.push(`role IN (${filter.roles.map(() => "?").join(", ")})`); p.push(...filter.roles); }
    // The newest `limit` rows, returned oldest first.
    return this.all<AssistantRow>(`SELECT * FROM (SELECT * FROM assistant__messages WHERE ${w.join(" AND ")} ORDER BY id DESC LIMIT ?) ORDER BY id`, [...p, filter.limit ?? 100_000]);
  }
  addAssistantMessage(v: { role: AssistantRow["role"]; content?: string; meta?: any }): number {
    let content = v.content ?? "";
    let meta = v.meta;
    if (content.length > MAX_MESSAGE_CHARS) { meta = { ...(meta ?? {}), truncated: true, original_chars: content.length }; content = content.slice(0, MAX_MESSAGE_CHARS); }
    return this.insert("INSERT INTO assistant__messages (ts, role, content, meta_json) VALUES (?, ?, ?, ?)", [now(), v.role, content, j(meta)]);
  }
  clearAssistant(): number { return this.db.run("DELETE FROM assistant__messages").changes; }
  /** The id of the newest run event of any run: a cheap way to know whether anything has happened since. */
  lastEventId(): number { return (this.db.query("SELECT COALESCE(MAX(id), 0) AS n FROM run__events").get() as any).n; }

  // ── drafts (text typed in the web UI that is not saved or sent yet) ──────
  drafts(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.db.query("SELECT key, value_json FROM draft__entries WHERE value_json IS NOT NULL").all() as any[]) out[r.key] = JSON.parse(r.value_json);
    return out;
  }
  /** Store (or with `undefined`, remove) a draft. A write with an older `seq` than the stored one is ignored. */
  putDraft(key: string, value: unknown, seq: number): boolean {
    return this.db.run(
      "INSERT INTO draft__entries (key, value_json, seq, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, seq = excluded.seq, updated_at = excluded.updated_at WHERE excluded.seq > draft__entries.seq",
      [key, value === undefined ? null : JSON.stringify(value), seq, now()],
    ).changes > 0;
  }
  removeDraftsWithPrefix(prefix: string, seq: number) {
    const like = prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    this.db.run("UPDATE draft__entries SET value_json = NULL, seq = ?, updated_at = ? WHERE key LIKE ? ESCAPE '\\' AND seq < ?", [seq, now(), like, seq]);
  }
  /** Forget the markers of drafts removed more than a day ago. */
  pruneDrafts() {
    this.db.run("DELETE FROM draft__entries WHERE value_json IS NULL AND updated_at < ?", [new Date(Date.now() - 86_400_000).toISOString()]);
  }

  // ── mcp servers ─────────────────────────────────────────────────────────
  // Per folder: an agent CLI has different servers in different folders (local scope, .mcp.json).
  /** The servers an adapter reported for a folder; with no folder, every remembered row (for counts and listings). */
  mcpServers(adapter?: string, folder?: string): McpServerRow[] {
    if (adapter && folder != null) return this.all("SELECT * FROM agent__mcp_servers WHERE adapter = ? AND folder = ? ORDER BY name", [adapter, folder]);
    if (folder != null) return this.all("SELECT * FROM agent__mcp_servers WHERE folder = ? ORDER BY adapter, name", [folder]);
    return adapter ? this.all("SELECT * FROM agent__mcp_servers WHERE adapter = ? ORDER BY folder, name", [adapter]) : this.all("SELECT * FROM agent__mcp_servers ORDER BY adapter, folder, name");
  }
  /** Replace what is remembered about one adapter's servers in one folder with what its CLI reports now. */
  replaceMcpServers(adapter: string, folder: string, servers: { name: string; config: any }[]) {
    this.db.transaction(() => {
      this.db.run("DELETE FROM agent__mcp_servers WHERE adapter = ? AND folder = ?", [adapter, folder]);
      for (const s of servers) {
        this.db.run("INSERT INTO agent__mcp_servers (adapter, folder, name, source, config_json, updated_at) VALUES (?, ?, ?, 'discovered', ?, ?)", [adapter, folder, s.name, j(s.config), now()]);
      }
      // "No servers" is asked again next time instead of being trusted for minutes.
      this.db.run("INSERT INTO agent__mcp_reads (adapter, folder, read_at) VALUES (?, ?, ?) ON CONFLICT(adapter, folder) DO UPDATE SET read_at = excluded.read_at", [adapter, folder, servers.length ? Date.now() : 0]);
    })();
  }
  /** When an adapter's servers were last read for a folder (ms since epoch; 0 if never or if none were reported). */
  mcpReadAt(adapter: string, folder: string): number {
    return ((this.db.query("SELECT read_at FROM agent__mcp_reads WHERE adapter = ? AND folder = ?").get(adapter, folder) as any)?.read_at as number) ?? 0;
  }

  // ── schedules ───────────────────────────────────────────────────────────
  addSchedule(workflowId: number, cron: string, inputs: any = {}): ScheduleRow {
    const id = this.insert("INSERT INTO workflow__schedules (workflow_id, cron, inputs_json, created_at) VALUES (?, ?, ?, ?)", [workflowId, cron, j(inputs), now()]);
    return this.one("SELECT * FROM workflow__schedules WHERE id = ?", [id])!;
  }
  schedules(): (ScheduleRow & { workflow_name: string })[] {
    return this.all("SELECT s.*, w.name AS workflow_name FROM workflow__schedules s JOIN workflow__definitions w ON w.id = s.workflow_id ORDER BY s.id");
  }
  /** One page of them, for the Schedules page (every list page is paged; see AGENTS.md). */
  listSchedules(limit: number, offset: number): (ScheduleRow & { workflow_name: string })[] {
    return this.all("SELECT s.*, w.name AS workflow_name FROM workflow__schedules s JOIN workflow__definitions w ON w.id = s.workflow_id ORDER BY s.id LIMIT ? OFFSET ?", [limit, offset]);
  }
  countSchedules(): number { return (this.one("SELECT COUNT(*) AS n FROM workflow__schedules") as { n: number }).n; }
  removeSchedule(id: number): boolean { return this.db.run("DELETE FROM workflow__schedules WHERE id = ?", [id]).changes > 0; }
  setScheduleEnabled(id: number, enabled: boolean) { this.db.run("UPDATE workflow__schedules SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]); }
  /** Change what a schedule runs on: its expression, its inputs, whether it fires. Only the given fields. */
  updateSchedule(id: number, patch: { cron?: string; inputs?: any; enabled?: boolean }) {
    if (patch.cron !== undefined) this.db.run("UPDATE workflow__schedules SET cron = ? WHERE id = ?", [patch.cron, id]);
    if (patch.inputs !== undefined) this.db.run("UPDATE workflow__schedules SET inputs_json = ? WHERE id = ?", [j(patch.inputs), id]);
    if (patch.enabled !== undefined) this.db.run("UPDATE workflow__schedules SET enabled = ? WHERE id = ?", [patch.enabled ? 1 : 0, id]);
  }
  /** One schedule joined with its workflow's name, or undefined. */
  schedule(id: number): (ScheduleRow & { workflow_name: string }) | undefined {
    return this.one("SELECT s.*, w.name AS workflow_name FROM workflow__schedules s JOIN workflow__definitions w ON w.id = s.workflow_id WHERE s.id = ?", [id]) ?? undefined;
  }
  touchSchedule(id: number, at: string) { this.db.run("UPDATE workflow__schedules SET last_run_at = ? WHERE id = ?", [at, id]); }
}

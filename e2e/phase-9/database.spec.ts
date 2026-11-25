import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, fake, ROOT_DIR, test } from "../helpers";

const SCHEMAS = ["agent", "assistant", "collection", "draft", "run", "system", "workflow"];
const sqlite = (db: string, sql: string) => {
  const r = spawnSync("/usr/bin/sqlite3", [db, sql], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};

/** The newest migration on disk: a count typed here broke four cases the moment 010 was added. */
const MIGRATIONS = readdirSync(join(ROOT_DIR, "packages/chief/src/store/migrations")).filter((f) => f.endsWith(".sql")).sort();
const LATEST = MIGRATIONS.at(-1)!.replace(/\.sql$/, "");

test("E9.6-1 one SQLite file holds everything, and every table belongs to a feature schema", ({ chief }) => {
  // Use most of the product once: workflow, run with a gate, script approval, schedule, MCP list, settings.
  chief.file("s.sh", "cat > /dev/null\necho '{}'\n");
  chief.importWorkflow(`
name: everything
nodes:
  - { id: a, type: agent, mcp: [slack], prompt: 'A ${fake({ output: { side_effects: [{ kind: "doc", ref: "d" }] } })}' }
  - { id: s, type: script, run: s.sh, sandbox: { network: true } }
  - { id: g, type: gate, kind: approve, value: x }
edges: [a -> s, s -> g]
`, ["--approve-sandbox"]);
  chief.run(["run", "everything"]);
  chief.run(["schedule", "add", "everything", "0 9 * * *"]);
  chief.run(["settings", "set", "notify", "false"]);

  // Exactly one database in chief's home (plus SQLite's own journal files for it).
  const files = readdirSync(chief.home).filter((f) => !["runs"].includes(f));
  expect(files.filter((f) => !/^chief\.db(-wal|-shm)?$/.test(f))).toEqual([]);
  expect(files).toContain("chief.db");
  const strays = spawnSync("find", [chief.home, "-type", "f", "(", "-name", "*.db", "-o", "-name", "*.sqlite", "-o", "-name", "*.sqlite3", ")"], { encoding: "utf8" }).stdout.trim().split("\n");
  expect(strays).toEqual([join(chief.home, "chief.db")]);

  const db = join(chief.home, "chief.db");
  const tables = sqlite(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").split("\n");
  expect(tables).toEqual([
    "agent__mcp_reads", "agent__mcp_servers", "assistant__messages", "assistant__threads", "collection__collections", "draft__entries",
    "run__events", "run__gates", "run__messages", "run__node_runs", "run__runs", "run__side_effects",
    "system__migrations", "system__settings",
    "workflow__definitions", "workflow__schedules", "workflow__script_approvals",
  ]);
  for (const t of tables) expect(SCHEMAS, t).toContain(t.split("__")[0]);
  // Indexes follow the same naming.
  const indexes = sqlite(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").split("\n");
  for (const i of indexes) expect(SCHEMAS, i).toContain(i.split("__")[0]);

  const doc = chief.run(["doctor", "--json"]).json();
  expect(Object.keys(doc.db.schemas).sort()).toEqual(SCHEMAS);
  expect(doc.db.schemas.run.map((t: any) => t.table)).toEqual(["events", "gates", "messages", "node_runs", "runs", "side_effects"]);
  expect(doc.db.schemas.workflow).toEqual([{ table: "definitions", rows: 1 }, { table: "schedules", rows: 1 }, { table: "script_approvals", rows: 1 }]);
  // A collection is a schema of its own (15.122): it outlives the draft that produced it and is not part of a run.
  expect(doc.db.schemas.collection).toEqual([{ table: "collections", rows: 0 }]);
  expect(doc.db.schemas.run.find((t: any) => t.table === "runs").rows).toBe(1);
  expect(chief.run(["doctor"]).stdout).toMatch(/schemas\s+agent \(2\), assistant \(2\), collection \(1\), draft \(1\), run \(6\), system \(2\), workflow \(3\)/);

  // The store is the only code that imports SQLite, and it names every table with its schema. The rule is
  // about importing, not about the words in a comment: `node-warnings.ts` mentions the module to filter
  // Node's experimental warning about it, and `cli.ts` explains why (task 15.19).
  const inside = (dir: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...inside(p));
      else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
    }
    return out;
  };
  const src = [...inside(join(ROOT_DIR, "packages/chief/src")), ...inside(join(ROOT_DIR, "packages/web/src"))]
    .filter((f) => /\bfrom\s+"node:sqlite"|\brequire\(\s*"node:sqlite"|import\(\s*"node:sqlite"/.test(readFileSync(f, "utf8")));
  expect(src).toEqual([join(ROOT_DIR, "packages/chief/src/store/store.ts")]);
});

test("E9.6-4 a database from before the schemas is migrated in place with its data", ({ chief }) => {
  // Build a database exactly as the first two migrations left it, with some data in it.
  const dir = join(ROOT_DIR, "packages/chief/src/store/migrations");
  const db = join(chief.home, "chief.db");
  const def = JSON.stringify({ name: "old", inputs: {}, nodes: [{ id: "a", type: "agent", prompt: `hello ${fake({ output: { ok: true } })}`, mcp: [] }], edges: [] }).replace(/'/g, "''");
  const t = "2026-11-01T00:00:00.000Z";
  sqlite(db, [
    "CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
    readFileSync(join(dir, "001-init.sql"), "utf8"),
    readFileSync(join(dir, "002-run-messages-no-backlog.sql"), "utf8"),
    `INSERT INTO schema_migrations VALUES (1, '001-init', '${t}'), (2, '002-run-messages-no-backlog', '${t}');`,
    `INSERT INTO workflows (name, version, definition_json, base_dir, created_at, updated_at) VALUES ('old', 4, '${def}', '${chief.dir}', '${t}', '${t}');`,
    `INSERT INTO runs (workflow_id, workflow_version, definition_json, base_dir, status, created_at) VALUES (1, 3, '${def}', '${chief.dir}', 'completed', '${t}');`,
    `INSERT INTO run_messages (run_id, workflow_id, ts, direction, kind, content) VALUES (1, 1, '${t}', 'in', 'prompt', 'an old prompt');`,
    `INSERT INTO settings VALUES ('notify', 'false');`,
  ].join("\n"));

  const doc = chief.run(["doctor", "--json"]);
  expect(doc.code, doc.stdout + doc.stderr).toBe(0);
  expect(doc.json().db).toMatchObject({ migrations: MIGRATIONS.length, latest: LATEST });
  expect(sqlite(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%\\_\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite_%'")).toBe("");

  // The data is where it was, under the new names, and still usable.
  expect(chief.run(["workflow", "list", "--json"]).json()).toMatchObject([{ name: "old", version: 4 }]);
  expect(chief.run(["runs", "list", "--json"]).json()).toMatchObject([{ id: 1, workflow_name: "old", status: "completed" }]);
  expect(chief.run(["runs", "replay", "1", "--json"]).json()).toMatchObject([{ kind: "prompt", content: "an old prompt" }]);
  expect(chief.run(["settings", "get", "notify", "--json"]).json()).toBe(false);
  const again = chief.run(["run", "old", "--json"]);
  expect(again.code, again.stdout + again.stderr).toBe(0);
  expect(again.json().run).toMatchObject({ id: 2, status: "completed", workflow_version: 4 });
  // Relations between the renamed tables still hold.
  expect(sqlite(db, "PRAGMA foreign_key_check")).toBe("");
});

test("E15.125-1 a database left with a stray index still migrates, and the app starts", ({ chief }) => {
  // Reported 2026-11-25, from the maintainer's own terminal: every start died with
  // `index input_set__sets_workflow already exists`, so the app could not open at all. The index had the name the
  // migration was about to create, and `CREATE INDEX` cannot tolerate that (SQLite has no `IF NOT EXISTS` for it).
  //
  // The state is built here exactly as it was found: a database with "collections" in the schema, and an index already
  // called `input_set__sets_workflow`, on the old table.
  const dir = join(ROOT_DIR, "packages/chief/src/store/migrations");
  const db = join(chief.home, "chief.db");
  const t = "2026-11-24T00:00:00.000Z";
  const upTo12 = MIGRATIONS.filter((f) => Number(f.slice(0, 3)) <= 12);
  expect(upTo12).toHaveLength(12);
  sqlite(db, [
    "CREATE TABLE system__migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
    ...upTo12.map((f) => readFileSync(join(dir, f), "utf8")),
    `INSERT INTO system__migrations VALUES ${upTo12.map((f, i) => `(${i + 1}, '${f.replace(/\.sql$/, "")}', '${t}')`).join(", ")};`,
    `INSERT INTO workflow__definitions (name, version, definition_json, created_at, updated_at) VALUES ('kept-flow', 1, '{"name":"kept-flow","inputs":{},"nodes":[{"id":"a","type":"agent","prompt":"hi"}],"edges":[]}', '${t}', '${t}');`,
    `INSERT INTO collection__collections (workflow_id, name, values_json, created_at, updated_at) VALUES (1, 'kept', '{"who":"team"}', '${t}', '${t}');`,
    // The debris: the new name on the old table.
    "DROP INDEX collection__collections_workflow;",
    "CREATE INDEX input_set__sets_workflow ON collection__collections(workflow_id);",
  ].join("\n"));

  // Starting chief migrates it instead of dying in the constructor.
  const doc = chief.run(["doctor", "--json"]);
  expect(doc.code, doc.stdout + doc.stderr).toBe(0);
  expect(doc.json().db).toMatchObject({ migrations: MIGRATIONS.length, latest: LATEST });
  // The one set it held is still there under the new name, and the index sits on the table it names.
  expect(sqlite(db, "SELECT name FROM input_set__sets"), "the set it held survived").toBe("kept");
  expect(sqlite(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%input_set%'")).toBe("input_set__sets");
  expect(sqlite(db, "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'input_set__sets_workflow'")).toBe("input_set__sets");
  expect(sqlite(db, "PRAGMA foreign_key_check")).toBe("");
});

test("E9.6-2 drafts over the API: stored in the draft schema, removable, and safe against late writes", async ({ chief }) => {
  const s = await chief.serve();
  try {
    expect((await s.api("GET", "/api/drafts")).body).toEqual({});
    expect((await s.api("PUT", "/api/drafts/" + encodeURIComponent("gate:7:text"), { value: "first", seq: 10 })).body).toEqual({ stored: true });
    await s.api("PUT", "/api/drafts/" + encodeURIComponent("gate:7:value"), { value: { body: "x" }, seq: 11 });
    await s.api("PUT", "/api/drafts/" + encodeURIComponent("designer:my-flow"), { value: { definition: { name: "my-flow" } }, seq: 12 });
    expect((await s.api("GET", "/api/drafts")).body).toEqual({ "gate:7:text": "first", "gate:7:value": { body: "x" }, "designer:my-flow": { definition: { name: "my-flow" } } });
    expect(Number(spawnSync("/usr/bin/sqlite3", [join(chief.home, "chief.db"), "SELECT COUNT(*) FROM draft__entries WHERE value_json IS NOT NULL"], { encoding: "utf8" }).stdout)).toBe(3);

    // A write that arrives late (older sequence number) does not replace a newer one.
    await s.api("PUT", "/api/drafts/" + encodeURIComponent("gate:7:text"), { value: "newer", seq: 30 });
    expect((await s.api("PUT", "/api/drafts/" + encodeURIComponent("gate:7:text"), { value: "stale", seq: 20 })).body).toEqual({ stored: false });
    expect((await s.api("GET", "/api/drafts")).body["gate:7:text"]).toBe("newer");

    // Removing one, and removing by prefix; a late write cannot bring a removed draft back.
    await s.api("DELETE", "/api/drafts/" + encodeURIComponent("designer:my-flow") + "?seq=40");
    await s.api("PUT", "/api/drafts/" + encodeURIComponent("designer:my-flow"), { value: "late", seq: 35 });
    await s.api("DELETE", "/api/drafts?prefix=" + encodeURIComponent("gate:7:") + "&seq=50");
    expect((await s.api("GET", "/api/drafts")).body).toEqual({});
    expect((await s.api("PUT", "/api/drafts/x", {})).status).toBe(400);
    expect((await s.api("DELETE", "/api/drafts")).status).toBe(400);
  } finally { await s.stop(); }
  // Drafts survive a restart of chief.
  const again = await chief.serve();
  try {
    await again.api("PUT", "/api/drafts/keep", { value: "kept", seq: 1 });
  } finally { await again.stop(); }
  const third = await chief.serve();
  try { expect((await third.api("GET", "/api/drafts")).body).toEqual({ keep: "kept" }); } finally { await third.stop(); }
});

test("E9.9-3 starting a second server on a port that is taken explains what to do", async ({ chief }) => {
  const first = await chief.serve();
  try {
    const second = chief.run(["serve", "--port", String(first.port)]);
    expect(second.code).toBe(1);
    expect(second.stderr.trim()).toBe(`chief: port ${first.port} is already in use by another chief server. Stop that process first (Ctrl+C in its terminal, or find it with: lsof -nP -iTCP:${first.port} -sTCP:LISTEN), or start this one on another port: chief serve --port ${first.port + 1}`);
    expect(second.stderr).not.toContain("    at ");
    // The first server is unaffected.
    expect((await first.api("GET", "/api/meta")).status).toBe(200);
  } finally { await first.stop(); }
});

test("E9.10-3 autosave starts a new version only after the current one was run, and never for a move", async ({ chief }) => {
  const s = await chief.serve();
  const def = (prompt: string, x = 100) => ({ name: "v", nodes: [{ id: "a", type: "agent", prompt, position: { x, y: 50 } }], edges: [] });
  const put = async (d: object, autosave = true) => (await s.api("PUT", "/api/workflows/v", { definition: d, base_dir: chief.dir, autosave })).body.version;
  const run = async () => {
    const id = (await s.api("POST", "/api/runs", { workflow: "v" })).body.run.id;
    await chief.until(async () => (await s.api("GET", `/api/runs/${id}`)).body.run.status === "completed");
    return (await s.api("GET", `/api/runs/${id}`)).body.run.workflow_version;
  };
  try {
    expect(await put(def("one"))).toBe(1);
    // Edits before anything ran stay version 1.
    expect(await put(def("two"))).toBe(1);
    expect(await put(def("three"))).toBe(1);
    expect(await run()).toBe(1);
    // Version 1 has been run: the next change starts version 2, further edits stay there.
    expect(await put(def("four"))).toBe(2);
    expect(await put(def("five"))).toBe(2);
    expect(await run()).toBe(2);
    // Moving a node changes nothing that runs: no new version, even though version 2 was run.
    expect(await put(def("five", 480))).toBe(2);
    expect((await s.api("GET", "/api/workflows/v")).body.definition.nodes[0].position).toEqual({ x: 480, y: 50 });
    expect(await put(def("six", 480))).toBe(3);
    // An explicit import (the CLI, or the API without autosave) is always a new version.
    expect(await put(def("seven", 480), false)).toBe(4);
    // Saving while typing does not create the working directory; a run does.
    const dir = `${chief.dir}/not-yet/here`;
    expect((await s.api("PUT", "/api/workflows/w", { definition: { ...def("x"), name: "w" }, base_dir: dir, autosave: true })).status).toBe(200);
    expect((await import("node:fs")).existsSync(dir)).toBe(false);
    await s.api("POST", "/api/runs", { workflow: "w" });
    expect((await import("node:fs")).existsSync(dir)).toBe(true);
  } finally { await s.stop(); }
});

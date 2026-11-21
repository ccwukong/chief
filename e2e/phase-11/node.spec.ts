import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, fake, ROOT_DIR, test } from "../helpers";

/**
 * Phase 11: the engine runs on Node. These cases pin the runtime's own surface — the store's
 * adapter, the process layer, the HTTP server, the build and the test harness — and the behaviour
 * the rest of the suite relies on it for.
 */

const sqlite = (db: string, sql: string) => {
  const r = spawnSync("/usr/bin/sqlite3", [db, sql], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};

test("E11.1-1 a database from an earlier release opens, reads and writes the same way", ({ chief }) => {
  // A database as the first two migrations left it, with data in it (the same fixture as E9.6-4).
  const dir = join(ROOT_DIR, "packages/chief/src/store/migrations");
  const db = join(chief.home, "chief.db");
  const def = JSON.stringify({ name: "old", inputs: {}, nodes: [{ id: "a", type: "agent", prompt: "hello", mcp: [] }], edges: [] }).replace(/'/g, "''");
  const t = "2026-11-15T00:00:00.000Z";
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
  expect(doc.json().db).toMatchObject({ ok: true, migrations: 5, latest: "005-assistant" });
  // The rows are where they were, and still read back.
  expect(chief.run(["workflow", "list", "--json"]).json()).toMatchObject([{ name: "old", version: 4 }]);
  expect(chief.run(["runs", "list", "--json"]).json()).toMatchObject([{ id: 1, status: "completed" }]);
  expect(chief.run(["runs", "replay", "1", "--json"]).json()).toMatchObject([{ kind: "prompt", content: "an old prompt" }]);
  expect(chief.run(["settings", "get", "notify", "--json"]).json()).toBe(false);
  // A write after the migration lands in the same file and the same tables.
  expect(chief.run(["settings", "set", "notify", "true"]).code).toBe(0);
  expect(sqlite(db, "SELECT value_json FROM system__settings WHERE key = 'notify'")).toBe("true");
  // WAL, and no second database anywhere in the home.
  expect(sqlite(db, "PRAGMA journal_mode")).toBe("wal");
  const strays = spawnSync("find", [chief.home, "-type", "f", "(", "-name", "*.db", "-o", "-name", "*.sqlite*", ")"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  expect(strays).toEqual([db]);
});

test("E11.1-2 the store binds nulls and booleans, commits transactions, and caps a huge message", async ({ chief }) => {
  // A reply far over the 2 MB message cap: stored cut, with the marker in its meta.
  chief.importWorkflow(`
name: big
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ text: "x".repeat(2_100_000) })}' }
`);
  const s = await chief.serve();
  try {
    const run = (await s.api("POST", "/api/runs", { workflow: "big" })).body.run;
    await chief.until(async () => (await s.api("GET", `/api/runs/${run.id}`)).body.run.status !== "running", 30_000);
    const rows = (await s.api("GET", `/api/runs/${run.id}/transcript`)).body as any[];
    const cut = rows.find((m) => m.meta?.truncated);
    expect(cut, "a message was capped").toBeTruthy();
    expect(cut.content.length).toBe(2_000_000);
    expect(cut.meta.original_chars).toBeGreaterThan(2_000_000);
  } finally { await s.stop(); }

  // The transaction paths (claimRun, deleteRuns) and parameters the driver refuses natively.
  const script = `
    const { Store } = await import(${JSON.stringify(join(ROOT_DIR, "packages/chief/src/store/store.ts"))});
    const store = new Store();
    const wf = store.getWorkflow("big");
    const run = store.createRun(wf, {}, null);
    // A missing value binds as NULL, and a boolean as 0/1, instead of throwing.
    store.updateNodeRun(store.createNodeRun({ run_id: run.id, node_id: "a", node_type: "agent" }).id, { status: "completed", error: undefined, state: { flag: true } });
    const claimed = store.claimRun(run.id, process.pid, () => false);
    store.releaseRun(run.id, process.pid);
    store.updateRun(run.id, { status: "cancelled", error: null });
    store.deleteRuns([run.id]);
    console.log(JSON.stringify({ claimed, gone: store.getRun(run.id) === null, wal: store.db ? true : true }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: chief.env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout.trim().split("\n").at(-1)!)).toMatchObject({ claimed: true, gone: true });
});

test("E11.2-1 an agent step, a scripted step and a gate run on the Node process layer", ({ chief }) => {
  chief.file("double.py", "import json,sys\nprint(json.dumps({'n': json.load(sys.stdin)['n'] * 2}))\n");
  chief.importWorkflow(`
name: layer
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { n: 21 } })}' }
  - { id: s, type: script, run: double.py, input: { n: "{{nodes.a.output.n}}" } }
  - { id: g, type: gate, kind: approve, value: "{{nodes.s.output.n}}" }
edges: [a -> s, s -> g]
`);
  const first = chief.run(["run", "layer", "--json"]);
  expect(first.code, first.stdout + first.stderr).toBe(0);
  expect(first.json().run.status).toBe("waiting_gate");
  // The child got the prompt exactly as chief wrote it, through a pipe.
  const call = chief.calls().find((c) => c.prompt.startsWith("A "))!;
  expect(call.prompt).toContain("<fake>");
  const done = chief.run(["gate", "approve", "1", "--json"]);
  expect(done.json().run.status).toBe("completed");
  const detail = done.json();
  expect(detail.node_runs.find((n: any) => n.node_id === "s").output).toEqual({ n: 42 });
});

test("E11.2-2 a missing CLI or interpreter is a failed step with the command named", ({ chief }) => {
  chief.importWorkflow(`
name: missing
nodes:
  - { id: a, type: agent, mcp: [], agent: claude-code, prompt: 'A' }
`);
  const r = chief.run(["run", "missing", "--json"], { env: { CHIEF_CLAUDE_BIN: "/nonexistent/claude" } });
  expect(JSON.parse(r.stdout).run.status).toBe("failed");
  expect(r.stdout + r.stderr).toMatch(/nonexistent\/claude|ENOENT|could not start/);

  // A script with no known interpreter is refused with a message, not an exception.
  chief.file("thing.zzz", "hello");
  chief.importWorkflow("name: nointerp\nnodes:\n  - { id: s, type: script, run: thing.zzz }\n");
  const script = chief.run(["run", "nointerp", "--json"]);
  expect(script.code).toBe(1);
  expect(script.stdout).toContain("no interpreter known");
});

test("E11.2-3 pause interrupts the step's process group, resume continues it, cancel stops it", async ({ chief }) => {
  chief.importWorkflow(`
name: slow
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ sleep_ms: 60_000, output: { ok: true } }, { output: { ok: true } })}' }
`);
  // `chief run` drives the run until it blocks, so it is started in the background.
  const started = chief.start(["run", "slow", "--json"]);
  const first = await chief.until(() => chief.calls().find((c) => c.prompt.startsWith("A ")), 15_000);
  const runId = chief.run(["runs", "list", "--json"]).json()[0].id as number;
  expect(chief.run(["pause", String(runId), "--json"]).json().status).toBe("paused");
  expect((await started.done).json().run.status).toBe("paused");

  // SIGINT to the process group: the fake ends with "sigint" and the process is gone.
  const ended = await chief.until(() => chief.ends().find((e) => e.session === first.session), 20_000);
  expect(ended.how).toBe("sigint");
  expect(spawnSync("/bin/ps", ["-p", String(first.pid)], { encoding: "utf8" }).status).not.toBe(0);

  // Resume continues the same session rather than starting a new one.
  const resumed = chief.run(["resume", String(runId), "--json"]).json();
  expect(resumed.run.status).toBe("completed");
  // The continuation is a different prompt ("You were interrupted…"), so look for the session.
  expect(chief.calls().some((c) => c.resume === first.session)).toBe(true);
});

test("E11.3-1 the REST surface and the SSE stream are served by the Node server", async ({ chief }) => {
  chief.importWorkflow(`
name: served
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ sleep_ms: 300, output: { ok: true } })}' }
`);
  const s = await chief.serve();
  try {
    expect((await s.api("GET", "/api/meta")).body.api).toBeGreaterThanOrEqual(14);
    expect((await s.api("GET", "/api/workflows")).body).toMatchObject([{ name: "served" }]);
    const run = (await s.api("POST", "/api/runs", { workflow: "served" })).body.run;
    // The stream is open before the run finishes and delivers its events, not a 5-minute timeout.
    const res = await fetch(`${s.url}/api/runs/${run.id}/events?after=0`, { headers: { Accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("run_created");
    expect(body).toContain("node_completed");
    expect((await s.api("GET", `/api/runs/${run.id}/transcript`)).body.length).toBeGreaterThan(0);
  } finally { await s.stop(); }
});

test("E11.3-2 a taken port and a missing browser are explained, and the server keeps running", async ({ chief }) => {
  /** Start `chief serve` without `--no-open` and return its URL, from its own output. */
  const startServing = async (env: Record<string, string>) => {
    const { proc } = chief.start(["serve", "--port", "0"], { env });
    let out = "";
    proc.stdout!.on("data", (d) => (out += d));
    proc.stderr!.on("data", (d) => (out += d));
    const url = await chief.until(() => out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "", 15_000);
    return { proc, url, out: () => out, stop: () => new Promise<void>((res) => { proc.once("close", () => res()); proc.kill("SIGTERM"); }) };
  };

  const first = await startServing({});
  try {
    const second = chief.run(["serve", "--port", String(new URL(first.url).port)]);
    expect(second.code).toBe(1);
    expect(second.stderr.trim()).toContain(`chief: port ${new URL(first.url).port} is already in use`);
    expect(second.stderr).not.toContain("    at ");
    expect((await fetch(first.url + "/api/meta")).status).toBe(200);
  } finally { await first.stop(); }

  // A browser that does not exist: said, with the URL to open by hand, and the server keeps serving.
  const missing = await startServing({ CHIEF_BROWSER: "/nonexistent/browser" });
  try {
    await chief.until(() => missing.out().includes("could not open the browser"), 10_000);
    expect(missing.out()).toContain("yourself");
    expect((await fetch(missing.url + "/api/meta")).status).toBe(200);
  } finally { await missing.stop(); }
});

test("E11.4-1 doctor reports the Node version and the same adapters", ({ chief }) => {
  const doc = chief.run(["doctor", "--json"]).json();
  expect(doc.node).toMatch(/^v\d+\./);
  expect(doc.adapters.map((a: any) => a.name)).toEqual(["claude-code", "codex", "cursor", "antigravity", "opencode", "hermes"]);
  expect(doc.adapters.find((a: any) => a.name === "claude-code")).toMatchObject({ found: true, ok: true });
  expect(doc.db).toMatchObject({ ok: true });
  expect(chief.run(["doctor"]).stdout).toContain("claude-code");
});

test("E11.4-2 Codex servers and models still come from its config.toml", ({ chief }) => {
  const home = join(chief.dir, "codex-home");
  chief.file("codex-home/config.toml", `
model = "gpt-5-codex"

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]

[mcp_servers.docs]
url = "https://example.test/mcp"

[profiles.fast]
model = "gpt-5-mini"
`);
  const env = { CHIEF_CODEX_BIN: join(ROOT_DIR, "e2e/fixtures/fake-codex.ts"), CODEX_HOME: home };
  const mcp = chief.run(["mcp", "list", "--json"], { env }).json();
  const names = (Array.isArray(mcp) ? mcp : mcp.servers ?? []).map((s: any) => s.name);
  expect(names).toEqual(expect.arrayContaining(["github", "docs"]));
  const models = chief.run(["models", "--adapter", "codex", "--json"], { env }).json();
  expect(models.models.map((m: any) => m.value)).toEqual(expect.arrayContaining(["gpt-5-codex", "gpt-5-mini"]));
});

test("E11.5-1 the build is one Node bundle with the migrations beside it", () => {
  test.setTimeout(300_000);
  const out = join(ROOT_DIR, "e2e/.tmp/_phase11/chief.mjs");
  const r = spawnSync(process.execPath, ["packages/chief/scripts/build.ts", out], { cwd: ROOT_DIR, encoding: "utf8" });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain("migrations beside it");
  const code = readFileSync(out, "utf8");
  expect(code.startsWith("#!/usr/bin/env node")).toBe(true);
  expect(statSync(out).mode & 0o111).not.toBe(0);
  expect(statSync(out).size).toBeLessThan(10 * 1024 * 1024); // JavaScript, not a 60 MB native binary
  expect(readdirSync(join(ROOT_DIR, "e2e/.tmp/_phase11/migrations"))).toContain("001-init.sql");
  // Both ways of starting it work.
  for (const argv of [[process.execPath, out, "--help"], [out, "--help"]]) {
    const help = spawnSync(argv[0], argv.slice(1), { cwd: ROOT_DIR, encoding: "utf8" });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("Usage: chief");
  }
});

test("E11.5-2 the repository installs and checks itself with npm", () => {
  test.setTimeout(180_000);
  expect(existsSync(join(ROOT_DIR, "package-lock.json")), "a package-lock.json for npm").toBe(true);
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8"));
  expect(pkg.engines?.node).toMatch(/>=\s*22\.18/);
  expect(pkg.workspaces).toEqual(["packages/*"]);
  for (const script of ["chief", "build", "build:web", "typecheck", "lint", "test", "e2e"]) expect(pkg.scripts[script], script).toBeTruthy();
  const tsc = spawnSync("npx", ["tsc", "--noEmit", "-p", "packages/chief"], { cwd: ROOT_DIR, encoding: "utf8" });
  expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0);
});

test("E11.6-1 the harness runs chief on Node, and no stream line is lost to an unflushed exit", async ({ chief }) => {
  chief.importWorkflow(`
name: flush
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ tools: [{ name: "Read", input: { path: "x" }, result: "ok" }], error: "boom" })}' }
`);
  const r = chief.run(["run", "flush", "--json"]);
  const d = JSON.parse(r.stdout);
  expect(d.run.status).toBe("failed");
  // The tool call printed just before the error result reached the record: a `process.exit` that did
  // not flush the pipe would have lost it.
  const rows = chief.run(["runs", "replay", "1", "--json"]).json() as any[];
  // The tool call is recorded with its name in the meta and its input as the content.
  expect(rows.some((m) => m.kind === "tool_use" && m.meta?.name === "Read")).toBe(true);
  // The harness's colour settings do not leak into what chief prints.
  expect(r.stderr).not.toContain("NO_COLOR");
});

test("E11.7-1 the rules and the docs name Node, and the commands they show exist", () => {
  const read = (p: string) => readFileSync(join(ROOT_DIR, p), "utf8");
  const agents = read("AGENTS.md");
  expect(agents).toContain("TypeScript on Node");
  expect(agents).toContain("node:sqlite");
  expect(read("docs/dev-plan.md")).toContain("TypeScript on Node");

  // The commands the README and the test plan show are the ones the repository runs.
  const readme = read("README.md");
  expect(readme).toContain("node dist/chief.mjs");
  expect(readme).toContain("npm run build");
  expect(readme).toContain("npm run e2e");
  const plan = read("docs/e2e-test-plan.md");
  expect(plan).toContain("npx playwright test");
  expect(plan).toContain("npm run e2e");

  // The e2e setup builds the web UI through the repository's own script.
  expect(read("e2e/global-setup.ts")).toContain('execSync("npm run build:web"');

  // The interpreters the docs promise are the ones the engine maps.
  const runners = read("packages/chief/src/engine/runners.ts");
  for (const ext of [".py", ".sh", ".ts", ".js", ".mjs", ".cjs"]) expect(runners, ext).toContain(`"${ext}"`);
  expect(runners).toContain('".ts": ["node"]');
});

/**
 * Task 15.37: `chief` as a command.
 *
 * There was no `bin` in the root manifest, so `npm install` put nothing on the PATH — and the README
 * used `chief` fifteen times anyway, with a parenthetical "put a small wrapper on your PATH" that never
 * said how. A person following it got `command not found`, which is what was reported on 2026-11-21
 * (*"the chief commandline doesn't work at all"*). `npm run install:cli` is that wrapper, and it is
 * checked here against the real bundle.
 */
test("E15.37-1 npm run install:cli puts a working chief on the PATH, and refuses to clobber a stranger's", () => {
  test.setTimeout(300_000);
  const dir = join(ROOT_DIR, "e2e/.tmp/_phase11/bin");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    // It installs a wrapper that runs the built bundle — and says when the directory is not on PATH,
    // which is the next way this looks broken after the first one is fixed.
    const r = spawnSync(process.execPath, ["scripts/install-cli.mjs", "--dir", dir], { cwd: ROOT_DIR, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const wrapper = join(dir, "chief");
    expect(existsSync(wrapper)).toBe(true);
    expect(statSync(wrapper).mode & 0o111, "the wrapper is executable").not.toBe(0);
    expect(readFileSync(wrapper, "utf8")).toContain("installed by `npm run install:cli`");
    // It runs, from a directory that is not the checkout: this is the whole point of installing it.
    const help = spawnSync(wrapper, ["--help"], { cwd: tmpdir(), encoding: "utf8" });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("Usage: chief");

    // A `chief` this script did not write is left alone rather than replaced.
    const foreign = join(ROOT_DIR, "e2e/.tmp/_phase11/foreign");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "chief"), "#!/bin/sh\necho not chief\n");
    const clash = spawnSync(process.execPath, ["scripts/install-cli.mjs", "--dir", foreign], { cwd: ROOT_DIR, encoding: "utf8" });
    expect(clash.status).not.toBe(0);
    expect(clash.stderr).toContain("leaving it alone");
    expect(readFileSync(join(foreign, "chief"), "utf8")).toContain("not chief");
  } finally {
    rmSync(join(ROOT_DIR, "e2e/.tmp/_phase11/bin"), { recursive: true, force: true });
    rmSync(join(ROOT_DIR, "e2e/.tmp/_phase11/foreign"), { recursive: true, force: true });
  }
});

test("E15.37-2 the README documents the command, and does not present a bare `chief` as if it were installed", () => {
  const readme = readFileSync(join(ROOT_DIR, "README.md"), "utf8");
  // The install step exists, in Quick start, next to `npm install`.
  expect(readme).toContain("npm run install:cli");
  const quickStart = readme.slice(readme.indexOf("## Quick start"), readme.indexOf("## The desktop app"));
  expect(quickStart, "the install step is in Quick start").toContain("npm run install:cli");
  // `npm run chief <command>` is named as the way to run it from a checkout, so the bare examples later
  // are not a trap: a reader who has not installed it has a command that works.
  expect(readme).toContain("npm run chief <command>");
  // The old sentence told people to write their own wrapper and never said how.
  expect(readme).not.toMatch(/put a small wrapper on your/);
  // And the package really has the script it advertises.
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8"));
  expect(pkg.scripts["install:cli"]).toBe("node scripts/install-cli.mjs");
});

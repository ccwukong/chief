import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, ROOT_DIR, test } from "../helpers";

/** What paths.ts decides, asked of a separate Node process with the given environment (nothing else of chief is loaded). */
const paths = (env: Record<string, string | undefined>) => {
  const e = { ...process.env, ...env } as Record<string, string>;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const p = await import(${JSON.stringify(join(ROOT_DIR, "packages/chief/src/paths.ts"))}); console.log(JSON.stringify({ home: p.chiefHome(), db: p.dbPath(), workspace: p.defaultWorkspace() }))`], { env: e, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim());
};

test("E9.32-1 chief keeps its state in ~/.chief, never in the checkout", async ({ chief }) => {
  // With no CHIEF_HOME: the home and the workspace are under ~/.chief, wherever chief runs from.
  // (Only the path rules are asked: chief itself is not started here, so no real database is opened.)
  const fakeHome = join(dirname(chief.home), "user-home");
  mkdirSync(fakeHome, { recursive: true });
  const src = paths({ CHIEF_HOME: undefined, HOME: fakeHome });
  expect(src.home).toBe(join(fakeHome, ".chief", "state"));
  expect(src.db).toBe(join(fakeHome, ".chief", "state", "chief.db"));
  expect(src.workspace).toBe(join(fakeHome, ".chief", "workspace"));
  // Nothing is created inside the checkout, whichever directory chief was started from.
  expect(existsSync(join(ROOT_DIR, ".chief"))).toBe(false);

  // With CHIEF_HOME: that is the home, and the workspace is next to it.
  const own = paths({ CHIEF_HOME: chief.home, HOME: fakeHome });
  expect(own.home).toBe(chief.home);
  expect(own.workspace).toBe(join(dirname(chief.home), "workspace"));

  // chief itself agrees: the doctor and the server report the same places.
  const doc = chief.run(["doctor", "--json"]).json();
  expect(doc.home).toBe(chief.home);
  expect(doc.db.path).toBe(join(chief.home, "chief.db"));
  const s = await chief.serve();
  try {
    const meta = (await s.api("GET", "/api/meta")).body;
    expect(meta.default_workspace_dir).toBe(join(dirname(chief.home), "workspace"));
    expect(meta.workspace_dir).toBe(meta.default_workspace_dir);
  } finally { await s.stop(); }
});

test("E9.33-1 the built bundle keeps its state in ~/.chief and writes nothing into the checkout", async ({ chief }) => {
  test.setTimeout(180_000);
  const base = dirname(chief.home);
  const checkout = join(base, "checkout"), fakeHome = join(base, "user-home"), exe = join(base, "bin", "chief.mjs");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  // Built from this repository, then run from a folder that is not a checkout at all.
  const build = spawnSync(process.execPath, ["packages/chief/scripts/build.ts", exe], { cwd: ROOT_DIR, encoding: "utf8", timeout: 170_000 });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  expect(build.stdout).toContain("state in ~/.chief");

  // Run from anywhere, with no CHIEF_HOME: the state is in that user's ~/.chief, and the checkout is untouched.
  const env = { ...chief.env, HOME: fakeHome } as Record<string, string>;
  delete env.CHIEF_HOME;
  const doc = spawnSync(process.execPath, [exe, "doctor", "--json"], { cwd: checkout, env, encoding: "utf8", timeout: 60_000 });
  expect(doc.status === 0 || doc.status === 1, doc.stderr).toBe(true);
  const report = JSON.parse(doc.stdout);
  expect(report.home).toBe(join(fakeHome, ".chief", "state"));
  expect(report.db.path).toBe(join(fakeHome, ".chief", "state", "chief.db"));
  expect(existsSync(join(fakeHome, ".chief", "state", "chief.db"))).toBe(true);
  expect(existsSync(join(checkout, ".chief"))).toBe(false);

  // A copy of the code with no checkout around it still has a home: nothing has to tell it who it belongs to.
  const loose = join(base, "loose", "a", "b");
  mkdirSync(loose, { recursive: true });
  copyFileSync(join(ROOT_DIR, "packages/chief/src/paths.ts"), join(loose, "paths.ts"));
  const otherHome = join(base, "second-user");
  mkdirSync(otherHome, { recursive: true });
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const p = await import(${JSON.stringify(join(loose, "paths.ts"))}); console.log(p.chiefHome());`], { env: { ...env, HOME: otherHome }, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout.trim()).toBe(join(otherHome, ".chief", "state"));
  expect(existsSync(join(otherHome, ".chief", "state", "chief.db"))).toBe(false); // a home is made, a database is not
});

test("E9.39-1 a run owned by the process that is starting is recovered, not left running", async ({ chief }) => {
  chief.importWorkflow(`name: reload\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'A ${JSON.stringify("x").slice(1, -1)}' }\n`);
  // Two runs left `running` with a running step: one owned by the process that calls recover()
  // (as when the dev server (`node --watch`) reloads the server in place), one owned by another
  // live process.
  const script = `
    const { Store } = await import(${JSON.stringify(join(ROOT_DIR, "packages/chief/src/store/store.ts"))});
    const { recover } = await import(${JSON.stringify(join(ROOT_DIR, "packages/chief/src/engine/engine.ts"))});
    const store = new Store();
    const wf = store.getWorkflow("reload");
    const mk = (owner) => {
      const run = store.createRun(wf, {}, null);
      store.updateRun(run.id, { status: "running", owner_pid: owner, started_at: new Date().toISOString() });
      const nr = store.createNodeRun({ run_id: run.id, node_id: "a", node_type: "agent" });
      store.updateNodeRun(nr.id, { status: "running" });
      return run.id;
    };
    const mine = mk(process.pid), theirs = mk(process.ppid);
    const recovered = recover(store);
    console.log(JSON.stringify({ mine, theirs, recovered, statuses: [store.getRun(mine).status, store.getRun(theirs).status], step: store.nodeRuns(mine)[0].status, events: store.events(mine).map((e) => e.type) }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: chief.env, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
  expect(out.recovered).toEqual([out.mine]);
  expect(out.statuses).toEqual(["interrupted", "running"]);
  expect(out.step).toBe("interrupted");
  expect(out.events).toContain("run_interrupted");

  // It can be resumed and completes. (The other run's owner, this test's own process tree, is ended first.)
  const resumed = chief.run(["resume", String(out.mine)]);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  expect(chief.run(["runs", "show", String(out.mine), "--json"]).json().run.status).toBe("completed");
});

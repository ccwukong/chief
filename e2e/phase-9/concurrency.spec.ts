import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, fake, ROOT_DIR, test } from "../helpers";

/** What the doc says about several runs at once, and what the code actually does. */

const read = (p: string) => readFileSync(join(ROOT_DIR, p), "utf8");
const src = (p: string) => read(join("packages/chief/src", p));

test("E9.68-1 several runs at once: the plan says what runs in parallel, and the code does it", async ({ chief }) => {
  // ── the doc: §3 has the section, and it names the call sites that make it true ──────────────
  const plan = read("docs/dev-plan.md");
  const section = plan.split("### Several runs at once")[1]?.split("\n### ")[0] ?? "";
  expect(section.length, "§3 has a section on several runs at once").toBeGreaterThan(500);
  const plain = section.replace(/[*`]/g, "");
  // One process drives the runs as loops; nothing caps how many; only a map fans out; a step is a
  // CLI child; a gate ends the loop; ownership keeps two processes off one run.
  for (const claim of [
    "one Node process",
    "interleaved",
    "topological order",
    "max-parallel",
    "spawns a fresh CLI process",
    "waiting_gate",
    "owner_pid",
    "No global cap",
  ]) expect(plain, claim).toContain(claim);
  for (const f of ["server/app.ts", "server/scheduler.ts", "engine/engine.ts", "util/proc.ts"]) {
    expect(section, f).toContain(f);
    expect(existsSync(join(ROOT_DIR, "packages/chief/src", f)), f).toBe(true);
  }
  // §5 points at it, so the execution semantics do not repeat a different story.
  expect(plan).toMatch(/- \*\*Several runs at once\*\*: one process drives them all/);

  // The call sites the doc names, in the shape it describes.
  const app = src("server/app.ts");
  expect(app).toMatch(/const p = driveRun\(store, runId, o\)/); // launched, not awaited
  expect(app).toMatch(/active\.set\(runId, p\)/);
  const engine = src("engine/engine.ts");
  expect(engine).toMatch(/claimRun\(runId, process\.pid/); // one process owns a run
  expect(engine).toMatch(/await pass\(ctx\)/); // a run's steps, one at a time
  expect(engine).toMatch(/for \(const id of topoOrder\(ctx\.def\)\)/);
  const runners = src("engine/runners.ts");
  expect(runners).toMatch(/Math\.min\(node\["max-parallel"\], items\.length\)/); // only a map fans out
  const proc = src("util/proc.ts");
  expect(proc).toMatch(/detached: true/); // a child per step, in its own process group
  expect(proc).toMatch(/process\.kill\(-pid, signal\)/); // pause / cancel signalled to the group
  const store = src("store/store.ts");
  expect(store).toMatch(/PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000/);

  // ── the behaviour: two runs are in flight at the same time ──────────────────────────────────
  chief.importWorkflow(`
name: slow
nodes:
  - { id: only, type: agent, prompt: 'SLOW ${fake({ sleep_ms: 15000, output: { ok: true } })}' }
`);
  const s = await chief.serve();
  try {
    // Both runs are created at once, as two clicks on Run would.
    const [a, b] = await Promise.all([
      s.api("POST", "/api/runs", { workflow: "slow" }),
      s.api("POST", "/api/runs", { workflow: "slow" }),
    ]).then(([x, y]) => [x.body, y.body]);
    // Each POST creates the run and returns at once, without waiting for the run to finish.
    for (const r of [a, b]) expect(["pending", "running"]).toContain(r.run.status);
    // Both have a step running before either step has finished: the second run is not queued
    // behind the first.
    const running = await chief.until(async () => {
      const [ra, rb] = await Promise.all([s.api("GET", `/api/runs/${a.run.id}`), s.api("GET", `/api/runs/${b.run.id}`)]);
      const live = (r: any) => r.body.node_runs.some((n: any) => n.status === "running");
      return live(ra) && live(rb);
    }, 4000);
    expect(running).toBe(true);

    // The two CLI processes are alive together, and they are different processes.
    const started = await chief.until(() => {
      const c = chief.calls().filter((x) => x.prompt.includes("SLOW"));
      return c.length === 2 ? c : null;
    }, 4000);
    expect(started[0].pid).not.toBe(started[1].pid);
    expect(chief.ends()).toEqual([]); // neither has finished while both are running
  } finally { await s.stop(); }
});

test("E9.68-2 a run's own steps do not overlap, even when nothing orders them", async ({ chief }) => {
  // Two agent steps with no edge between them: both are ready, and the doc says one at a time.
  chief.importWorkflow(`
name: pair
nodes:
  - { id: a, type: agent, prompt: 'A ${fake({ sleep_ms: 300, output: { n: 1 } })}' }
  - { id: b, type: agent, prompt: 'B ${fake({ sleep_ms: 300, output: { n: 2 } })}' }
`);
  expect(chief.run(["run", "pair", "--json"]).json().run.status).toBe("completed");

  const calls = chief.calls().filter((c) => /^([AB]) /.test(c.prompt));
  expect(calls.map((c) => c.prompt[0]).sort()).toEqual(["A", "B"]);
  const endOf = new Map(chief.ends().map((e) => [e.session, e.ts]));
  const spans = calls.map((c) => ({ from: c.ts, to: endOf.get(c.session)! })).sort((x, y) => x.from - y.from);
  // A second step's process starts only after the first one has exited.
  expect(spans[0].to).toBeLessThanOrEqual(spans[1].from);
});

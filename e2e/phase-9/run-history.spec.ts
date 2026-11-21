import { expect, fake, test, type Server } from "../helpers";

const until = async <T>(fn: () => Promise<T | false | null | undefined>, ms = 20_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};
const status = (s: Server, id: number, want: string) => until(async () => (await s.api("GET", `/api/runs/${id}`)).body.run?.status === want);
/** Start a run over the API and wait until it reaches `want`. */
const startRun = async (s: Server, workflow: string, want: string) => {
  const id = (await s.api("POST", "/api/runs", { workflow })).body.run.id as number;
  await status(s, id, want);
  return id;
};
/** Rows per table of the `run` schema, from the doctor. */
const runRows = async (s: Server) => Object.fromEntries((await s.api("GET", "/api/doctor")).body.db.schemas.run.map((t: any) => [t.table, t.rows])) as Record<string, number>;
const list = async (s: Server, query = "") => {
  const res = await fetch(`${s.url}/api/runs${query}`);
  return { ids: ((await res.json()) as any[]).map((r) => r.id), total: Number(res.headers.get("X-Total-Count")) };
};

const DONE = `name: done\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'Write ${fake({ output: { side_effects: [{ kind: "doc", ref: "d1" }] } })}' }\n`;
const GATED = "name: gated\nnodes:\n  - { id: g, type: gate, kind: approve, value: ship it }\n";

test("E9.25-1 finished runs are deleted with their whole record; active runs are refused", async ({ chief }) => {
  chief.importWorkflow(DONE);
  chief.importWorkflow(GATED);
  const s = await chief.serve();
  try {
    const done = [await startRun(s, "done", "completed"), await startRun(s, "done", "completed"), await startRun(s, "done", "completed")];
    const gated = await startRun(s, "gated", "waiting_gate");
    expect((await s.api("GET", `/api/runs/${done[0]}`)).body.side_effects).toHaveLength(1);

    const before = await runRows(s);
    expect(before.runs).toBe(4);
    for (const t of ["node_runs", "messages", "events", "side_effects"]) expect(before[t], t).toBeGreaterThan(0);

    // One run: it and everything recorded for it goes; the others stay.
    expect((await s.api("DELETE", `/api/runs/${done[0]}`)).body).toEqual({ deleted: [done[0]] });
    expect((await s.api("GET", `/api/runs/${done[0]}`)).status).toBe(404);
    expect((await s.api("GET", `/api/runs/${done[0]}/transcript`)).status).toBe(404);
    const afterOne = await runRows(s);
    expect(afterOne.runs).toBe(3);

    // A batch with an active run deletes nothing.
    const refused = await s.api("POST", "/api/runs/delete", { ids: [done[1], gated] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/cancel it before deleting it/);
    expect((await s.api("GET", `/api/runs/${done[1]}`)).status).toBe(200);
    expect(await runRows(s)).toEqual(afterOne);

    // Several at once.
    expect((await s.api("POST", "/api/runs/delete", { ids: [done[1], done[2]] })).body).toEqual({ deleted: [done[1], done[2]] });
    const afterAll = await runRows(s);
    expect(afterAll.runs).toBe(1);
    // Every completed run of the same workflow recorded the same rows, and each delete removed exactly one run's worth.
    for (const t of ["node_runs", "messages", "events", "side_effects", "gates"]) expect(afterOne[t] - afterAll[t], t).toBe(2 * (before[t] - afterOne[t]));
    expect(afterAll.side_effects).toBe(0);
    // What is left is the gated run, untouched.
    expect(afterAll.gates).toBeGreaterThan(0);
    expect((await s.api("GET", `/api/runs/${gated}`)).body.run.status).toBe("waiting_gate");

    // Unknown runs and bad input.
    expect((await s.api("DELETE", "/api/runs/999")).status).toBe(404);
    expect((await s.api("POST", "/api/runs/delete", { ids: [] })).status).toBe(400);
    expect((await s.api("POST", "/api/runs/delete", { ids: ["x"] })).status).toBe(400);

    // The CLI deletes the same way and refuses an active run.
    const cliRefused = chief.run(["runs", "rm", String(gated)]);
    expect(cliRefused.code).not.toBe(0);
    expect(cliRefused.stderr + cliRefused.stdout).toMatch(/cancel it before deleting it/);
    await s.api("POST", `/api/runs/${gated}/cancel`);
    await status(s, gated, "cancelled");
    const cli = chief.run(["runs", "rm", String(gated)]);
    expect(cli.code, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout).toMatch(new RegExp(`deleted run ${gated} and everything recorded for it`));
    expect(await runRows(s)).toMatchObject({ runs: 0, node_runs: 0, gates: 0, messages: 0, events: 0, side_effects: 0 });
  } finally { await s.stop(); }
});

test("E9.26-1 the run list is paged by the server, with the total in a header", async ({ chief }) => {
  chief.importWorkflow(DONE);
  chief.importWorkflow(`name: other\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'Go ${fake({ output: { ok: 1 } })}' }\n`);
  const s = await chief.serve();
  try {
    // 30 runs: every third one of "other".
    for (let i = 1; i <= 30; i++) await s.api("POST", "/api/runs", { workflow: i % 3 === 0 ? "other" : "done" });
    await until(async () => (await s.api("GET", "/api/runs?limit=100")).body.every((r: any) => r.status === "completed"));

    expect(await list(s, "?limit=10")).toEqual({ ids: [30, 29, 28, 27, 26, 25, 24, 23, 22, 21], total: 30 });
    expect(await list(s, "?limit=10&offset=25")).toEqual({ ids: [5, 4, 3, 2, 1], total: 30 });
    expect(await list(s, "?limit=10&offset=40")).toEqual({ ids: [], total: 30 });
    expect(await list(s, "?workflow=other&limit=4&offset=4")).toEqual({ ids: [18, 15, 12, 9], total: 10 });
  } finally { await s.stop(); }
});

test("E9.26-3 chief runs list pages with --limit and --offset and gives the total", async ({ chief }) => {
  chief.importWorkflow(DONE);
  const s = await chief.serve();
  try {
    for (let i = 0; i < 30; i++) await s.api("POST", "/api/runs", { workflow: "done" });
    await until(async () => (await s.api("GET", "/api/runs?limit=100")).body.every((r: any) => r.status === "completed"));
  } finally { await s.stop(); }

  const r = chief.run(["runs", "list", "--limit", "10", "--offset", "10"]);
  expect(r.code, r.stderr).toBe(0);
  const ids = [...r.stdout.matchAll(/^\s*(\d+)\s+done\b/gm)].map((m) => Number(m[1]));
  expect(ids).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
  expect(r.stdout).toContain("Runs 11–20 of 30. Next: --offset 20");
  expect(chief.run(["runs", "list", "--offset", "50"]).stdout).toContain("No runs here: there are 30 in all.");
  expect(chief.run(["runs", "list", "--limit", "5", "--offset", "5", "--json"]).json().map((x: any) => x.id)).toEqual([25, 24, 23, 22, 21]);
});

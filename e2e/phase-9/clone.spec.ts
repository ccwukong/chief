import { dirname, join } from "node:path";
import { expect, fake, test } from "../helpers";

/** A workflow with an agent step, a gate and a script that widens the sandbox (needs approval). */
const original = (name: string) => `
name: ${name}
description: The original.
budget: { warn-usd: 1, max-usd: 2 }
inputs: { hours: 8 }
nodes:
  - { id: plan, type: agent, mcp: [], prompt: 'PLAN ${fake({ output: { ok: 1 } })}', position: { x: 10, y: 20 } }
  - { id: check, type: gate, kind: approve, value: go, position: { x: 10, y: 140 } }
  - { id: fetch, type: script, run: fetch.py, sandbox: { network: true }, compensate: { prompt: undo }, position: { x: 10, y: 260 } }
edges: [plan -> check, check -> fetch]
`;

test("E9.41-1 a workflow is cloned as a new workflow of its own, without its history", async ({ chief }) => {
  chief.file("fetch.py", "import json,sys\nprint(json.dumps({'ok': True}))\n");
  // Imported from a file: its folder is the file's folder, which the author chose.
  const imported = chief.importWorkflow(original("base"), ["--approve-sandbox"]);
  expect(imported.code, imported.stdout + imported.stderr).toBe(0);
  chief.run(["schedule", "add", "base", "0 9 * * 1"]);
  const s = await chief.serve();
  try {
    await s.api("POST", "/api/runs", { workflow: "base" });
    const before = (await s.api("GET", "/api/workflows/base")).body;
    expect(before.approvals.every((a: any) => a.approved)).toBe(true);

    // No name: <name>-copy, then <name>-copy-2.
    const first = await s.api("POST", "/api/workflows/base/clone", {});
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ name: "base-copy", version: 1, from: "base", base_dir: chief.dir });
    expect((await s.api("POST", "/api/workflows/base/clone")).body.name).toBe("base-copy-2");
    const named = await s.api("POST", "/api/workflows/base/clone", { name: "base-variant" });
    expect(named.body).toMatchObject({ name: "base-variant", version: 1 });

    // The same steps, layout, arrows, inputs and budget; only the name differs.
    const copy = (await s.api("GET", "/api/workflows/base-copy")).body;
    expect({ ...copy.definition, name: "base" }).toEqual(before.definition);
    expect(copy.definition.nodes.map((n: any) => n.position)).toEqual([{ x: 10, y: 20 }, { x: 10, y: 140 }, { x: 10, y: 260 }]);

    // Not its history: no runs, no schedules, and the widened script waits for approval again.
    expect((await s.api("GET", "/api/runs?workflow=base-copy")).body).toEqual([]);
    expect((await s.api("GET", "/api/runs?workflow=base")).body).toHaveLength(1);
    const schedules = (await s.api("GET", "/api/schedules")).body;
    expect(schedules.map((x: any) => x.workflow_name)).toEqual(["base"]);
    expect(copy.approvals).toEqual([expect.objectContaining({ node_id: "fetch", approved: false })]);
    expect(first.body.approvals.some((a: any) => !a.approved)).toBe(true);

    // The original is unchanged.
    const after = (await s.api("GET", "/api/workflows/base")).body;
    expect(after.version).toBe(before.version);
    expect(after.definition).toEqual(before.definition);
    expect(after.approvals.every((a: any) => a.approved)).toBe(true);

    // A workflow in its default folder gives the copy its own default folder.
    const workspace = join(dirname(chief.home), "workspace");
    await s.api("PUT", "/api/workflows/home-made", { definition: { name: "home-made", nodes: [{ id: "a", type: "agent", mcp: [], prompt: "hi" }], edges: [] } });
    expect((await s.api("GET", "/api/workflows/home-made")).body.base_dir).toBe(join(workspace, "home-made"));
    expect((await s.api("POST", "/api/workflows/home-made/clone", {})).body.base_dir).toBe(join(workspace, "home-made-copy"));

    // Refused: an invalid name, a taken name, an unknown workflow.
    const bad = await s.api("POST", "/api/workflows/base/clone", { name: "Bad Name" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("lower-case letters, digits and dashes");
    const taken = await s.api("POST", "/api/workflows/base/clone", { name: "base-variant" });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toContain('a workflow named "base-variant" already exists');
    expect((await s.api("POST", "/api/workflows/nope/clone", {})).status).toBe(404);
  } finally { await s.stop(); }
});

test("E9.41-2 chief workflow clone copies a workflow from the command line", ({ chief }) => {
  chief.file("fetch.py", "import json,sys\nprint(json.dumps({'ok': True}))\n");
  chief.importWorkflow(original("base"), ["--approve-sandbox"]);
  const plain = chief.run(["workflow", "clone", "base"]);
  expect(plain.code, plain.stderr).toBe(0);
  expect(plain.stdout).toContain(`cloned base as base-copy (v1), working directory ${chief.dir}`);
  expect(plain.stdout).toContain("scripts that widen the sandbox need approving again: chief workflow approve base-copy");
  const json = chief.run(["workflow", "clone", "base", "base-weekly", "--json"]);
  expect(json.code, json.stderr).toBe(0);
  expect(json.json()).toMatchObject({ name: "base-weekly", version: 1, from: "base" });
  expect(chief.run(["workflow", "list", "--json"]).json().map((w: any) => w.name).sort()).toEqual(["base", "base-copy", "base-weekly"]);
  const taken = chief.run(["workflow", "clone", "base", "base-weekly"]);
  expect(taken.code).not.toBe(0);
  expect(taken.stderr + taken.stdout).toContain("already exists");
});

const CONTEXT_ERROR = "Prompt is too long: 251000 tokens > 200000 maximum context length";
/** A run whose `big` step fails twice with a context-window error (the first try and chief's own retry), then works. */
const bigFlow = () => `
name: big
nodes:
  - { id: plan, type: agent, mcp: [], prompt: 'PLAN ${fake({ output: { ok: 1 } })}' }
  - { id: big, type: agent, mcp: [], model: sonnet, prompt: 'BIG ${fake({ by_start: [{ error: CONTEXT_ERROR }, { error: CONTEXT_ERROR }, { output: { done: true } }] })}' }
  - { id: ok, type: gate, kind: approve, value: go }
edges: [plan -> big, big -> ok]
`;
const callsOf = (chief: any, word: string) => chief.calls().filter((c: any) => c.prompt.startsWith(word));
const flag = (argv: string[], f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

test("E9.42-1 a failed step's model can be changed for the run, then only that step runs again", async ({ chief }) => {
  chief.importWorkflow(bigFlow());
  const s = await chief.serve();
  const wait = async (id: number, status: string) => { for (let i = 0; i < 200; i++) { const d = (await s.api("GET", `/api/runs/${id}`)).body; if (d.run.status === status) return d; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`run ${id} never became ${status}`); };
  try {
    const run = (await s.api("POST", "/api/runs", { workflow: "big" })).body.run.id;
    let d = await wait(run, "failed");
    expect(d.node_runs.find((n: any) => n.node_id === "big").error).toContain("maximum context length");
    expect(callsOf(chief, "PLAN")).toHaveLength(1);
    expect(callsOf(chief, "BIG").map((c: any) => flag(c.argv, "--model"))).toEqual(["sonnet", "sonnet"]);

    // Refused: a completed step, a gate, an unknown step, an invalid name.
    const done = await s.api("POST", `/api/runs/${run}/steps/plan/model`, { model: "opus" });
    expect(done.status).toBe(409);
    expect(done.body.error).toContain("already completed");
    expect((await s.api("POST", `/api/runs/${run}/steps/ok/model`, { model: "opus" })).status).toBe(400);
    expect((await s.api("POST", `/api/runs/${run}/steps/nope/model`, { model: "opus" })).status).toBe(404);
    expect((await s.api("POST", `/api/runs/${run}/steps/big/model`, { model: "two words" })).status).toBe(400);

    // Changed for this run: recorded, and the workflow itself is unchanged.
    const changed = await s.api("POST", `/api/runs/${run}/steps/big/model`, { model: "opus" });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ from: "sonnet", to: "opus", changed: true });
    expect(changed.body.run.definition.nodes.find((n: any) => n.id === "big").model).toBe("opus");
    expect((await s.api("GET", "/api/workflows/big")).body.definition.nodes.find((n: any) => n.id === "big").model).toBe("sonnet");
    const rec = (await s.api("GET", `/api/runs/${run}/transcript`)).body;
    expect(rec.find((m: any) => m.kind === "run_step_changed")?.meta).toMatchObject({ node_id: "big", field: "model", from: "sonnet", to: "opus" });

    // Resumed: only the failed step runs again, with the new model.
    await s.api("POST", `/api/runs/${run}/resume`);
    d = await wait(run, "waiting_gate");
    expect(callsOf(chief, "PLAN")).toHaveLength(1);
    expect(callsOf(chief, "BIG").map((c: any) => flag(c.argv, "--model"))).toEqual(["sonnet", "sonnet", "opus"]);
    expect(d.node_runs.filter((n: any) => n.node_id === "big").at(-1)).toMatchObject({ status: "completed", output: { done: true } });

    // Not while the run is not stopped: after it has completed, nothing can be changed.
    await s.api("POST", `/api/gates/${d.gates.find((g: any) => g.status === "waiting").id}/answer`, { answer: { decision: "approve" } });
    await wait(run, "completed");
    expect((await s.api("POST", `/api/runs/${run}/steps/big/model`, { model: "haiku" })).status).toBe(409);
  } finally { await s.stop(); }
});

test("E9.42-2 chief runs set-model changes a step's model, then resume finishes the run", ({ chief }) => {
  chief.importWorkflow(bigFlow());
  expect(chief.run(["run", "big"]).code).toBe(1);
  const set = chief.run(["runs", "set-model", "1", "big", "opus"]);
  expect(set.code, set.stderr).toBe(0);
  expect(set.stdout).toContain("run 1: step big now uses opus (was sonnet). Continue with: chief resume 1");
  const back = chief.run(["runs", "set-model", "1", "big", "default", "--json"]);
  expect(back.json()).toMatchObject({ from: "opus", to: null, changed: true });
  chief.run(["runs", "set-model", "1", "big", "opus"]);
  const resumed = chief.run(["resume", "1"]);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  expect(callsOf(chief, "BIG").map((c: any) => flag(c.argv, "--model"))).toEqual(["sonnet", "sonnet", "opus"]);
  expect(chief.run(["runs", "show", "1", "--json"]).json().run.status).toBe("waiting_gate");
});

/** Wait until a run has a status, through the API. */
const waitFor = async (s: any, id: number, status: string) => { for (let i = 0; i < 200; i++) { const d = (await s.api("GET", `/api/runs/${id}`)).body; if (d.run.status === status) return d; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`run ${id} never became ${status}`); };

test("E9.43-1 the prompt of an unfinished step can be changed for the run, before it is resumed", async ({ chief }) => {
  chief.importWorkflow(`
name: edit
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { ok: 1 } })}' }
  - { id: b, type: agent, mcp: [], prompt: 'B-OLD ${fake({ error: "boom" })}' }
  - { id: c, type: agent, mcp: [], prompt: 'C-OLD ${fake({ output: { c: 1 } })}' }
  - { id: g, type: gate, kind: approve, value: go }
edges: [a -> b, b -> c, c -> g]
`);
  const s = await chief.serve();
  try {
    const run = (await s.api("POST", "/api/runs", { workflow: "edit" })).body.run.id;
    await waitFor(s, run, "failed");
    const bNew = `B-NEW ${fake({ output: { b: 2 } })}`, cNew = `C-NEW ${fake({ output: { c: 2 } })}`;

    // Refused: a completed step, an empty prompt, a template that names no step, a gate.
    expect((await s.api("POST", `/api/runs/${run}/steps/a`, { prompt: "again" })).status).toBe(409);
    expect((await s.api("POST", `/api/runs/${run}/steps/b`, { prompt: "  " })).status).toBe(400);
    const bad = await s.api("POST", `/api/runs/${run}/steps/b`, { prompt: "Use {{nodes.nope.output}}" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("would not be valid");
    expect((await s.api("POST", `/api/runs/${run}/steps/g`, { prompt: "x" })).status).toBe(400);

    // The failed step and a step that has not started get new prompts, for this run only.
    expect((await s.api("POST", `/api/runs/${run}/steps/b`, { prompt: bNew })).body).toMatchObject({ changed: true, changes: [{ field: "prompt" }] });
    expect((await s.api("POST", `/api/runs/${run}/steps/c`, { prompt: cNew })).status).toBe(200);
    const wf = (await s.api("GET", "/api/workflows/edit")).body.definition.nodes;
    expect(wf.find((n: any) => n.id === "b").prompt).toContain("B-OLD");
    const rec = (await s.api("GET", `/api/runs/${run}/transcript`)).body.filter((m: any) => m.kind === "run_step_changed").map((m: any) => m.meta);
    expect(rec).toEqual([expect.objectContaining({ node_id: "b", field: "prompt", to: bNew }), expect.objectContaining({ node_id: "c", field: "prompt", to: cNew })]);
    expect(rec[0].from).toContain("B-OLD");

    // Resumed: the new prompts are sent; the old ones are not sent again.
    await s.api("POST", `/api/runs/${run}/resume`);
    await waitFor(s, run, "waiting_gate");
    const sent = chief.calls().map((c) => c.prompt.split(" ")[0]);
    expect(sent).toEqual(["A", "B-OLD", "B-OLD", "B-NEW", "C-NEW"]);
  } finally { await s.stop(); }
});

test("E9.43-4 a paused step starts again with a new prompt in a new session", async ({ chief }) => {
  chief.importWorkflow(`
name: paused
nodes:
  - { id: slow, type: agent, mcp: [], prompt: 'SLOW-OLD ${fake({ sleep_ms: 20000, output: { ok: 1 } })}' }
  - { id: ask, type: agent, mcp: [], prompt: 'ASK ${fake({ needs_input: { question: "Post it?", proposed: "yes" } }, { output: { posted: false } })}' }
edges: [slow -> ask]
`);
  const s = await chief.serve();
  try {
    const run = (await s.api("POST", "/api/runs", { workflow: "paused" })).body.run.id;
    for (let i = 0; i < 100 && !chief.calls().length; i++) await new Promise((r) => setTimeout(r, 100));
    const oldSession = chief.calls()[0].session;
    await s.api("POST", `/api/runs/${run}/pause`);
    let d = await waitFor(s, run, "paused");
    expect(d.node_runs[0]).toMatchObject({ node_id: "slow", status: "interrupted" });

    const r = await s.api("POST", `/api/runs/${run}/steps/slow`, { prompt: `SLOW-NEW ${fake({ output: { ok: 2 } })}` });
    expect(r.body).toMatchObject({ changed: true, restarted: 1 });
    expect(r.body.node_runs.filter((n: any) => n.node_id === "slow").map((n: any) => [n.attempt, n.status])).toEqual([[1, "cancelled"], [2, "pending"]]);

    // Resumed: a new session with the new prompt, not the old session continued.
    await s.api("POST", `/api/runs/${run}/resume`);
    d = await waitFor(s, run, "waiting_gate");
    const again = chief.calls().find((c) => c.prompt.startsWith("SLOW-NEW"))!;
    expect(again.resume).toBeNull();
    expect(again.session).not.toBe(oldSession);
    expect(chief.calls().some((c) => c.resume === oldSession)).toBe(false);

    // The next step stops to ask its own question; its model can be changed (used after the answer). See E9.44-1 for its prompt.
    expect(d.node_runs.find((n: any) => n.node_id === "ask").status).toBe("waiting_gate");
    expect((await s.api("POST", `/api/runs/${run}/steps/ask`, { model: "haiku" })).body).toMatchObject({ changed: true, restarted: 0 });
    expect((await s.api("GET", `/api/runs/${run}`)).body.run.status).toBe("waiting_gate");
  } finally { await s.stop(); }
});

test("E9.43-2 chief runs set-prompt reads the new prompt from a file", ({ chief }) => {
  chief.importWorkflow(`name: cli\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'OLD ${fake({ error: "boom" })}' }\n`);
  expect(chief.run(["run", "cli"]).code).toBe(1);
  const file = chief.file("new-prompt.md", `NEW from a file ${fake({ output: { ok: 1 } })}`);
  const set = chief.run(["runs", "set-prompt", "1", "a", file]);
  expect(set.code, set.stderr).toBe(0);
  expect(set.stdout).toMatch(/run 1: step a has a new prompt \(\d+ characters\)\. Continue with: chief resume 1/);
  const resumed = chief.run(["resume", "1"]);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  expect(chief.calls().at(-1)!.prompt).toContain("NEW from a file");
});

test("E9.44-1 a step waiting for the answer to its own question can be given a new prompt instead", async ({ chief }) => {
  chief.importWorkflow(`
name: stuck
nodes:
  - { id: write, type: agent, mcp: [], prompt: 'WRITE-OLD ${fake({ needs_input: { question: "I cannot read the page. Paste it?", proposed: null } }, { output: { status: "declined" } })}' }
  - { id: after, type: agent, mcp: [], prompt: 'AFTER ${fake({ output: { ok: 1 } })}' }
edges: [write -> after]
`);
  const s = await chief.serve();
  try {
    const run = (await s.api("POST", "/api/runs", { workflow: "stuck" })).body.run.id;
    let d = await waitFor(s, run, "waiting_gate");
    const question = d.gates.find((g: any) => g.status === "waiting");
    expect(question.reason).toBe("needs_input");
    const oldSession = chief.calls()[0].session;

    // A new prompt instead of an answer: the question is withdrawn, the step starts again, and the run waits for Resume.
    const r = await s.api("POST", `/api/runs/${run}/steps/write`, { prompt: `WRITE-NEW ${fake({ output: { status: "done" } })}` });
    expect(r.body).toMatchObject({ changed: true, restarted: 1 });
    expect(r.body.run.status).toBe("paused");
    expect(r.body.gates.find((g: any) => g.id === question.id).status).toBe("cancelled");
    expect(r.body.node_runs.filter((n: any) => n.node_id === "write").map((n: any) => [n.attempt, n.status])).toEqual([[1, "cancelled"], [2, "pending"]]);
    const rec = (await s.api("GET", `/api/runs/${run}/transcript`)).body.map((m: any) => m.kind);
    expect(rec).toEqual(expect.arrayContaining(["run_step_changed", "run_paused"]));

    // Resume: a new session with the new prompt; the old session and its question are not continued.
    await s.api("POST", `/api/runs/${run}/resume`);
    d = await waitFor(s, run, "completed");
    const fresh = chief.calls().find((c) => c.prompt.startsWith("WRITE-NEW"))!;
    expect(fresh.resume).toBeNull();
    expect(chief.calls().some((c) => c.resume === oldSession)).toBe(false);
    expect(d.node_runs.filter((n: any) => n.node_id === "write").at(-1).output).toMatchObject({ status: "done" });
    expect(chief.calls().map((c) => c.prompt.split(" ")[0])).toEqual(["WRITE-OLD", "WRITE-NEW", "AFTER"]);
  } finally { await s.stop(); }
});

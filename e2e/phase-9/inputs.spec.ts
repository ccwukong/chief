import { expect, fake, test } from "../helpers";

/** A workflow that reviews a pull request: the link is given per run, the repo has a default. */
const REVIEW = `
name: review
inputs: { params: { repo: my-org/app } }
nodes:
  - { id: review, type: agent, mcp: [], prompt: 'Review {{inputs.params.prlink}} in {{inputs.params.repo}} ${fake({ output: { ok: true } })}' }
`;

test("E9.48-1 a run gives nested inputs; one the workflow uses but has no value is refused before anything starts", ({ chief }) => {
  chief.importWorkflow(REVIEW);

  // Without the link: refused, with the input's full name and how to give it; the agent CLI was never started.
  const refused = chief.run(["run", "review"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr + refused.stdout).toContain("inputs.params.prlink");
  expect(refused.stderr + refused.stdout).toContain("--input params.prlink=");
  expect(chief.calls()).toHaveLength(0);

  // A dotted --input sets the nested value; the default beside it (repo) is kept.
  const ok = chief.run(["run", "review", "--input", "params.prlink=https://github.com/my-org/app/pull/42", "--json"]);
  expect(ok.code, ok.stdout + ok.stderr).toBe(0);
  expect(ok.json().run.status).toBe("completed");
  expect(ok.json().run.inputs).toEqual({ params: { prlink: "https://github.com/my-org/app/pull/42" } });
  expect(chief.calls()[0].prompt).toContain("Review https://github.com/my-org/app/pull/42 in my-org/app");
  // The run's record starts with the inputs it ran with, merged.
  const replay = chief.run(["runs", "replay", String(ok.json().run.id), "--full"]);
  expect(replay.stdout).toContain('"prlink": "https://github.com/my-org/app/pull/42"');
  expect(replay.stdout).toContain('"repo": "my-org/app"');

  // --inputs-json with the same shape replaces the default too.
  const json = chief.run(["run", "review", "--inputs-json", JSON.stringify({ params: { prlink: "https://x/pull/1", repo: "other/repo" } }), "--json"]);
  expect(json.code, json.stdout + json.stderr).toBe(0);
  expect(chief.calls()[1].prompt).toContain("Review https://x/pull/1 in other/repo");

  // A schedule that lacks the input would be refused at every tick: it is refused now.
  const sched = chief.run(["schedule", "add", "review", "0 9 * * 1"]);
  expect(sched.code).toBe(1);
  expect(sched.stderr + sched.stdout).toContain("inputs.params.prlink");
  const withInput = chief.run(["schedule", "add", "review", "0 9 * * 1", "--inputs-json", '{"params": {"prlink": "https://x/pull/2"}}']);
  expect(withInput.code, withInput.stdout + withInput.stderr).toBe(0);
});

test("E9.48-2 the API lists the inputs a workflow uses, refuses a run without them, and refuses a step change that needs one", async ({ chief }) => {
  chief.importWorkflow(`
name: review
inputs: { params: { repo: my-org/app } }
nodes:
  - { id: fetch, type: agent, mcp: [], prompt: 'Fetch {{inputs.params.prlink}} ${fake({ output: { diff: "x" } })}' }
  - { id: review, type: agent, mcp: [], prompt: 'Review in {{inputs.params.repo}} ${fake({ error: "context window exceeded" })}' }
edges: [fetch -> review]
`);
  const s = await chief.serve();
  try {
    const w = await s.api("GET", "/api/workflows/review");
    expect(w.body.input_refs).toEqual([{ path: "params.prlink", has_default: false }, { path: "params.repo", has_default: true, default: "my-org/app" }]);

    const bad = await s.api("POST", "/api/runs", { workflow: "review" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("inputs.params.prlink");
    expect(chief.calls()).toHaveLength(0);

    const ok = await s.api("POST", "/api/runs", { workflow: "review", inputs: { params: { prlink: "https://x/pull/9" } } });
    expect(ok.status).toBe(201);
    const id = ok.body.run.id;
    await chief.until(async () => (await s.api("GET", `/api/runs/${id}`)).body.run.status === "failed");
    expect(chief.calls()[0].prompt).toContain("Fetch https://x/pull/9");
    const first = (await s.api("GET", `/api/runs/${id}/transcript`)).body[0];
    expect(first.kind).toBe("run_input");
    expect(JSON.parse(first.content)).toEqual({ params: { prlink: "https://x/pull/9", repo: "my-org/app" } });

    // The failed step cannot be given a prompt that needs an input this run does not have.
    const refused = await s.api("POST", `/api/runs/${id}/steps/review`, { prompt: "Review {{inputs.params.ticket}}" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("inputs.params.ticket");
    const fine = await s.api("POST", `/api/runs/${id}/steps/review`, { prompt: `Review {{inputs.params.prlink}} ${fake({ output: { ok: true } })}` });
    expect(fine.status, JSON.stringify(fine.body)).toBe(200);
  } finally { await s.stop(); }
});

test("E9.61-1 a run is run again as a new run with the inputs it ran with, on the workflow as it is now", async ({ chief }) => {
  const wf = (word: string, repo: string) => `
name: review
inputs: { repo: ${repo} }
nodes:
  - { id: review, type: agent, mcp: [], prompt: '${word} {{inputs.prlink}} in {{inputs.repo}} ${fake({ output: { ok: true } })}' }
`;
  chief.importWorkflow(wf("Review", "my-org/app"));
  const first = chief.run(["run", "review", "--input", "prlink=https://x/pull/7", "--max-usd", "3", "--json"]);
  expect(first.code, first.stdout + first.stderr).toBe(0);

  // The workflow is changed afterwards: its prompt, and the default of an input the first run relied on.
  chief.importWorkflow(wf("Review again", "other/repo"));
  const again = chief.run(["runs", "rerun", String(first.json().run.id), "--json"]);
  expect(again.code, again.stdout + again.stderr).toBe(0);
  const d = again.json();
  // A new run; the first one is untouched.
  expect(d.run.id).toBe(first.json().run.id + 1);
  expect(d.run.status).toBe("completed");
  expect(chief.run(["runs", "show", String(first.json().run.id), "--json"]).json().run.status).toBe("completed");
  // The same inputs as the first run ran with (its link, and the repo it had then), the same budget, the workflow's new prompt.
  expect(d.run.inputs).toEqual({ repo: "my-org/app", prlink: "https://x/pull/7" });
  expect(d.run.budget).toEqual({ "max-usd": 3 });
  expect(d.run.workflow_version).toBe(2);
  expect(chief.calls()[1].prompt).toContain("Review again https://x/pull/7 in my-org/app");
  // The record of the new run says what it is.
  expect(chief.run(["runs", "replay", String(d.run.id), "--full"]).stdout).toContain(`Run ${first.json().run.id} run again`);
  // `--from <step>`: start at that step, recording the start point and the run it continues (15.117). One step here, so
  // nothing is kept — what this asserts is that the flag is read (it was silently ignored at first) and refused when it
  // names no step; the skipping itself is E15.117-1's.
  const from = chief.run(["runs", "rerun", String(first.json().run.id), "--from", "review", "--json"]);
  expect(from.code, from.stdout + from.stderr).toBe(0);
  expect(from.json().run.start_from).toBe("review");
  expect(from.json().run.parent_run_id).toBe(first.json().run.id);
  expect(chief.run(["runs", "rerun", String(first.json().run.id), "--from", "nope"]).code).toBe(1);
  // Over the API, and for a run that does not exist.
  expect(chief.run(["runs", "rerun", "999"]).code).toBe(1);
});

test("E9.61-2 the API runs a run again", async ({ chief }) => {
  chief.importWorkflow(`name: once\ninputs: { who: team }\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'hello {{inputs.who}} ${fake({ output: { ok: true } })}' }\n`);
  const s = await chief.serve();
  try {
    const first = await s.api("POST", "/api/runs", { workflow: "once", inputs: { who: "everyone" } });
    await chief.until(async () => (await s.api("GET", `/api/runs/${first.body.run.id}`)).body.run.status === "completed");
    const again = await s.api("POST", `/api/runs/${first.body.run.id}/rerun`);
    expect(again.status).toBe(201);
    expect(again.body.run.id).not.toBe(first.body.run.id);
    expect(again.body.run.inputs).toEqual({ who: "everyone" });
    await chief.until(async () => (await s.api("GET", `/api/runs/${again.body.run.id}`)).body.run.status === "completed");
    expect(chief.calls()[1].prompt).toContain("hello everyone");
    // `from`: the start point is recorded, and a step that is not one is refused rather than guessed at (15.117).
    const from = await s.api("POST", `/api/runs/${first.body.run.id}/rerun`, { from: "a" });
    expect(from.status).toBe(201);
    expect(from.body.run.start_from).toBe("a");
    expect(from.body.run.parent_run_id).toBe(first.body.run.id);
    const bad = await s.api("POST", `/api/runs/${first.body.run.id}/rerun`, { from: "nope" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("is not a step");
    expect((await s.api("POST", "/api/runs/999/rerun")).status).toBe(404);
  } finally { await s.stop(); }
});

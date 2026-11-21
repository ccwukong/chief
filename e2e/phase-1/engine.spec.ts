import { expect, fake, test, type Chief } from "../helpers";

const show = (chief: Chief, id = 1) => chief.run(["runs", "show", String(id), "--json"]).json();
const node = (d: any, id: string, idx: number | null = null) => d.node_runs.filter((n: any) => n.node_id === id && n.item_index === idx && n.phase === "forward").at(-1);
const ITEMS = [
  { title: "Review PR 12", kind: "code-review", priority: "P1", url: "https://example.test/pr/12" },
  { title: "Write ADR", kind: "doc", priority: "P2", url: "https://example.test/adr" },
  { title: "Fix prod alert", kind: "other", priority: "P0", url: "https://example.test/alert" },
];

test("E1.3-1 a diamond DAG runs in dependency order", ({ chief }) => {
  chief.importWorkflow(`
name: diamond
nodes:
  - { id: a, type: agent, prompt: 'A ${fake({ output: { v: "from-a" } })}' }
  - { id: b, type: agent, prompt: 'B sees {{nodes.a.output.v}} ${fake({ output: { v: "from-b" } })}' }
  - { id: c, type: agent, prompt: 'C sees {{nodes.a.output.v}} ${fake({ output: { v: "from-c" } })}' }
  - { id: d, type: agent, prompt: 'D sees {{nodes.b.output.v}} and {{nodes.c.output.v}}' }
edges: [a -> b, a -> c, b -> d, c -> d]
`);
  const r = chief.run(["run", "diamond", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.json().run.status).toBe("completed");
  const prompts = chief.calls().map((c) => c.prompt.slice(0, 1));
  expect(prompts[0]).toBe("A");
  expect(prompts[3]).toBe("D");
  expect(prompts.slice(1, 3).sort()).toEqual(["B", "C"]);
  expect(chief.calls()[3].prompt).toContain("D sees from-b and from-c");
});

test("E1.3-2 a failed node stops everything downstream", ({ chief }) => {
  chief.importWorkflow(`
name: stops
nodes:
  - { id: a, type: agent, prompt: 'A ${fake({ error: true })}' }
  - { id: b, type: agent, prompt: 'B' }
edges: [a -> b]
`);
  const r = chief.run(["run", "stops", "--json"]);
  expect(r.code).toBe(1);
  const d = r.json();
  expect(d.run.status).toBe("failed");
  expect(d.run.error).toContain('node "a"');
  expect(d.node_runs.map((n: any) => n.node_id)).toEqual(["a"]);
  expect(chief.calls().every((c) => c.prompt.startsWith("A"))).toBe(true);
});

test("E1.3-3 the event log records the run in order", ({ chief }) => {
  chief.importWorkflow(`
name: events
nodes:
  - { id: a, type: agent, prompt: A }
  - { id: b, type: agent, prompt: B }
edges: [a -> b]
`);
  chief.run(["run", "events"]);
  const evs = chief.run(["runs", "tail", "1", "--json"]).stdout.trim().split("\n").map((l) => JSON.parse(l));
  const seq = evs.map((e: any) => (e.payload.node_id ? `${e.type}:${e.payload.node_id}` : e.type)).filter((t: string) => /^(run_|node_)/.test(t));
  expect(seq).toEqual(["run_created", "run_started", "node_running:a", "node_completed:a", "node_running:b", "node_completed:b", "run_completed"]);
  expect(evs.map((e: any) => e.id)).toEqual([...evs.map((e: any) => e.id)].sort((x, y) => x - y));
});

test("E1.4-1 an agent node runs through the adapter and stores its output", ({ chief }) => {
  chief.importWorkflow(`
name: agent
nodes:
  - { id: a, type: agent, prompt: 'Summarise please ${fake({ output: { summary: "all quiet", count: 3 } })}' }
`);
  const d = chief.run(["run", "agent", "--json"]).json();
  expect(d.node_runs[0]).toMatchObject({ node_type: "agent", status: "completed", output: { summary: "all quiet", count: 3 } });
  const call = chief.calls()[0];
  expect(call.prompt).toContain("Summarise please");
  expect(call.argv.join(" ")).not.toContain("Summarise please");
  expect(call.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json"]));
});

test("E1.4-2 an unknown adapter is refused before the run starts", ({ chief }) => {
  chief.importWorkflow("name: nope\nagent: gemini-cli\nnodes:\n  - { id: a, type: agent, prompt: hi }\n");
  const r = chief.run(["run", "nope"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('unknown agent adapter "gemini-cli"');
  expect(chief.run(["runs", "list", "--json"]).json()).toHaveLength(0);
});

// ── gates ──────────────────────────────────────────────────────────────────

const SELECT = `
name: pick
nodes:
  - { id: plan, type: agent, prompt: 'plan ${fake({ output: { items: ITEMS } })}' }
  - { id: choose, type: gate, kind: select, from: "{{nodes.plan.output.items}}", message: "Which ones?" }
  - { id: after, type: agent, prompt: 'chosen={{nodes.choose.output.selected}} mode={{nodes.choose.output.mode}}' }
edges: [plan -> choose, choose -> after]
`;

test("E1.6-1 a select gate stops the run and lists its items", ({ chief }) => {
  chief.importWorkflow(SELECT);
  const r = chief.run(["run", "pick", "--json"]);
  expect(r.code).toBe(0);
  expect(r.json().run.status).toBe("waiting_gate");
  const gates = chief.run(["gate", "list", "--json"]).json();
  expect(gates).toHaveLength(1);
  expect(gates[0]).toMatchObject({ id: 1, run_id: 1, node_id: "choose", kind: "select", status: "waiting" });
  expect(gates[0].payload.items.map((i: any) => i.title)).toEqual(ITEMS.map((i) => i.title));
  const text = chief.run(["gate", "show", "1"]).stdout;
  expect(text).toContain("Which ones?");
  expect(text).toContain("[2] P0 Fix prod alert");
  expect(chief.calls()).toHaveLength(1);
});

test("E1.6-2 answering one-by-one selects those items and continues", ({ chief }) => {
  chief.importWorkflow(SELECT);
  chief.run(["run", "pick"]);
  const r = chief.run(["gate", "answer", "1", '{"mode":"one-by-one","selected":[2,0]}', "--json"]);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const d = show(chief);
  expect(d.run.status).toBe("completed");
  const out = node(d, "choose").output;
  expect(out.selected.map((i: any) => i.title)).toEqual(["Fix prod alert", "Review PR 12"]);
  expect(out.unselected.map((i: any) => i.title)).toEqual(["Write ADR"]);
  expect(out.mode).toBe("sequential");
  expect(chief.calls()[1].prompt).toContain("mode=sequential");
});

test("E1.6-3 'all' and 'by-priority' select and order as specified", ({ chief }) => {
  chief.importWorkflow(SELECT);
  chief.run(["run", "pick"]);
  chief.run(["gate", "answer", "1", '{"mode":"all"}']);
  let out = node(show(chief, 1), "choose").output;
  expect(out.selected).toHaveLength(3);
  expect(out.mode).toBe("parallel");

  chief.run(["run", "pick"]);
  chief.run(["gate", "answer", "2", '{"mode":"by-priority","priority":"P1"}']);
  out = node(show(chief, 2), "choose").output;
  expect(out.selected.map((i: any) => i.priority)).toEqual(["P0", "P1"]);
  expect(out.unselected.map((i: any) => i.title)).toEqual(["Write ADR"]);
  expect(out.mode).toBe("sequential");

  chief.run(["run", "pick"]);
  chief.run(["gate", "answer", "3", '{"mode":"by-priority","run-mode":"parallel"}']);
  out = node(show(chief, 3), "choose").output;
  expect(out.selected.map((i: any) => i.priority)).toEqual(["P0", "P1", "P2"]);
  expect(out.mode).toBe("parallel");
});

const APPROVE = `
name: appr
nodes:
  - { id: draft, type: agent, prompt: 'draft ${fake({ output: { text: "Hello team" } })}' }
  - { id: ok, type: gate, kind: approve, value: "{{nodes.draft.output.text}}", message: "Send this?" }
  - { id: send, type: agent, prompt: 'send: {{nodes.ok.output.value}}' }
edges: [draft -> ok, ok -> send]
`;

test("E1.6-4 approve gate: approve, approve with an edit, reject", ({ chief }) => {
  chief.importWorkflow(APPROVE);
  chief.run(["run", "appr"]);
  expect(chief.run(["gate", "show", "1"]).stdout).toContain("Hello team");
  chief.run(["gate", "approve", "1"]);
  expect(show(chief, 1).run.status).toBe("completed");
  expect(chief.calls().at(-1)!.prompt).toContain("send: Hello team");

  chief.run(["run", "appr"]);
  chief.run(["gate", "approve", "2", "--value", "Hello everyone"]);
  expect(chief.calls().at(-1)!.prompt).toContain("send: Hello everyone");

  chief.run(["run", "appr"]);
  const before = chief.calls().length;
  const rej = chief.run(["gate", "reject", "3"]);
  expect(rej.code).toBe(2);
  const d = show(chief, 3);
  expect(d.run.status).toBe("cancelled");
  expect(node(d, "send")).toBeUndefined();
  expect(chief.calls()).toHaveLength(before);
});

test("E1.6-5 input gate carries text and option", ({ chief }) => {
  chief.importWorkflow(`
name: fb
nodes:
  - { id: work, type: agent, prompt: 'work ${fake({ output: { done: 2 } })}' }
  - { id: feedback, type: gate, kind: input, summary: "{{nodes.work.output}}", options: [done, redo] }
  - { id: after, type: agent, prompt: 'text={{nodes.feedback.output.text}} option={{nodes.feedback.output.option}}' }
edges: [work -> feedback, feedback -> after]
`);
  chief.run(["run", "fb"]);
  const g = chief.run(["gate", "show", "1", "--json"]).json();
  expect(g.payload).toMatchObject({ summary: { done: 2 }, options: ["done", "redo"] });
  chief.run(["gate", "answer", "1", '{"text":"looks good","option":"done"}']);
  expect(show(chief).run.status).toBe("completed");
  expect(chief.calls().at(-1)!.prompt).toContain("text=looks good option=done");
});

test("E1.6-6 invalid answers are rejected and the gate keeps waiting", ({ chief }) => {
  chief.importWorkflow(SELECT);
  chief.run(["run", "pick"]);
  const bad: [string, RegExp][] = [
    ['{"mode":"one-by-one","selected":[7]}', /`selected` must be a list of item indexes/],
    ['{"mode":"random"}', /mode must be one of/],
    ['{"mode":"all","run-mode":"sideways"}', /run-mode/],
    ["[1,2]", /must be a JSON object/],
    ["not json", /not valid JSON/],
  ];
  for (const [answer, message] of bad) {
    const r = chief.run(["gate", "answer", "1", answer]);
    expect(r.code, answer).toBe(1);
    expect(r.stderr, answer).toMatch(message);
  }
  expect(chief.run(["gate", "list", "--json"]).json()[0].status).toBe("waiting");
  expect(chief.run(["gate", "answer", "1", '{"mode":"all"}']).code).toBe(0);
  const twice = chief.run(["gate", "answer", "1", '{"mode":"all"}']);
  expect(twice.code).toBe(1);
  expect(twice.stderr).toContain("already answered");
  expect(chief.run(["gate", "answer", "42", "{}"]).stderr).toContain("gate 42 not found");
});

// ── map ────────────────────────────────────────────────────────────────────

const overlap = (chief: Chief) => {
  const marks = [...chief.calls().map((c) => ({ t: c.ts, d: 1 })), ...chief.ends().map((e) => ({ t: e.ts, d: -1 }))].sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, max = 0;
  for (const m of marks) { cur += m.d; max = Math.max(max, cur); }
  return max;
};

test("E1.7-1 a sequential map runs its children one at a time, in order", ({ chief }) => {
  chief.importWorkflow(`
name: seq
inputs: { items: [alpha, beta, gamma] }
nodes:
  - id: each
    type: map
    over: "{{inputs.items}}"
    node: { type: agent, prompt: 'do {{item}} ${fake({ sleep_ms: 150, output: { handled: true } })}' }
`);
  const d = chief.run(["run", "seq", "--json"]).json();
  expect(d.run.status).toBe("completed");
  expect(chief.calls().map((c) => c.prompt.split(" ")[1])).toEqual(["alpha", "beta", "gamma"]);
  expect(overlap(chief)).toBe(1);
  const m = node(d, "each");
  expect(m.output).toEqual(["alpha", "beta", "gamma"].map((item) => ({ item, status: "completed", output: { handled: true, side_effects: [] } })));
  expect(d.node_runs.filter((n: any) => n.parent_node_run_id === m.id).map((n: any) => n.item_index)).toEqual([0, 1, 2]);
});

test("E1.7-2 a parallel map respects max-parallel", ({ chief }) => {
  chief.importWorkflow(`
name: par
inputs: { items: [1, 2, 3, 4, 5, 6] }
nodes:
  - id: each
    type: map
    over: "{{inputs.items}}"
    mode: parallel
    max-parallel: 2
    node: { type: agent, prompt: 'do {{item}} ${fake({ sleep_ms: 300 })}' }
`);
  const d = chief.run(["run", "par", "--json"]).json();
  expect(d.run.status).toBe("completed");
  expect(chief.calls()).toHaveLength(6);
  expect(overlap(chief)).toBe(2);
  expect(node(d, "each").output.map((r: any) => r.item)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("E1.7-3 a map over a script node passes each item", ({ chief }) => {
  chief.file("double.py", "import json,sys\nd=json.load(sys.stdin)\nprint(json.dumps({'doubled': d['item']['n']*2, 'who': d['inputs']['who']}))\n");
  chief.importWorkflow(`
name: smap
inputs: { who: me, items: [{ n: 1 }, { n: 5 }] }
nodes:
  - id: each
    type: map
    over: "{{inputs.items}}"
    node: { type: script, run: double.py }
`);
  const d = chief.run(["run", "smap", "--json"]).json();
  expect(node(d, "each").output.map((r: any) => r.output)).toEqual([{ doubled: 2, who: "me" }, { doubled: 10, who: "me" }]);
});

test("E1.7-4 a failing child fails the map, or is recorded with on-error: continue", ({ chief }) => {
  const wf = (name: string, extra: string) => `
name: ${name}
inputs: { items: [ok1, bad, ok2] }
nodes:
  - id: each
    type: map
    over: "{{inputs.items}}"
    ${extra}
    node: { type: script, run: maybe.sh }
  - { id: after, type: agent, prompt: 'after {{nodes.each.output}}' }
edges: [each -> after]
`;
  chief.file("maybe.sh", "if grep -q '\"item\":\"bad\"'; then echo 'cannot do this one' >&2; exit 1; fi\necho '{\"ok\": true}'\n");
  chief.importWorkflow(wf("strict", ""));
  const strict = chief.run(["run", "strict", "--json"]);
  expect(strict.code).toBe(1);
  let d = strict.json();
  expect(d.run.status).toBe("failed");
  expect(node(d, "each").error).toContain("1 of 3 items failed");
  expect(d.node_runs.filter((n: any) => n.node_id === "each-item").map((n: any) => n.status)).toEqual(["completed", "failed"]);
  expect(chief.calls()).toHaveLength(0);

  chief.importWorkflow(wf("lenient", "on-error: continue"));
  d = chief.run(["run", "lenient", "--json"]).json();
  expect(d.run.status).toBe("completed");
  expect(node(d, "each").output.map((r: any) => r.status)).toEqual(["completed", "failed", "completed"]);
  expect(node(d, "each").output[1].error).toContain("cannot do this one");
});

test("E1.7-5 `over` must be a list; an empty list completes with []", ({ chief }) => {
  const wf = (name: string) => `
name: ${name}
nodes:
  - { id: each, type: map, over: "{{inputs.items}}", node: { type: agent, prompt: 'do {{item}}' } }
`;
  chief.importWorkflow(wf("notlist"));
  const bad = chief.run(["run", "notlist", "--inputs-json", '{"items":"just a string"}', "--json"]).json();
  expect(bad.run.status).toBe("failed");
  expect(bad.node_runs[0].error).toContain("`over` did not resolve to a list");

  chief.importWorkflow(wf("empty"));
  const empty = chief.run(["run", "empty", "--inputs-json", '{"items":[]}', "--json"]).json();
  expect(empty.run.status).toBe("completed");
  expect(empty.node_runs[0].output).toEqual([]);
  expect(chief.calls()).toHaveLength(0);
});

test("E1.7-6 the map mode can come from a gate's answer", ({ chief }) => {
  chief.importWorkflow(`
name: gmode
inputs: { items: [a, b, c] }
nodes:
  - { id: choose, type: gate, kind: select, from: "{{inputs.items}}" }
  - id: act
    type: map
    over: "{{nodes.choose.output.selected}}"
    mode: "{{nodes.choose.output.mode}}"
    node: { type: agent, prompt: 'do {{item}} ${fake({ sleep_ms: 250 })}' }
edges: [choose -> act]
`);
  chief.run(["run", "gmode"]);
  chief.run(["gate", "answer", "1", '{"mode":"all"}']);
  let d = show(chief, 1);
  expect(node(d, "act").input).toMatchObject({ items: 3, mode: "parallel" });
  expect(overlap(chief)).toBeGreaterThan(1);

  chief.run(["run", "gmode"]);
  chief.run(["gate", "answer", "2", '{"mode":"one-by-one","selected":[1]}']);
  d = show(chief, 2);
  expect(node(d, "act").input).toMatchObject({ items: 1, mode: "sequential" });
});

// ── needs_input ────────────────────────────────────────────────────────────

const REVIEW = `
name: review
nodes:
  - id: review
    type: agent
    prompt: 'Review the PR, ask me before posting. ${fake({ needs_input: { question: "Post this review?", proposed: { body: "LGTM with nits" } } }, { output: { posted: true } })}'
`;

test("E1.8-1 needs_input opens a gate with the question and the proposal", ({ chief }) => {
  chief.importWorkflow(REVIEW);
  const d = chief.run(["run", "review", "--json"]).json();
  expect(d.run.status).toBe("waiting_gate");
  expect(d.node_runs[0].status).toBe("waiting_gate");
  expect(d.gates[0]).toMatchObject({ kind: "approve", reason: "needs_input", status: "waiting", payload: { message: "Post this review?", value: { body: "LGTM with nits" } } });
});

test("E1.8-2 approving resumes the same session with the answer", ({ chief }) => {
  chief.importWorkflow(REVIEW);
  chief.run(["run", "review"]);
  const first = chief.calls()[0];
  chief.run(["gate", "approve", "1"]);
  const d = show(chief);
  expect(d.run.status).toBe("completed");
  expect(d.node_runs[0].output).toMatchObject({ posted: true });
  const calls = chief.calls();
  expect(calls).toHaveLength(2);
  expect(calls[1].resume).toBe(first.session);
  expect(calls[1].argv).toEqual(expect.arrayContaining(["--resume", first.session]));
  expect(calls[1].prompt).toContain("The user approved.");
  expect(d.node_runs[0].session_id).toBe(first.session);
});

test("E1.8-3 an edit or a refusal is sent to the same session", ({ chief }) => {
  chief.importWorkflow(REVIEW);
  chief.run(["run", "review"]);
  chief.run(["gate", "approve", "1", "--value", '{"body":"Please split this PR"}', "--text", "be kinder"]);
  let last = chief.calls().at(-1)!;
  expect(last.resume).toBe(chief.calls()[0].session);
  expect(last.prompt).toContain("Please split this PR");
  expect(last.prompt).toContain("Their reply: be kinder");

  chief.run(["run", "review"]);
  const second = chief.calls().at(-1)!;
  const r = chief.run(["gate", "reject", "2", "--text", "not now"]);
  expect(r.code).toBe(0);
  last = chief.calls().at(-1)!;
  expect(last.resume).toBe(second.session);
  expect(last.prompt).toContain("The user declined: not now");
  expect(last.prompt).toContain("Do not perform the proposed action");
  expect(show(chief, 2).run.status).toBe("completed");
});

test("E1.8-4 needs_input in a parallel map does not block the other children", ({ chief }) => {
  chief.importWorkflow(`
name: pmap
inputs: { items: [{ id: a, ask: false }, { id: b, ask: true }, { id: c, ask: true }, { id: d, ask: false }] }
nodes:
  - id: act
    type: map
    over: "{{inputs.items}}"
    mode: parallel
    max-parallel: 4
    node: { type: script, run: route.py }
  - id: act2
    type: map
    over: "{{nodes.act.output}}"
    mode: parallel
    max-parallel: 4
    node:
      type: agent
      prompt: 'handle {{item.output.id}} {{item.output.directive}}'
edges: [act -> act2]
`);
  // The inner agent's script depends on the item, so each item carries its own directive.
  chief.file("route.py", `import json,sys
it=json.load(sys.stdin)['item']
turns=[{'needs_input': {'question': 'ok for '+it['id']+'?', 'proposed': it['id']}}, {'output': {'id': it['id']}}] if it['ask'] else [{'output': {'id': it['id']}}]
print(json.dumps({'id': it['id'], 'directive': '<fake>'+json.dumps({'turns': turns})+'</fake>'}))
`);
  const d = chief.run(["run", "pmap", "--json"]).json();
  expect(d.run.status).toBe("waiting_gate");
  const children = d.node_runs.filter((n: any) => n.node_id === "act2-item");
  expect(children.map((n: any) => n.status)).toEqual(["completed", "waiting_gate", "waiting_gate", "completed"]);
  const waiting = d.gates.filter((g: any) => g.status === "waiting");
  expect(waiting.map((g: any) => g.payload.message).sort()).toEqual(["ok for b?", "ok for c?"]);

  chief.run(["gate", "approve", String(waiting[0].id)]);
  expect(show(chief).run.status).toBe("waiting_gate");
  chief.run(["gate", "approve", String(waiting[1].id)]);
  const done = show(chief);
  expect(done.run.status).toBe("completed");
  expect(node(done, "act2").output.map((r: any) => r.output.id)).toEqual(["a", "b", "c", "d"]);
});

// ── pause, resume, cancel, crash ───────────────────────────────────────────

const LONG = `
name: long
nodes:
  - { id: slow, type: agent, prompt: 'long task ${fake({ sleep_ms: 60000 }, { output: { finished: true } })}' }
  - { id: after, type: agent, prompt: 'after' }
edges: [slow -> after]
`;

async function startLong(chief: Chief) {
  chief.importWorkflow(LONG);
  const bg = chief.start(["run", "long", "--json"]);
  await chief.until(() => chief.calls().length === 1 && show(chief).node_runs[0]?.session_id);
  return bg;
}
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

test("E1.9-1 pause interrupts the agent with SIGINT and keeps its session", async ({ chief }) => {
  const bg = await startLong(chief);
  const session = chief.calls()[0].session;
  const p = chief.run(["pause", "1", "--json"]);
  expect(p.code, p.stderr).toBe(0);
  expect(p.json().status).toBe("paused");
  await bg.done;
  const d = show(chief);
  expect(d.run.status).toBe("paused");
  expect(d.node_runs[0]).toMatchObject({ node_id: "slow", status: "interrupted", session_id: session });
  expect(chief.ends()).toEqual([expect.objectContaining({ how: "sigint", session })]);
  expect(chief.calls()).toHaveLength(1);
});

test("E1.9-2 resume continues the interrupted session instead of restarting", async ({ chief }) => {
  const bg = await startLong(chief);
  const session = chief.calls()[0].session;
  chief.run(["pause", "1"]);
  await bg.done;
  const r = chief.run(["resume", "1", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  const d = r.json();
  expect(d.run.status).toBe("completed");
  expect(d.node_runs[0]).toMatchObject({ status: "completed", attempt: 1, output: { finished: true }, session_id: session });
  const calls = chief.calls();
  expect(calls).toHaveLength(3);
  expect(calls[1].resume).toBe(session);
  expect(calls[1].prompt).toContain("You were interrupted");
  expect(calls[2].prompt).toContain("after");
});

test("E1.9-3 cancel terminates the agent and cancels the run", async ({ chief }) => {
  const bg = await startLong(chief);
  const pid = chief.calls()[0].pid;
  const c = chief.run(["cancel", "1", "--json"]);
  expect(c.json().status).toBe("cancelled");
  const res = await bg.done;
  expect(res.code).toBe(2);
  const d = show(chief);
  expect(d.run.status).toBe("cancelled");
  expect(d.node_runs.map((n: any) => n.status)).toEqual(["cancelled"]);
  await chief.until(() => gone(pid), 8000);
  expect(chief.run(["resume", "1"]).stderr).toContain("only paused, interrupted or failed runs can be resumed");
});

test("E1.9-4 a run whose chief process died is recovered as interrupted and can be resumed", async ({ chief }) => {
  const bg = await startLong(chief);
  const { pid, session } = chief.calls()[0];
  bg.proc.kill("SIGKILL");
  await bg.done;
  // Any later command notices the dead owner.
  const d = show(chief);
  expect(d.run.status).toBe("interrupted");
  expect(d.node_runs[0].status).toBe("interrupted");
  // The orphaned agent process is cleaned up.
  await chief.until(() => gone(pid), 8000);
  const r = chief.run(["resume", "1", "--json"]);
  expect(r.json().run.status).toBe("completed");
  expect(chief.calls()[1].resume).toBe(session);
});

test("E1.9-5 pause and cancel work on a run that waits at a gate", ({ chief }) => {
  chief.importWorkflow("name: gated\nnodes:\n  - { id: g, type: gate, kind: approve, value: x }\n  - { id: a, type: agent, prompt: after }\nedges: [g -> a]\n");
  chief.run(["run", "gated"]);
  expect(chief.run(["pause", "1", "--json"]).json().status).toBe("paused");
  expect(chief.run(["pause", "1"]).stderr).toContain("nothing to pause");
  expect(chief.run(["resume", "1", "--json"]).json().run.status).toBe("waiting_gate");
  expect(chief.run(["gate", "approve", "1", "--json"]).json().run.status).toBe("completed");

  chief.run(["run", "gated"]);
  expect(chief.run(["cancel", "2", "--json"]).json().status).toBe("cancelled");
  expect(chief.run(["gate", "list", "--all", "--json"]).json().find((g: any) => g.run_id === 2).status).toBe("cancelled");
  expect(chief.run(["gate", "approve", "2"]).stderr).toContain("gate 2 is cancelled");
  expect(chief.run(["cancel", "2"]).stderr).toContain("already cancelled");
});

test("E1.9-6 resuming a failed run retries only the failed node", ({ chief }) => {
  chief.importWorkflow(`
name: retry
nodes:
  - { id: a, type: agent, prompt: 'A ${fake({ output: { v: 1 } })}' }
  - { id: b, type: agent, prompt: 'B after {{nodes.a.output.v}} ${fake({ crash_times: 2, output: { v: 2 } })}' }
  - { id: c, type: agent, prompt: 'C after {{nodes.b.output.v}}' }
edges: [a -> b, b -> c]
`);
  const first = chief.run(["run", "retry", "--json"]);
  expect(first.code).toBe(1);
  expect(first.json().run.status).toBe("failed");
  const r = chief.run(["resume", "1", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  const d = r.json();
  expect(d.run.status).toBe("completed");
  expect(d.node_runs.map((n: any) => [n.node_id, n.attempt, n.status])).toEqual([["a", 1, "completed"], ["b", 1, "failed"], ["b", 2, "completed"], ["c", 1, "completed"]]);
  expect(chief.calls().filter((c) => c.prompt.startsWith("A"))).toHaveLength(1);
});

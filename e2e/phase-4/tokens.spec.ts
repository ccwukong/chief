import { expect, fake, test, type Chief } from "../helpers";

const show = (chief: Chief, id = 1) => chief.run(["runs", "show", String(id), "--json"]).json();
const events = (chief: Chief, id = 1) => chief.run(["runs", "tail", String(id), "--json"]).stdout.trim().split("\n").map((l) => JSON.parse(l));
const flag = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

test("E4.1-1 per-node usage is recorded and the run totals are the sum", ({ chief }) => {
  chief.importWorkflow(`
name: usage
nodes:
  - { id: a, type: agent, prompt: 'A ${fake({ cost: 0.12, tokens: { in: 1000, out: 200 } })}' }
  - { id: b, type: agent, prompt: 'B ${fake({ cost: 0.3, tokens: { in: 4000, out: 900 } })}' }
  - { id: g, type: gate, kind: approve, value: ok }
edges: [a -> b, b -> g]
`);
  const d = chief.run(["run", "usage", "--json"]).json();
  expect(d.node_runs[0].usage).toMatchObject({ input_tokens: 1000, output_tokens: 200, cost_usd: 0.12 });
  expect(d.node_runs[1].usage).toMatchObject({ input_tokens: 4000, output_tokens: 900, cost_usd: 0.3 });
  expect(d.node_runs[2].usage).toBeNull();
  expect(d.run.tokens_in).toBe(5000);
  expect(d.run.tokens_out).toBe(1100);
  expect(d.run.cost_usd).toBeCloseTo(0.42, 6);
  const text = chief.run(["runs", "show", "1"]).stdout;
  expect(text).toContain("tokens in 5000  out 1100  cost $0.4200");
  expect(text).toMatch(/a\s+agent\s+completed\s+1\s+1000\s+200\s+\$0\.1200/);
  expect(chief.run(["runs", "list"]).stdout).toContain("$0.4200");
});

test("E4.1-2 usage accumulates across the invocations of one node", ({ chief }) => {
  chief.importWorkflow(`
name: multi
nodes:
  - id: a
    type: agent
    prompt: 'A ${fake({ needs_input: { question: "ok?", proposed: 1 }, cost: 0.1, tokens: { in: 500, out: 50 } }, { text: "forgot the json", cost: 0.2, tokens: { in: 700, out: 10 } }, { output: { ok: true }, cost: 0.05, tokens: { in: 800, out: 30 } })}'
`);
  chief.run(["run", "multi"]);
  expect(show(chief).run.cost_usd).toBeCloseTo(0.1, 6);
  const d = chief.run(["gate", "approve", "1", "--json"]).json();
  expect(d.run.status).toBe("completed");
  expect(d.node_runs[0].usage).toMatchObject({ input_tokens: 2000, output_tokens: 90, invocations: 3 });
  expect(d.node_runs[0].usage.cost_usd).toBeCloseTo(0.35, 6);
  expect(d.run.cost_usd).toBeCloseTo(0.35, 6);
});

const CHAIN = (budget: string) => `
name: chain
${budget}
nodes:
  - { id: a, type: agent, prompt: 'A ${fake({ cost: 0.15 })}' }
  - { id: b, type: agent, prompt: 'B ${fake({ cost: 0.01 })}' }
  - { id: c, type: agent, prompt: 'C ${fake({ cost: 0.01 })}' }
edges: [a -> b, b -> c]
`;

test("E4.2-1 passing warn-usd emits one warning and the run continues", ({ chief }) => {
  chief.importWorkflow(CHAIN("budget: { warn-usd: 0.1 }"));
  const d = chief.run(["run", "chain", "--json"]).json();
  expect(d.run.status).toBe("completed");
  const warnings = events(chief).filter((e: any) => e.type === "budget_warning");
  expect(warnings).toHaveLength(1);
  expect(warnings[0].payload).toMatchObject({ "warn-usd": 0.1, cost_usd: 0.15 });
  expect(d.gates).toHaveLength(0);
});

test("E4.2-2 reaching max-usd stops the run with a budget gate before the next node", ({ chief }) => {
  chief.importWorkflow(CHAIN("budget: { warn-usd: 0.05, max-usd: 0.1 }"));
  const r = chief.run(["run", "chain", "--json"]);
  expect(r.code).toBe(0);
  const d = r.json();
  expect(d.run.status).toBe("waiting_gate");
  expect(d.gates).toHaveLength(1);
  expect(d.gates[0]).toMatchObject({ kind: "approve", reason: "budget", node_run_id: null, status: "waiting" });
  expect(d.gates[0].payload.message).toContain("Budget reached: $0.1500 spent, limit $0.10");
  expect(chief.calls()).toHaveLength(1);
  expect(d.node_runs.find((n: any) => n.node_id === "b")?.status ?? "pending").toBe("pending");
  expect(d.budget).toEqual({ "warn-usd": 0.05, "max-usd": 0.1 });
});

test("E4.2-3 approving raises the cap and continues; rejecting cancels", ({ chief }) => {
  chief.importWorkflow(CHAIN("budget: { max-usd: 0.1 }"));
  chief.run(["run", "chain"]);
  const ok = chief.run(["gate", "approve", "1", "--json"]);
  expect(ok.code, ok.stdout).toBe(0);
  const d = ok.json();
  expect(d.run.status).toBe("completed");
  // Raised to one step above what was already spent (0.15 + 0.10).
  expect(d.budget["max-usd"]).toBeCloseTo(0.25, 6);
  expect(chief.calls()).toHaveLength(3);
  expect(events(chief).some((e: any) => e.type === "budget_raised")).toBe(true);

  chief.run(["run", "chain"]);
  const no = chief.run(["gate", "reject", "2", "--json"]);
  expect(no.code).toBe(2);
  expect(no.json().run.status).toBe("cancelled");
  expect(chief.calls()).toHaveLength(4);

  // An explicit new cap can be given with the approval.
  chief.run(["run", "chain"]);
  expect(chief.run(["gate", "approve", "3", "--value", "5", "--json"]).json().budget["max-usd"]).toBe(5);
});

test("E4.2-4 run --max-usd overrides the workflow and the default budget", ({ chief }) => {
  chief.importWorkflow(CHAIN("budget: { max-usd: 50 }"));
  const d = chief.run(["run", "chain", "--max-usd", "0.01", "--json"]).json();
  expect(d.run.status).toBe("waiting_gate");
  expect(d.gates[0].reason).toBe("budget");
  expect(d.budget["max-usd"]).toBe(0.01);

  chief.importWorkflow(CHAIN("").replace("name: chain", "name: nobudget"));
  expect(chief.run(["run", "nobudget", "--json"]).json().run.status).toBe("completed");
  chief.run(["settings", "set", "default-budget", '{"max-usd": 0.1}']);
  const withDefault = chief.run(["run", "nobudget", "--json"]).json();
  expect(withDefault.run.status).toBe("waiting_gate");
  expect(withDefault.budget).toEqual({ "max-usd": 0.1 });
});

test("E4.2-5 a budget reached inside a parallel map stops new children from starting", ({ chief }) => {
  chief.importWorkflow(`
name: fan
budget: { max-usd: 0.1 }
inputs: { items: [1, 2, 3, 4, 5, 6, 7, 8] }
nodes:
  - id: each
    type: map
    over: "{{inputs.items}}"
    mode: parallel
    max-parallel: 2
    node: { type: agent, prompt: 'item {{item}} ${fake({ sleep_ms: 200, cost: 0.05 })}' }
`);
  const d = chief.run(["run", "fan", "--json"]).json();
  expect(d.run.status).toBe("waiting_gate");
  expect(d.gates.filter((g: any) => g.reason === "budget" && g.status === "waiting")).toHaveLength(1);
  const started = chief.calls().length;
  expect(started).toBeGreaterThanOrEqual(2);
  expect(started).toBeLessThanOrEqual(3);
  expect(d.node_runs.filter((n: any) => n.node_id === "each-item" && n.status === "completed")).toHaveLength(started);
  // Approving lets the remaining items go on (until the raised cap is reached again).
  chief.run(["gate", "approve", String(d.gates[0].id)]);
  expect(chief.calls().length).toBeGreaterThan(started);
});

test("E4.3-1 an oversized upstream output is truncated in the downstream prompt", ({ chief }) => {
  chief.run(["settings", "set", "output-size-limit", "300"]);
  const big = "word ".repeat(2000);
  chief.importWorkflow(`
name: big
nodes:
  - { id: a, type: agent, prompt: 'A ${fake({ output: { blob: big, small: "tiny" } })}' }
  - { id: b, type: agent, prompt: 'B small={{nodes.a.output.small}} blob={{nodes.a.output.blob}} END' }
edges: [a -> b]
`);
  const d = chief.run(["run", "big", "--json"]).json();
  expect(d.run.status).toBe("completed");
  const prompt = chief.calls()[1].prompt;
  expect(prompt).toContain("small=tiny");
  expect(prompt).toContain("[truncated by chief: 9700 more characters]");
  expect(prompt.indexOf(" END")).toBeLessThan(600);
  const ev = events(chief).filter((e: any) => e.type === "output_truncated");
  expect(ev).toHaveLength(1);
  expect(ev[0].payload).toMatchObject({ ref: "nodes.a.output.blob", chars: 10000, node_id: "b" });
  // The stored output itself is not truncated.
  expect(d.node_runs[0].output.blob).toHaveLength(10000);
});

test("E4.3-2 prompt size estimates are shown before and after a run", ({ chief }) => {
  const prompt = "Summarise everything. ".repeat(40);
  chief.importWorkflow(`
name: est
nodes:
  - { id: a, type: agent, prompt: '${prompt}' }
  - { id: g, type: gate, kind: approve, value: x }
edges: [a -> g]
`);
  const v = chief.run(["workflow", "validate", "est", "--json"]).json();
  expect(v.estimates).toEqual([{ node_id: "a", chars: prompt.length, est_tokens: Math.ceil(prompt.length / 4) }]);
  const text = chief.run(["workflow", "validate", "est"]).stdout;
  expect(text).toContain("Prompt size estimates");
  expect(text).toMatch(/a\s+880\s+220/);

  const d = chief.run(["run", "est", "--json"]).json();
  const sent = chief.calls()[0].prompt.length;
  expect(d.node_runs[0].input).toMatchObject({ prompt_chars: sent, est_tokens: Math.ceil(sent / 4) });
  expect(sent).toBeGreaterThan(prompt.length);
  const shown = chief.run(["runs", "show", "1"]).stdout;
  expect(shown).toContain("PROMPT~TOK");
  expect(shown).toContain(String(Math.ceil(sent / 4)));
});

test("E4.4-1 a node-level model is passed for that node only", ({ chief }) => {
  chief.importWorkflow(`
name: models
nodes:
  - { id: cheap, type: agent, model: haiku, prompt: A }
  - { id: plain, type: agent, prompt: B }
  - { id: smart, type: agent, model: claude-opus-5-5, prompt: C }
edges: [cheap -> plain, plain -> smart]
`);
  const d = chief.run(["run", "models", "--json"]).json();
  const calls = chief.calls();
  expect(calls.map((c) => flag(c.argv, "--model"))).toEqual(["haiku", null, "claude-opus-5-5"]);
  expect(d.node_runs.map((n: any) => n.usage.model)).toEqual(["haiku", "claude-fake-1", "claude-opus-5-5"]);
  expect(d.node_runs.map((n: any) => n.input.model)).toEqual(["haiku", null, "claude-opus-5-5"]);
});

import { readFileSync } from "node:fs";
import { expect, fake, test } from "../helpers";

const SIMPLE = `
name: simple
inputs: { who: world }
nodes:
  - id: a
    type: agent
    prompt: 'Say hi to {{inputs.who}}. ${fake({ output: { greeting: "hi" } })}'
  - id: b
    type: agent
    prompt: 'Got {{nodes.a.output.greeting}}'
edges: [a -> b]
`;

test("E1.1-1 import, export as YAML and JSON, and round-trip", ({ chief }) => {
  const imp = chief.importWorkflow(SIMPLE);
  expect(imp.code, imp.stderr).toBe(0);
  expect(imp.json()).toMatchObject({ name: "simple", version: 1 });

  const yaml = chief.run(["workflow", "export", "simple"]).stdout;
  expect(yaml).toContain("name: simple");
  expect(yaml).toContain("- a -> b");
  const asJson = JSON.parse(chief.run(["workflow", "export", "simple", "--format", "json"]).stdout);
  expect(asJson.nodes.map((n: any) => n.id)).toEqual(["a", "b"]);
  expect(asJson.edges).toEqual([{ from: "a", to: "b" }]);

  // Re-importing the export changes nothing, so the version stays.
  expect(chief.run(["workflow", "import", chief.file("simple.yaml", yaml), "--json"]).json().version).toBe(1);
  const out = chief.file("out.yaml", "");
  expect(chief.run(["workflow", "export", "simple", "-o", out]).code).toBe(0);
  expect(readFileSync(out, "utf8")).toBe(yaml);
});

test("E1.1-2 a cycle is rejected", ({ chief }) => {
  const f = chief.file("cycle.yaml", `
name: cycle
nodes:
  - { id: a, type: agent, prompt: x }
  - { id: b, type: agent, prompt: y }
edges: [a -> b, b -> a]
`);
  const r = chief.run(["workflow", "validate", f]);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain("workflow has a cycle");
});

test("E1.1-3 unknown nodes in edges and templates are rejected", ({ chief }) => {
  const f = chief.file("bad.yaml", `
name: bad
nodes:
  - { id: a, type: agent, prompt: 'see {{nodes.ghost.output.x}}' }
edges: [a -> nowhere]
`);
  const r = chief.run(["workflow", "validate", f, "--json"]);
  expect(r.code).toBe(1);
  expect(r.json().errors.join("\n")).toContain('unknown node "nowhere"');

  const g = chief.file("bad2.yaml", `
name: bad2
nodes:
  - { id: a, type: agent, prompt: 'see {{nodes.ghost.output.x}}' }
`);
  expect(chief.run(["workflow", "validate", g, "--json"]).json().errors.join("\n")).toContain('refers to unknown node "ghost"');
});

test("E1.1-4 a template may only refer to nodes that run before it", ({ chief }) => {
  const f = chief.file("order.yaml", `
name: order
nodes:
  - { id: a, type: agent, prompt: 'see {{nodes.b.output.x}}' }
  - { id: b, type: agent, prompt: y }
edges: [a -> b]
`);
  const r = chief.run(["workflow", "validate", f, "--json"]);
  expect(r.code).toBe(1);
  expect(r.json().errors.join("\n")).toContain('"b", which does not run before "a"');
});

test("E1.1-5 schema problems are reported with their path", ({ chief }) => {
  const f = chief.file("schema.yaml", `
name: Bad_Name
nodes:
  - { id: Node_One, type: agent, prompt: x, colour: red }
  - { id: g, type: gate, kind: maybe }
  - { id: m, type: map, over: [1], max-parallel: lots, node: { type: agent, prompt: p } }
`);
  const r = chief.run(["workflow", "validate", f, "--json"]);
  expect(r.code).toBe(1);
  const errors: string = r.json().errors.join("\n");
  expect(errors).toContain("name: workflow names are lower-case kebab-case");
  expect(errors).toContain("nodes.0.id");
  expect(errors).toMatch(/nodes\.0.*colour/);
  expect(errors).toContain("nodes.1.kind");
  expect(errors).toContain("nodes.2.max-parallel");
});

test("E1.1-6 the version increments only when the definition changes", ({ chief }) => {
  expect(chief.importWorkflow(SIMPLE).json().version).toBe(1);
  expect(chief.importWorkflow(SIMPLE).json().version).toBe(1);
  expect(chief.importWorkflow(SIMPLE.replace("Say hi", "Say hello")).json().version).toBe(2);
});

test("E1.2-1 templates resolve inputs, nested outputs, kebab-case keys and array indexes", ({ chief }) => {
  chief.importWorkflow(`
name: tpl
inputs: { who-is: world }
nodes:
  - id: a
    type: agent
    prompt: 'first ${fake({ output: { b: { c: "deep" }, list: ["x", "y"], "my-key": "kebab", obj: { n: 1 } } })}'
  - id: b
    type: agent
    prompt: 'in={{inputs.who-is}} c={{nodes.a.output.b.c}} idx={{ nodes.a.output.list.1 }} k={{nodes.a.output.my-key}} obj={{nodes.a.output.obj}}'
edges: [a -> b]
`);
  const r = chief.run(["run", "tpl", "--json"]);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const prompt = chief.calls()[1].prompt;
  expect(prompt).toContain("in=world c=deep idx=y k=kebab obj={");
  expect(prompt).toContain('"n": 1');
});

test("E1.2-2 a value that is exactly one template keeps its type", ({ chief }) => {
  chief.file("echo.py", "import json,sys\nprint(json.dumps({'got': json.load(sys.stdin)}))\n");
  chief.importWorkflow(`
name: raw
nodes:
  - id: a
    type: agent
    prompt: 'x ${fake({ output: { list: ["x", "y"], n: 7 } })}'
  - id: s
    type: script
    run: echo.py
    input: { items: "{{nodes.a.output.list}}", n: "{{nodes.a.output.n}}", text: "n is {{nodes.a.output.n}}" }
edges: [a -> s]
`);
  const d = chief.run(["run", "raw", "--json"]).json();
  expect(d.run.status).toBe("completed");
  expect(d.node_runs[1].output.got).toEqual({ items: ["x", "y"], n: 7, text: "n is 7" });
});

test("E1.2-3 a path that is missing at run time fails the node", ({ chief }) => {
  // A result path that only turns out to be missing once the earlier step has run fails that node.
  chief.importWorkflow(`
name: missing
nodes:
  - { id: a, type: agent, prompt: 'first ${fake({ output: { there: 1 } })}' }
  - { id: b, type: agent, prompt: 'hello {{nodes.a.output.not-there}}' }
edges: [a -> b]
`);
  const r = chief.run(["run", "missing", "--json"]);
  expect(r.code).toBe(1);
  expect(r.json().node_runs[1].error).toContain('cannot resolve "{{nodes.a.output.not-there}}"');
  expect(chief.calls()).toHaveLength(1);
  // An input that is missing is known before anything runs: the run is refused (see E9.48-1).
  chief.importWorkflow(`
name: missing-input
nodes:
  - { id: a, type: agent, prompt: 'hello {{inputs.not-there}}' }
`);
  const refused = chief.run(["run", "missing-input", "--json"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr + refused.stdout).toContain("inputs.not-there");
  expect(chief.calls()).toHaveLength(1);
});

test("E1.2-4 expressions are rejected, never evaluated", ({ chief }) => {
  for (const expr of ["{{1+1}}", "{{inputs.a.toString()}}", "{{process.env.HOME}} {{ inputs['x'] }}", "{{ unclosed"]) {
    const f = chief.file("expr.yaml", `name: expr\nnodes:\n  - id: a\n    type: agent\n    prompt: ${JSON.stringify("v=" + expr)}\n`);
    const r = chief.run(["workflow", "validate", f, "--json"]);
    expect(r.code, expr).toBe(1);
    expect(r.json().errors.join("\n"), expr).toMatch(/invalid template reference|unclosed|unknown template root/);
  }
});

test("E1.10-1 run inputs override the workflow defaults", ({ chief }) => {
  chief.importWorkflow(`
name: inp
inputs: { who: world, n: 1, keep: default }
nodes:
  - { id: a, type: agent, prompt: 'who={{inputs.who}} n={{inputs.n}} keep={{inputs.keep}} extra={{inputs.extra}}' }
`);
  chief.run(["run", "inp", "--input", "who=team", "--input", "n=5", "--inputs-json", '{"extra":{"deep":true}}']);
  const prompt = chief.calls()[0].prompt;
  expect(prompt).toContain("who=team n=5 keep=default extra={");
  expect(prompt).toContain('"deep": true');
});

test("E1.10-2 runs list, show and tail agree, and unknown ids are errors", ({ chief }) => {
  chief.importWorkflow(SIMPLE);
  chief.run(["run", "simple"]);
  const list = chief.run(["runs", "list", "--json"]).json();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id: 1, workflow_name: "simple", status: "completed" });
  const show = chief.run(["runs", "show", "1", "--json"]).json();
  expect(show.run.status).toBe("completed");
  expect(show.node_runs.map((n: any) => [n.node_id, n.status])).toEqual([["a", "completed"], ["b", "completed"]]);
  const text = chief.run(["runs", "show", "1"]).stdout;
  expect(text).toMatch(/run 1\s+simple v1\s+completed/);
  const tail = chief.run(["runs", "tail", "1", "--json"]).stdout.trim().split("\n").map((l) => JSON.parse(l));
  expect(tail.every((e: any) => e.run_id === 1)).toBe(true);
  const missing = chief.run(["runs", "show", "99"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("run 99 not found");
});

test("E1.10-3 workflow list, validate by name, and rm", ({ chief }) => {
  chief.importWorkflow(SIMPLE);
  chief.importWorkflow(SIMPLE.replace("name: simple", "name: other"));
  expect(chief.run(["workflow", "list", "--json"]).json().map((w: any) => w.name)).toEqual(["other", "simple"]);
  expect(chief.run(["workflow", "validate", "simple"]).stdout).toContain("valid");
  chief.run(["run", "simple"]);
  const rm = chief.run(["workflow", "rm", "simple"]);
  expect(rm.code).toBe(1);
  expect(rm.stderr).toContain("has runs, and a run is kept in full: archive it instead");
  expect(rm.stderr).toContain("chief workflow archive simple");
  expect(chief.run(["workflow", "rm", "other"]).code).toBe(0);
  expect(chief.run(["workflow", "list", "--json"]).json().map((w: any) => w.name)).toEqual(["simple"]);
  expect(chief.run(["run", "other"]).stderr).toContain('workflow "other" not found');
});

test("E1.10-4 exit codes follow the run status", ({ chief }) => {
  chief.importWorkflow(SIMPLE);
  expect(chief.run(["run", "simple"]).code).toBe(0);
  chief.importWorkflow(`
name: fails
nodes:
  - { id: a, type: agent, prompt: 'x ${fake({ error: true })}' }
`);
  expect(chief.run(["run", "fails"]).code).toBe(1);
  chief.importWorkflow(`
name: gated
nodes:
  - { id: g, type: gate, kind: approve, value: ship it }
`);
  const waiting = chief.run(["run", "gated"]);
  expect(waiting.code).toBe(0);
  expect(waiting.stdout).toContain("Waiting gates:");
  expect(chief.run(["gate", "reject", "1"]).code).toBe(2);
});

test("E9.56-1 a placeholder written with single braces or as `input` is rejected with the correction", ({ chief }) => {
  const check = (prompt: string) => {
    const f = chief.file("near.yaml", `name: near\nnodes:\n  - id: a\n    type: agent\n    prompt: ${JSON.stringify(prompt)}\n`);
    return chief.run(["workflow", "validate", f, "--json"]);
  };
  const single = check("review pull request {input.prlink}");
  expect(single.code).toBe(1);
  expect(JSON.stringify(single.json().errors)).toContain("write {{inputs.prlink}}");
  expect(JSON.stringify(check("review {inputs.prlink}").json().errors)).toContain("write {{inputs.prlink}}");
  expect(JSON.stringify(check("review {{input.prlink}}").json().errors)).toContain("write {{inputs.prlink}}");
  expect(JSON.stringify(check("use {nodes.plan.output.items}").json().errors)).toContain("write {{nodes.plan.output.items}}");
  // JSON and ordinary braces in a prompt are not placeholders and are left alone.
  const fine = check('Return {"input": {"prlink": 1}} and {anything else}. Then {{inputs.prlink}}.');
  expect(fine.code, fine.stdout).toBe(0);
});

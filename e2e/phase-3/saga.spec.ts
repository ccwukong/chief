import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, fake, test, type Chief } from "../helpers";

const show = (chief: Chief, id = 1) => chief.run(["runs", "show", String(id), "--json"]).json();
const eff = (kind: string, ref: string, extra: object = {}) => ({ kind, ref, url: `https://example.test/${ref}`, how_to_undo: `undo ${ref}`, irreversible: false, ...extra });
const undo = (reverted: string[], failed: object[] = []) => fake({ output: { reverted, failed } });

/** Three agent nodes that each write something, each with a compensation. */
const THREE = `
name: three
nodes:
  - id: a
    type: agent
    prompt: 'A ${fake({ output: { side_effects: [eff("doc", "doc-a")] } })}'
    compensate: { prompt: 'UNDO-A {{output.side_effects}} ${undo(["doc-a"])}' }
  - id: b
    type: agent
    prompt: 'B ${fake({ output: { side_effects: [eff("ticket", "T-1"), eff("comment", "T-1/c1")] } })}'
    compensate: { prompt: 'UNDO-B {{side_effects}} ${undo(["T-1", "T-1/c1"])}' }
  - id: c
    type: agent
    prompt: 'C ${fake({ output: { side_effects: [eff("review", "pr-9")] } })}'
    compensate: { prompt: 'UNDO-C ${undo(["pr-9"])}' }
edges: [a -> b, b -> c]
`;

test("E3.1-1 side effects reported by a script are recorded in the ledger", ({ chief }) => {
  chief.file("write.py", `import json\nprint(json.dumps({"made": "report.md", "side_effects": [{"kind": "file", "ref": "report.md", "how_to_undo": "delete report.md", "irreversible": False}]}))\n`);
  chief.importWorkflow("name: sfx\nnodes:\n  - { id: s, type: script, run: write.py }\n");
  const d = chief.run(["run", "sfx", "--json"]).json();
  expect(d.side_effects).toHaveLength(1);
  expect(d.side_effects[0]).toMatchObject({ kind: "file", ref: "report.md", how_to_undo: "delete report.md", irreversible: 0 });
});

test("E3.2-1 an agent compensation runs in a fresh session and sees the node's side effects", ({ chief }) => {
  chief.importWorkflow(THREE);
  chief.run(["run", "three"]);
  const forward = chief.calls();
  expect(chief.run(["revert", "1"]).code).toBe(0);
  const comp = chief.calls().slice(forward.length);
  const undoB = comp.find((c) => c.prompt.startsWith("UNDO-B"))!;
  expect(undoB.resume).toBeNull();
  expect(forward.map((c) => c.session)).not.toContain(undoB.session);
  expect(undoB.prompt).toContain('"ref": "T-1"');
  expect(undoB.prompt).toContain('"how_to_undo": "undo T-1/c1"');
  expect(undoB.prompt).toContain("You are undoing earlier work");
  expect(comp.find((c) => c.prompt.startsWith("UNDO-A"))!.prompt).toContain('"ref": "doc-a"');
});

test("E3.2-2 a script compensation gets output, side effects and item on stdin, sandboxed", ({ chief }) => {
  chief.file("make.py", `import json\nopen("made.txt","w").write("x")\nprint(json.dumps({"path": "made.txt", "side_effects": [{"kind": "file", "ref": "made.txt"}]}))\n`);
  chief.file("unmake.py", `import json,os,sys
d=json.load(sys.stdin)
os.remove(d["output"]["path"])
try:
    open(os.path.expanduser("~/chief-e2e-comp-denied"),"w"); outside="written"
except PermissionError: outside="denied"
open("undo-input.json","w").write(json.dumps(d))
print(json.dumps({"reverted": [e["ref"] for e in d["side_effects"]], "outside": outside, "tmp": os.environ["TMPDIR"]}))
`);
  chief.importWorkflow("name: scomp\nnodes:\n  - { id: s, type: script, run: make.py, compensate: { run: unmake.py } }\n");
  chief.run(["run", "scomp"]);
  expect(existsSync(join(chief.dir, "made.txt"))).toBe(true);
  const r = chief.run(["revert", "1", "--json"]);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(existsSync(join(chief.dir, "made.txt"))).toBe(false);
  const input = JSON.parse(readFileSync(join(chief.dir, "undo-input.json"), "utf8"));
  expect(input.output.path).toBe("made.txt");
  expect(input.side_effects).toEqual([{ kind: "file", ref: "made.txt", url: null, how_to_undo: null, irreversible: false }]);
  expect(input.item).toBeNull();
  const comp = show(chief).node_runs.find((n: any) => n.phase === "compensate");
  expect(comp).toMatchObject({ node_id: "s", node_type: "script", status: "completed", output: { reverted: ["made.txt"], outside: "denied" } });
  expect(comp.output.tmp).toContain(join("runs", "1"));
});

test("E3.3-1 revert compensates completed nodes in reverse order", ({ chief }) => {
  chief.importWorkflow(THREE);
  chief.run(["run", "three"]);
  const n = chief.calls().length;
  const r = chief.run(["revert", "1", "--json"]);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const report = r.json();
  expect(report).toMatchObject({ run_id: 1, compensated: ["c", "b", "a"], reverted_effects: 4, manual: [] });
  expect(chief.calls().slice(n).map((c) => c.prompt.slice(0, 6))).toEqual(["UNDO-C", "UNDO-B", "UNDO-A"]);

  const d = show(chief);
  expect(d.run.status).toBe("reverted");
  const comps = d.node_runs.filter((x: any) => x.phase === "compensate");
  expect(comps.map((x: any) => [x.node_id, x.status])).toEqual([["c", "completed"], ["b", "completed"], ["a", "completed"]]);
  expect(d.node_runs.filter((x: any) => x.phase === "forward").every((x: any) => x.compensated_at)).toBe(true);
  expect(d.side_effects.every((e: any) => e.reverted_at)).toBe(true);
  expect(chief.run(["revert", "1"]).stderr).toContain("run 1 is reverted");
  const text = chief.run(["runs", "show", "1"]).stdout;
  expect(text).toContain("a (compensate)");
  expect(text).toContain("[reverted]");
});

test("E3.3-2 revert --to only undoes the nodes after that node", ({ chief }) => {
  chief.importWorkflow(THREE);
  chief.run(["run", "three"]);
  const report = chief.run(["revert", "1", "--to", "a", "--json"]).json();
  expect(report.compensated).toEqual(["c", "b"]);
  const d = show(chief);
  expect(d.side_effects.map((e: any) => [e.ref, !!e.reverted_at])).toEqual([["doc-a", false], ["T-1", true], ["T-1/c1", true], ["pr-9", true]]);
  expect(d.node_runs.find((x: any) => x.node_id === "a" && x.phase === "forward").compensated_at).toBeNull();

  chief.run(["run", "three"]);
  const bad = chief.run(["revert", "2", "--to", "nope"]);
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain('node "nope" is not a top-level node');
  expect(show(chief, 2).run.status).toBe("completed");
});

test("E3.3-3 effects of a node without a compensation are listed as manual", ({ chief }) => {
  chief.importWorkflow(`
name: nocomp
nodes:
  - { id: a, type: agent, prompt: 'A ${fake({ output: { side_effects: [eff("slack_message", "C1/1")] } })}' }
`);
  chief.run(["run", "nocomp"]);
  const r = chief.run(["revert", "1"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("Manual follow-up needed:");
  expect(r.stdout).toMatch(/a: slack_message C1\/1 .* — node has no compensation \(how to undo: undo C1\/1\)/);
  const logged = chief.run(["runs", "tail", "1", "--json"]).stdout.trim().split("\n").map((l) => JSON.parse(l)).find((e: any) => e.type === "revert_report");
  expect(logged.payload.manual).toHaveLength(1);
  expect(show(chief).side_effects[0].reverted_at).toBeNull();
});

test("E3.3-4 a read-only node is skipped and not listed as manual", ({ chief }) => {
  chief.importWorkflow("name: ro\nnodes:\n  - { id: read, type: agent, prompt: just read }\n");
  chief.run(["run", "ro"]);
  const n = chief.calls().length;
  const report = chief.run(["revert", "1", "--json"]).json();
  expect(report).toMatchObject({ compensated: [], manual: [], skipped: ["read"], reverted_effects: 0 });
  expect(chief.calls()).toHaveLength(n);
  expect(chief.run(["revert", "1"]).code).toBe(1);
});

test("E3.3-5 a failed or partial compensation leaves its effects as manual, with the reason", ({ chief }) => {
  chief.file("write.py", `import json\nprint(json.dumps({"side_effects": [{"kind": "file", "ref": "x.txt"}]}))\n`);
  chief.file("broken.sh", "echo 'cannot reach the API' >&2\nexit 4\n");
  chief.importWorkflow(`
name: partial
nodes:
  - id: a
    type: agent
    prompt: 'A ${fake({ output: { side_effects: [eff("ticket", "T-1"), eff("ticket", "T-2")] } })}'
    compensate: { prompt: 'UNDO-A ${undo(["T-1"], [{ ref: "T-2", reason: "ticket is locked" }])}' }
  - { id: s, type: script, run: write.py, compensate: { run: broken.sh } }
edges: [a -> s]
`);
  chief.run(["run", "partial"]);
  const report = chief.run(["revert", "1", "--json"]).json();
  expect(report.reverted_effects).toBe(1);
  expect(report.compensated).toEqual(["a"]);
  expect(report.manual).toEqual([
    expect.objectContaining({ node_id: "s", ref: "x.txt", reason: expect.stringContaining("compensation failed: script exited with code 4") }),
    expect.objectContaining({ node_id: "a", ref: "T-2", reason: "ticket is locked" }),
  ]);
  const d = show(chief);
  expect(d.run.status).toBe("reverted");
  expect(d.side_effects.map((e: any) => [e.ref, !!e.reverted_at])).toEqual([["T-1", true], ["T-2", false], ["x.txt", false]]);
});

test("E3.3-6 failed runs and runs waiting at a gate can be reverted", ({ chief }) => {
  chief.importWorkflow(`
name: halfway
nodes:
  - id: a
    type: agent
    prompt: 'A ${fake({ output: { side_effects: [eff("doc", "d1")] } })}'
    compensate: { prompt: 'UNDO-A ${undo(["d1"])}' }
  - { id: b, type: agent, prompt: 'B ${fake({ error: true })}' }
edges: [a -> b]
`);
  expect(chief.run(["run", "halfway"]).code).toBe(1);
  expect(chief.run(["revert", "1", "--json"]).json()).toMatchObject({ compensated: ["a"], reverted_effects: 1 });
  expect(show(chief, 1).run.status).toBe("reverted");

  chief.importWorkflow(`
name: gated
nodes:
  - id: a
    type: agent
    prompt: 'A ${fake({ output: { side_effects: [eff("doc", "d2")] } })}'
    compensate: { prompt: 'UNDO-A ${undo(["d2"])}' }
  - { id: g, type: gate, kind: approve, value: go }
  - { id: c, type: agent, prompt: C }
edges: [a -> g, g -> c]
`);
  chief.run(["run", "gated"]);
  expect(show(chief, 2).run.status).toBe("waiting_gate");
  expect(chief.run(["revert", "2", "--json"]).json().compensated).toEqual(["a"]);
  const d = show(chief, 2);
  expect(d.run.status).toBe("reverted");
  expect(d.gates[0].status).toBe("cancelled");
  expect(chief.run(["gate", "approve", String(d.gates[0].id)]).code).toBe(1);
});

test("E3.3-7 map children are each compensated with their own item", ({ chief }) => {
  chief.file("item-directive.py", `import json,sys
it=json.load(sys.stdin)["item"]
print(json.dumps({"name": it, "do": "<fake>"+json.dumps({"turns":[{"output":{"side_effects":[{"kind":"doc","ref":"doc-"+it}]}}]})+"</fake>", "undo": "<fake>"+json.dumps({"turns":[{"output":{"reverted":["doc-"+it],"failed":[]}}]})+"</fake>"}))
`);
  chief.importWorkflow(`
name: mapcomp
inputs: { items: [x, y, z] }
nodes:
  - { id: prep, type: map, over: "{{inputs.items}}", node: { type: script, run: item-directive.py } }
  - id: act
    type: map
    over: "{{nodes.prep.output}}"
    node:
      type: agent
      prompt: 'DO {{item.output.name}} {{item.output.do}}'
      compensate: { prompt: 'UNDO {{item.output.name}} {{item.output.undo}}' }
edges: [prep -> act]
`);
  expect(chief.run(["run", "mapcomp"]).code).toBe(0);
  const n = chief.calls().length;
  const report = chief.run(["revert", "1", "--json"]).json();
  expect(report.compensated).toEqual(["act-item[2]", "act-item[1]", "act-item[0]"]);
  expect(report.reverted_effects).toBe(3);
  expect(report.manual).toEqual([]);
  expect(chief.calls().slice(n).map((c) => c.prompt.slice(0, 6))).toEqual(["UNDO z", "UNDO y", "UNDO x"]);
});

test("E3.3-8 a run cannot be reverted twice or while it is running", async ({ chief }) => {
  chief.importWorkflow(`name: slow\nnodes:\n  - { id: a, type: agent, prompt: 'A ${fake({ sleep_ms: 60000 })}' }\n`);
  const bg = chief.start(["run", "slow"]);
  await chief.until(() => chief.calls().length === 1);
  const r = chief.run(["revert", "1"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("run 1 is running; it cannot be reverted now");
  chief.run(["cancel", "1"]);
  await bg.done;
  expect(chief.run(["revert", "1"]).code).toBe(0);
  expect(chief.run(["revert", "1"]).stderr).toContain("run 1 is reverted; it cannot be reverted now");
  expect(chief.run(["revert", "77"]).stderr).toContain("run 77 not found");
});

const IRREV = (extra = "") => `
name: irrev
nodes:
  - id: send
    type: agent
    irreversible: true${extra}
    prompt: 'Send the announcement ${fake({ output: { side_effects: [eff("slack_message", "C1/55", { irreversible: true })] } })}'
    compensate: { prompt: 'UNDO-SEND ${undo([])}' }
`;

test("E3.4-1 an irreversible node asks for confirmation before it runs", ({ chief }) => {
  chief.importWorkflow(IRREV());
  const d = chief.run(["run", "irrev", "--json"]).json();
  expect(d.run.status).toBe("waiting_gate");
  expect(d.gates[0]).toMatchObject({ kind: "approve", reason: "irreversible", node_id: "send", status: "waiting" });
  expect(d.gates[0].payload.message).toContain("cannot be undone");
  expect(d.gates[0].payload.value).toContain("Send the announcement");
  expect(chief.calls()).toHaveLength(0);
});

test("E3.4-2 approving runs the node; rejecting cancels the run without running it", ({ chief }) => {
  chief.importWorkflow(IRREV());
  chief.run(["run", "irrev"]);
  expect(chief.run(["gate", "approve", "1", "--json"]).json().run.status).toBe("completed");
  expect(chief.calls()).toHaveLength(1);

  chief.run(["run", "irrev"]);
  const rej = chief.run(["gate", "reject", "2", "--json"]);
  expect(rej.code).toBe(2);
  expect(rej.json().run.status).toBe("cancelled");
  expect(chief.calls()).toHaveLength(1);
  expect(rej.json().side_effects).toHaveLength(0);
});

test("E3.4-3 confirm: false skips the confirmation", ({ chief }) => {
  chief.importWorkflow(IRREV("\n    confirm: false"));
  const d = chief.run(["run", "irrev", "--json"]).json();
  expect(d.run.status).toBe("completed");
  expect(d.gates).toHaveLength(0);
  const v = chief.run(["workflow", "validate", "irrev", "--json"]).json();
  expect(v.warnings.join("\n")).toContain("marked irreversible but declares a compensation");
});

test("E3.4-4 an irreversible effect is reported as manual and never marked reverted", ({ chief }) => {
  chief.importWorkflow(IRREV("\n    confirm: false"));
  chief.run(["run", "irrev"]);
  const report = chief.run(["revert", "1", "--json"]).json();
  expect(report.reverted_effects).toBe(0);
  expect(report.manual).toEqual([expect.objectContaining({ node_id: "send", kind: "slack_message", ref: "C1/55", reason: "irreversible" })]);
  expect(show(chief).side_effects[0]).toMatchObject({ irreversible: 1, reverted_at: null });
});

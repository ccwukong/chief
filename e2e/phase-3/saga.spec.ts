import { expect, fake, test } from "../helpers";

const eff = (kind: string, ref: string, extra: object = {}) => ({ kind, ref, url: `https://example.test/${ref}`, how_to_undo: `undo ${ref}`, irreversible: false, ...extra });

test("E3.1-1 side effects reported by a script are recorded in the ledger", ({ chief }) => {
  chief.file("write.py", `import json\nprint(json.dumps({"made": "report.md", "side_effects": [{"kind": "file", "ref": "report.md", "how_to_undo": "delete report.md", "irreversible": False}]}))\n`);
  chief.importWorkflow("name: sfx\nnodes:\n  - { id: s, type: script, run: write.py }\n");
  const d = chief.run(["run", "sfx", "--json"]).json();
  expect(d.side_effects).toHaveLength(1);
  expect(d.side_effects[0]).toMatchObject({ kind: "file", ref: "report.md", how_to_undo: "delete report.md", irreversible: 0 });
});

const IRREV = (extra = "") => `
name: irrev
nodes:
  - id: send
    type: agent
    irreversible: true${extra}
    prompt: 'Send the announcement ${fake({ output: { side_effects: [eff("slack_message", "C1/55", { irreversible: true })] } })}'
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
});

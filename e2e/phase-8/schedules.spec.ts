import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, fake, test, type Chief } from "../helpers";

const WF = `name: tick\ninputs: { who: nobody }\nnodes:\n  - { id: a, type: agent, prompt: 'hello {{inputs.who}}' }\n`;
const notifications = (chief: Chief) => {
  const f = chief.env.CHIEF_NOTIFY_LOG;
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("E8.1-1 schedule add, list, rm; invalid expressions are rejected", ({ chief }) => {
  chief.importWorkflow(WF);
  const added = chief.run(["schedule", "add", "tick", "30  9 * * 1-5", "--inputs-json", '{"who":"team"}', "--json"]);
  expect(added.code, added.stderr).toBe(0);
  expect(added.json()).toMatchObject({ id: 1, cron: "30 9 * * 1-5", enabled: 1, inputs: { who: "team" }, last_run_at: null });
  chief.run(["schedule", "add", "tick", "*/15 * * * *"]);
  const list = chief.run(["schedule", "list", "--json"]).json();
  expect(list.map((s: any) => [s.id, s.workflow_name, s.cron])).toEqual([[1, "tick", "30 9 * * 1-5"], [2, "tick", "*/15 * * * *"]]);
  expect(chief.run(["schedule", "list"]).stdout).toContain("Schedules fire only while `chief serve` is running.");

  for (const [expr, message] of [["* * * *", /5 fields/], ["61 * * * *", /out of range/], ["* 25 * * *", /out of range/], ["a b c d e", /invalid minute field/], ["*/0 * * * *", /invalid step/]] as [string, RegExp][]) {
    const r = chief.run(["schedule", "add", "tick", expr]);
    expect(r.code, expr).toBe(1);
    expect(r.stderr, expr).toMatch(message);
  }
  expect(chief.run(["schedule", "add", "ghost", "* * * * *"]).stderr).toContain('workflow "ghost" not found');
  expect(chief.run(["schedule", "rm", "1"]).code).toBe(0);
  expect(chief.run(["schedule", "rm", "1"]).stderr).toContain("schedule 1 not found");
  expect(chief.run(["schedule", "list", "--json"]).json()).toHaveLength(1);
});

test("E8.1-2 a due schedule starts exactly one run for its minute", async ({ chief }) => {
  chief.importWorkflow(WF);
  chief.run(["schedule", "add", "tick", "30 9 * * 1-5", "--inputs-json", '{"who":"team"}']);  // due
  chief.run(["schedule", "add", "tick", "31 9 * * *"]);                                        // next minute
  chief.run(["schedule", "add", "tick", "30 9 * * 0"]);                                        // Sundays only
  // Tuesday 2026-11-10 09:30 local time.
  const s = await chief.serve({ env: { CHIEF_SCHEDULER_NOW: "2026-11-10T09:30:20", CHIEF_SCHEDULER_TICK_MS: "100" } });
  try {
    await chief.until(async () => (await s.api("GET", "/api/runs")).body[0]?.status === "completed");
    await settle(600); // several more ticks within the same minute
    const runs = (await s.api("GET", "/api/runs")).body;
    expect(runs).toHaveLength(1);
    expect(chief.calls().map((c) => c.prompt.split("\n")[0])).toEqual(["hello team"]);
    const sched = (await s.api("GET", "/api/schedules")).body;
    expect(sched.map((x: any) => x.last_run_at)).toEqual(["2026-11-10T09:30", null, null]);
    const events = (await s.api("GET", `/api/runs/${runs[0].id}/events?format=json`)).body;
    expect(events.find((e: any) => e.type === "scheduled").payload).toEqual({ schedule_id: 1, cron: "30 9 * * 1-5" });
  } finally { await s.stop(); }
});

test("E8.1-3 disabled schedules do not fire, and a restart in the same minute does not fire twice", async ({ chief }) => {
  chief.importWorkflow(WF);
  chief.run(["schedule", "add", "tick", "* * * * *"]);
  chief.run(["schedule", "add", "tick", "* * * * *"]);
  chief.run(["schedule", "disable", "2"]);
  const env = { CHIEF_SCHEDULER_NOW: "2026-11-10T09:30:20", CHIEF_SCHEDULER_TICK_MS: "100" };
  let s = await chief.serve({ env });
  try {
    await chief.until(async () => (await s.api("GET", "/api/runs")).body[0]?.status === "completed");
    await settle(400);
    expect((await s.api("GET", "/api/runs")).body).toHaveLength(1);
  } finally { await s.stop(); }

  s = await chief.serve({ env });
  try {
    await settle(600);
    expect((await s.api("GET", "/api/runs")).body).toHaveLength(1);
    // Enabling over the API works; the next minute fires both. `enabled` is a boolean in the API (15.1
    // made the representation of the row the page's as well).
    expect((await s.api("PATCH", "/api/schedules/2", { enabled: true })).body.enabled).toBe(true);
  } finally { await s.stop(); }

  s = await chief.serve({ env: { ...env, CHIEF_SCHEDULER_NOW: "2026-11-10T09:31:05" } });
  try {
    await chief.until(async () => (await s.api("GET", "/api/runs")).body.length === 3);
    await settle(400);
    expect((await s.api("GET", "/api/runs")).body).toHaveLength(3);
  } finally { await s.stop(); }
});

test("E8.2-1 every gate that opens sends one notification", ({ chief }) => {
  chief.importWorkflow(`
name: notif
budget: { max-usd: 0.05 }
nodes:
  - { id: ask, type: agent, prompt: 'A ${fake({ needs_input: { question: "ok?", proposed: 1 }, cost: 0.01 }, { output: { ok: true }, cost: 0.1 })}' }
  - { id: pick, type: gate, kind: approve, value: x }
  - { id: after, type: agent, prompt: B }
edges: [ask -> pick, pick -> after]
`);
  chief.run(["run", "notif"]);
  expect(notifications(chief)).toEqual([{ gate: 1, run: 1, message: "notif run 1: agent needs input (ask)" }]);
  chief.run(["gate", "approve", "1"]);
  expect(notifications(chief).map((n: any) => n.message)).toEqual(["notif run 1: agent needs input (ask)", "notif run 1: approve gate (pick)"]);
  chief.run(["gate", "approve", "2"]);
  expect(notifications(chief).map((n: any) => n.message)).toEqual(["notif run 1: agent needs input (ask)", "notif run 1: approve gate (pick)", "notif run 1: budget reached"]);
  // Answering does not notify again.
  chief.run(["gate", "approve", "3"]);
  expect(notifications(chief)).toHaveLength(3);
});

test("E8.2-2 the notify setting turns notifications off", ({ chief }) => {
  chief.importWorkflow("name: quiet\nnodes:\n  - { id: g, type: gate, kind: approve, value: x }\n");
  chief.run(["settings", "set", "notify", "false"]);
  expect(chief.run(["run", "quiet", "--json"]).json().run.status).toBe("waiting_gate");
  expect(notifications(chief)).toEqual([]);
  chief.run(["settings", "set", "notify", "true"]);
  chief.run(["run", "quiet"]);
  expect(notifications(chief)).toHaveLength(1);
});

test("E8.3-1 README, workflow guide and adapter notes exist and match the product", ({ chief }) => {
  const root = join(__dirnameCompat(), "../..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  const adapters = ["claude-code", "codex", "cursor", "antigravity", "opencode"];
  for (const f of ["README.md", "docs/workflow-guide.md", ...adapters.map((a) => `docs/adapters/${a}.md`)]) expect(existsSync(join(root, f)), f).toBe(true);
  // Every adapter chief has is documented in the guide, and the guide names no other.
  expect(chief.run(["doctor", "--json"]).json().adapters.map((a: any) => a.name)).toEqual(adapters);
  for (const a of adapters) expect(read("docs/workflow-guide.md"), a).toContain("| `" + a + "` |");

  // Every `chief <command>` shown in the docs is a real command.
  const help = chief.run(["--help"]).stdout;
  const known = new Set(help.split("\n").map((l) => l.match(/^ {2}([a-z]+)\b/)?.[1]).filter(Boolean));
  for (const m of help.match(/^ {2}pause .*$/m)![0].matchAll(/\| ([a-z]+)/g)) known.add(m[1]); // pause | resume | cancel share a line
  // Commands as written in code: after a backtick, or at the start of a line in a code block.
  const used = new Set<string>();
  for (const doc of [read("README.md"), read("docs/workflow-guide.md")]) {
    for (const m of doc.matchAll(/`chief ([a-z]+)\b/g)) used.add(m[1]);
    for (const block of doc.matchAll(/```sh\n([\s\S]*?)```/g)) for (const m of block[1].matchAll(/^chief ([a-z]+)\b/gm)) used.add(m[1]);
  }
  expect(used.size).toBeGreaterThan(8);
  expect([...used].filter((c) => !known.has(c))).toEqual([]);

  // Every node field the guide documents in its field tables is accepted by the schema.
  const guide = read("docs/workflow-guide.md");
  for (const field of ["output-schema", "max-parallel", "on-error", "allowed-tools", "disallowed-tools", "permission-mode", "irreversible", "compensate", "sandbox"]) expect(guide, field).toContain("`" + field + "`");
});

test("E8.3-2 every workflow example in the authoring guide validates", ({ chief }) => {
  const guide = readFileSync(join(__dirnameCompat(), "../../docs/workflow-guide.md"), "utf8");
  const blocks = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => /^name: /m.test(b));
  expect(blocks.length).toBeGreaterThanOrEqual(3);
  for (const block of blocks) {
    const name = block.match(/^name: (\S+)/m)![1];
    const r = chief.run(["workflow", "validate", chief.file(`${name}.yaml`, block), "--json"]);
    expect(r.json().errors, name).toEqual([]);
    expect(r.code, name).toBe(0);
  }
});

function __dirnameCompat() { return new URL(".", import.meta.url).pathname; }

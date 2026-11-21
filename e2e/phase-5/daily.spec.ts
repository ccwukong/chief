import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { EXAMPLES, expect, test, type Chief } from "../helpers";

const show = (chief: Chief, id = 1) => chief.run(["runs", "show", String(id), "--json"]).json();
const flagValues = (argv: string[], flag: string) => {
  const out: string[] = [];
  for (let k = argv.indexOf(flag) + 1; k > 0 && k < argv.length && !argv[k].startsWith("--"); k++) out.push(argv[k]);
  return out;
};

const ITEMS = [
  { title: "Review PR 12", kind: "code-review", priority: "P1", url: "https://example.test/pr/12" },
  { title: "Write ADR", kind: "doc", priority: "P2", url: "https://example.test/adr" },
  { title: "Fix prod alert", kind: "other", priority: "P0", url: "https://example.test/alert" },
];

test("E5.2-1 the shipped examples import and validate against the discovered servers", ({ chief }) => {
  for (const name of ["daily-slack", "daily-github", "daily-jira"]) {
    const imp = chief.run(["workflow", "import", join(EXAMPLES, `${name}.yaml`), "--json"]);
    expect(imp.code, imp.stdout + imp.stderr).toBe(0);
    expect(imp.json()).toMatchObject({ name, version: 1, approvals: [] });
    const v = chief.run(["workflow", "validate", name, "--json"]).json();
    expect(v, name).toMatchObject({ ok: true, errors: [], environment: [] });
    expect(v.estimates.map((e: any) => e.node_id)).toEqual(["plan", "act"]);
  }
  // The entry node differs per example; nothing in the engine is Slack-specific.
  const entry = (n: string) => YAML.parse(readFileSync(join(EXAMPLES, `${n}.yaml`), "utf8")).nodes[0].mcp;
  expect([entry("daily-slack"), entry("daily-github"), entry("daily-jira")]).toEqual([["slack"], ["github"], ["atlassian"]]);
});

/** Scripted replies for the example's prompts, which carry no test directives. */
function rules(chief: Chief, extra: object[] = []) {
  return {
    FAKE_CLAUDE_RULES: chief.file("rules.json", JSON.stringify([
      { match: "Summarise what happened in my Slack", turns: [{ output: { summary: "Busy day.", items: ITEMS }, cost: 0.2 }] },
      ...extra,
      { match: '"title": "Review PR 12"', turns: [
        { needs_input: { question: "Post this review on PR 12?", proposed: "LGTM, two nits." } },
        { output: { result: "review posted", side_effects: [{ kind: "github_review", ref: "pr-12/r1", url: "https://example.test/pr/12#r1", how_to_undo: "dismiss the review" }] } },
      ] },
      { match: '"title": "Write ADR"', turns: [{ output: { result: "drafted", side_effects: [{ kind: "google_doc", ref: "doc-1", url: "https://example.test/doc-1", how_to_undo: "trash the doc" }] } }] },
      { match: '"title": "Fix prod alert"', turns: [{ output: { result: "look at the dashboard" } }] },
    ])),
  };
}

function startDaily(chief: Chief, env: Record<string, string>) {
  expect(chief.run(["workflow", "import", join(EXAMPLES, "daily-slack.yaml")]).code).toBe(0);
  const r = chief.run(["run", "daily-slack", "--json"], { env });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  return r.json();
}

test("E5.2-2 daily-slack runs end to end: plan, select, act with a review question, feedback", ({ chief }) => {
  const env = rules(chief);
  let d = startDaily(chief, env);
  expect(d.run.status).toBe("waiting_gate");
  expect(d.gates[0]).toMatchObject({ kind: "select", node_id: "choose" });
  expect(d.gates[0].payload.items).toHaveLength(3);
  // The plan node may only use Slack.
  const plan = chief.calls()[0];
  expect(flagValues(plan.argv, "--allowedTools")).toEqual(["mcp__claude_ai_Slack"]);
  expect(flagValues(plan.argv, "--model")).toEqual(["sonnet"]);
  expect(plan.prompt).toContain("in the last 24 hours");

  d = chief.run(["gate", "answer", "1", '{"mode":"one-by-one","selected":[0,1]}', "--json"], { env }).json();
  expect(d.run.status).toBe("waiting_gate");
  const ask = d.gates.find((g: any) => g.status === "waiting");
  expect(ask).toMatchObject({ kind: "approve", reason: "needs_input", payload: { message: "Post this review on PR 12?", value: "LGTM, two nits." } });
  // What was not picked stays in the gate's output.
  expect(d.node_runs.find((n: any) => n.node_id === "choose").output.unselected.map((i: any) => i.title)).toEqual(["Fix prod alert"]);
  const act = chief.calls()[1];
  expect(flagValues(act.argv, "--allowedTools").sort()).toEqual(["mcp__claude_ai_Atlassian", "mcp__claude_ai_GitHub_Custom", "mcp__claude_ai_Google_Drive"]);
  expect(flagValues(act.argv, "--disallowedTools")).toContain("mcp__claude_ai_Slack");

  d = chief.run(["gate", "approve", String(ask.id), "--json"], { env }).json();
  expect(d.run.status).toBe("waiting_gate");
  const fb = d.gates.find((g: any) => g.status === "waiting");
  expect(fb).toMatchObject({ kind: "input", node_id: "feedback", payload: { options: ["done", "restart"] } });
  expect(fb.payload.summary.map((r: any) => [r.item.title, r.status, r.output.result])).toEqual([["Review PR 12", "completed", "review posted"], ["Write ADR", "completed", "drafted"]]);
  expect(d.side_effects.map((e: any) => e.kind)).toEqual(["github_review", "google_doc"]);

  d = chief.run(["gate", "answer", String(fb.id), '{"text":"all good","option":"done"}', "--json"], { env }).json();
  expect(d.run.status).toBe("completed");
  expect(d.run.cost_usd).toBeGreaterThan(0.2);
  expect(chief.run(["runs", "list", "--json"]).json()).toHaveLength(1);
});

test("E5.3-1 answering restart starts a new run that carries over feedback and unfinished items", ({ chief }) => {
  // The ADR item fails this time, so it is unfinished.
  const env = rules(chief, [{ match: '"title": "Write ADR"', turns: [{ error: true }] }]);
  startDaily(chief, env);
  chief.run(["gate", "answer", "1", '{"mode":"one-by-one","selected":[1,2]}'], { env });
  const d = show(chief);
  const fb = d.gates.find((g: any) => g.status === "waiting");
  expect(fb.node_id).toBe("feedback");
  expect(fb.payload.summary.map((r: any) => r.status)).toEqual(["failed", "completed"]);

  const r = chief.run(["gate", "answer", String(fb.id), '{"text":"try the ADR again, shorter","option":"restart"}', "--json"], { env });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.json().run).toMatchObject({ id: 1, status: "completed" });

  const runs = chief.run(["runs", "list", "--json"]).json();
  expect(runs.map((x: any) => [x.id, x.status, x.parent_run_id])).toEqual([[2, "waiting_gate", 1], [1, "completed", null]]);
  const second = show(chief, 2);
  expect(second.run.inputs["carry-over"]).toEqual({ "from-run": 1, feedback: "try the ADR again, shorter", items: [ITEMS[1]] });
  const replan = chief.calls().filter((c) => c.prompt.includes("Summarise what happened in my Slack")).at(-1)!;
  expect(replan.prompt).toContain("try the ADR again, shorter");
  expect(replan.prompt).toContain('"title": "Write ADR"');
  expect(second.gates[0]).toMatchObject({ kind: "select", status: "waiting" });
  expect(chief.run(["runs", "tail", "1", "--json"]).stdout).toContain('"type":"restarted"');
});

test("E5.3-2 answering done does not start a new run", ({ chief }) => {
  const env = rules(chief);
  startDaily(chief, env);
  chief.run(["gate", "answer", "1", '{"mode":"one-by-one","selected":[2]}'], { env });
  const fb = show(chief).gates.find((g: any) => g.status === "waiting");
  const d = chief.run(["gate", "answer", String(fb.id), '{"option":"done"}', "--json"], { env }).json();
  expect(d.run.status).toBe("completed");
  expect(chief.run(["runs", "list", "--json"]).json()).toHaveLength(1);
  expect(chief.run(["gate", "list", "--json"]).json()).toEqual([]);
});

test("E5.4-1 @real the daily-slack plan node against the real Slack connector (read-only)", ({ chief }) => {
  test.setTimeout(600_000);
  const env = { CHIEF_CLAUDE_BIN: "claude" };
  // Only the plan node of the shipped example: the later nodes write, and need a person at the gates.
  const example = YAML.parse(readFileSync(join(EXAMPLES, "daily-slack.yaml"), "utf8"));
  const planOnly = { name: "daily-slack-plan", inputs: { ...example.inputs, "lookback-hours": 8 }, budget: { "max-usd": 1 }, nodes: [example.nodes[0]] };
  expect(chief.run(["workflow", "import", chief.file("plan.yaml", YAML.stringify(planOnly))]).code).toBe(0);
  const r = chief.run(["run", "daily-slack-plan", "--json"], { env });
  expect(r.code, r.stdout.slice(0, 2000) + r.stderr).toBe(0);
  const d = r.json();
  expect(d.run.status).toBe("completed");
  const out = d.node_runs[0].output;
  expect(typeof out.summary).toBe("string");
  expect(out.summary.length).toBeGreaterThan(20);
  expect(Array.isArray(out.items)).toBe(true);
  for (const it of out.items) expect(["P0", "P1", "P2", "P3"]).toContain(it.priority);
  // Read-only: no writes reported, and only Slack tools were used.
  expect(out.side_effects).toEqual([]);
  expect(d.side_effects).toEqual([]);
  const tools: string[] = chief.run(["runs", "tail", "1", "--json"]).stdout.trim().split("\n").map((l) => JSON.parse(l)).filter((e: any) => e.type === "agent_tool").map((e: any) => e.payload.name);
  expect(tools.some((t) => t.startsWith("mcp__claude_ai_Slack__"))).toBe(true);
  expect(tools.filter((t) => t.startsWith("mcp__") && !t.startsWith("mcp__claude_ai_Slack__"))).toEqual([]);
  expect(tools.filter((t) => /send|schedule|create|update|add_|upload|canvas|draft/i.test(t))).toEqual([]);
  console.log(`E5.4-1: ${out.items.length} action items, ${tools.length} tool calls, $${d.run.cost_usd.toFixed(4)}`);
});

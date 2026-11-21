import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, fake, FAKE_ANTIGRAVITY, FAKE_CODEX, FAKE_CURSOR, FAKE_HERMES, FAKE_OPENCODE, test, type Chief } from "../helpers";

/** Every adapter other than Claude Code, pointed at its fake CLI. */
const BOTH = { CHIEF_CODEX_BIN: FAKE_CODEX, CHIEF_CURSOR_BIN: FAKE_CURSOR, CHIEF_ANTIGRAVITY_BIN: FAKE_ANTIGRAVITY, CHIEF_OPENCODE_BIN: FAKE_OPENCODE, CHIEF_HERMES_BIN: FAKE_HERMES };
const show = (chief: Chief, id = 1) => chief.run(["runs", "show", String(id), "--json"]).json();
const values = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

function codexConfig(chief: Chief) {
  mkdirSync(chief.env.CODEX_HOME, { recursive: true });
  writeFileSync(join(chief.env.CODEX_HOME, "config.toml"), `
model = "gpt-5"

[mcp_servers.github]
url = "https://api.githubcopilot.com/mcp"
bearer_token_env_var = "GITHUB_TOKEN"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp_servers.old_thing]
command = "old"
enabled = false
`);
}
function cursorConfig(chief: Chief) {
  mkdirSync(chief.env.CURSOR_CONFIG_HOME, { recursive: true });
  writeFileSync(join(chief.env.CURSOR_CONFIG_HOME, "mcp.json"), JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" }, files: { command: "npx", args: ["files-mcp"] } } }));
}
function agyConfig(chief: Chief) {
  writeFileSync(chief.env.FAKE_AGY_MCP, JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" }, files: { command: "npx", args: ["files-mcp"] }, old: { command: "old", disabled: true } } }));
}
function opencodeConfig(chief: Chief) {
  writeFileSync(chief.env.OPENCODE_CONFIG, JSON.stringify({ mcp: {
    github: { type: "remote", url: "https://api.githubcopilot.com/mcp" },
    context7: { type: "local", command: ["npx", "-y", "@upstash/context7-mcp"] },
    broken: { type: "remote", url: "https://example.invalid/mcp", fake_status: "failed" },
    old: { type: "local", command: ["old"], enabled: false },
  } }));
}
function hermesConfig(chief: Chief) {
  mkdirSync(chief.env.HERMES_HOME, { recursive: true });
  writeFileSync(join(chief.env.HERMES_HOME, "config.yaml"), `
mcp_servers:
  linear:
    url: https://mcp.linear.app/mcp
  files:
    command: npx
    args: ["files-mcp"]
  old:
    command: old
    enabled: false
`);
}

test("E7.1-1 a Codex agent node completes with session, usage and per-run MCP scoping", ({ chief }) => {
  codexConfig(chief);
  expect(chief.run(["mcp", "list", "--json"], { env: BOTH }).json().filter((s: any) => s.adapter === "codex")).toHaveLength(3);
  chief.importWorkflow(`
name: cx
agent: codex
nodes:
  - id: a
    type: agent
    mcp: [github]
    model: gpt-5-codex
    prompt: 'Summarise ${fake({ output: { summary: "from codex" }, tokens: { in: 900, out: 80 } })}'
    output-schema: { summary: string }
`);
  const r = chief.run(["run", "cx", "--json"], { env: BOTH });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const n = r.json().node_runs[0];
  const call = chief.calls()[0];
  expect(call.cli).toBe("codex");
  expect(n).toMatchObject({ status: "completed", output: { summary: "from codex" }, session_id: call.session, usage: { input_tokens: 900, output_tokens: 80, cost_usd: 0, model: "gpt-5-codex", invocations: 1 } });
  expect(call.argv.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
  expect(call.argv.at(-1)).toBe("-");
  expect(values(call.argv, "-m")).toEqual(["gpt-5-codex"]);
  expect(values(call.argv, "-c").sort()).toEqual(["mcp_servers.context7.enabled=false", "mcp_servers.github.enabled=true", "mcp_servers.old_thing.enabled=false"]);
  expect(call.argv).not.toContain("--sandbox");
  expect(call.prompt).toContain("Output contract");
  expect(call.argv.join(" ")).not.toContain("Summarise");
});

test("E7.1-2 Codex: needs_input and pause both resume the same thread", async ({ chief }) => {
  chief.importWorkflow(`
name: cx2
agent: codex
nodes:
  - { id: ask, type: agent, prompt: 'A ${fake({ needs_input: { question: "go?", proposed: "x" } }, { output: { ok: 1 } })}' }
  - { id: slow, type: agent, tools: default, prompt: 'S ${fake({ sleep_ms: 60000 }, { output: { ok: 2 } })}' }
edges: [ask -> slow]
`);
  chief.run(["run", "cx2"], { env: BOTH });
  const first = chief.calls()[0];
  const bg = chief.start(["gate", "approve", "1"], { env: BOTH });
  await chief.until(() => chief.calls().length === 3 && show(chief).node_runs[1]?.session_id);
  expect(chief.calls()[1].argv.slice(0, 3)).toEqual(["exec", "resume", first.session]);
  expect(chief.calls()[1].prompt).toContain("The user approved.");
  expect(chief.calls()[2].argv).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));

  chief.run(["pause", "1"], { env: BOTH });
  await bg.done;
  expect(show(chief).node_runs[1]).toMatchObject({ status: "interrupted", session_id: chief.calls()[2].session });
  const d = chief.run(["resume", "1", "--json"], { env: BOTH }).json();
  expect(d.run.status).toBe("completed");
  expect(chief.calls()[3].argv.slice(0, 3)).toEqual(["exec", "resume", chief.calls()[2].session]);
});

test("E7.1-3 @real Codex CLI", ({ chief }) => {
  test.skip(spawnSync("which", ["codex"]).status !== 0, "Codex CLI is not installed");
  chief.importWorkflow("name: real-codex\nagent: codex\nnodes:\n  - { id: a, type: agent, prompt: 'Reply with the JSON object {\"greeting\": \"hello\"}. Do not run any command.', output-schema: { greeting: string } }\n");
  const r = chief.run(["run", "real-codex", "--json"], { env: { CHIEF_CODEX_BIN: "codex" } });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.json().node_runs[0].output.greeting).toBe("hello");
});

test("E7.2-1 a Cursor agent node completes with session and MCP note", ({ chief }) => {
  cursorConfig(chief);
  expect(chief.run(["mcp", "list", "--json"], { env: BOTH }).json().filter((s: any) => s.adapter === "cursor")).toHaveLength(2);
  chief.importWorkflow(`
name: cu
agent: cursor
nodes:
  - id: a
    type: agent
    mcp: [linear]
    model: gpt-5
    prompt: 'Summarise ${fake({ output: { summary: "from cursor" } })}'
`);
  const r = chief.run(["run", "cu", "--json"], { env: BOTH });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const n = r.json().node_runs[0];
  const call = chief.calls()[0];
  expect(call.cli).toBe("cursor");
  expect(n).toMatchObject({ status: "completed", output: { summary: "from cursor" }, session_id: call.session, usage: { cost_usd: 0, input_tokens: 0, model: "gpt-5" } });
  expect(call.argv).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--trust", "--approve-mcps"]));
  expect(values(call.argv, "--model")).toEqual(["gpt-5"]);
  expect(values(call.argv, "--workspace")).toEqual([chief.dir]);
  expect(call.argv).not.toContain("--force");
  expect(call.prompt).toContain("You may use only these MCP servers: linear.");
  // The prompt is kept out of the run log.
  const inv = chief.run(["runs", "tail", "1", "--json"]).stdout.trim().split("\n").map((l) => JSON.parse(l)).find((e: any) => e.type === "agent_invocation");
  expect(JSON.stringify(inv.payload.args)).not.toContain("Summarise");
});

test("E7.2-2 Cursor: needs_input and pause both resume the same chat", async ({ chief }) => {
  chief.importWorkflow(`
name: cu2
agent: cursor
nodes:
  - { id: ask, type: agent, mcp: [], prompt: 'A ${fake({ needs_input: { question: "go?", proposed: "x" } }, { output: { ok: 1 } })}' }
  - { id: slow, type: agent, tools: [Bash], prompt: 'S ${fake({ sleep_ms: 60000 }, { output: { ok: 2 } })}' }
edges: [ask -> slow]
`);
  chief.run(["run", "cu2"], { env: BOTH });
  const first = chief.calls()[0];
  expect(first.prompt).toContain("Do not call any MCP server tools");
  const bg = chief.start(["gate", "approve", "1"], { env: BOTH });
  await chief.until(() => chief.calls().length === 3 && show(chief).node_runs[1]?.session_id);
  expect(values(chief.calls()[1].argv, "--resume")).toEqual([first.session]);
  expect(chief.calls()[2].argv).toContain("--force");
  chief.run(["pause", "1"], { env: BOTH });
  await bg.done;
  const d = chief.run(["resume", "1", "--json"], { env: BOTH }).json();
  expect(d.run.status).toBe("completed");
  expect(values(chief.calls()[3].argv, "--resume")).toEqual([chief.calls()[2].session]);
});

test("E7.2-3 @real Cursor CLI", ({ chief }) => {
  test.skip(spawnSync("which", ["cursor-agent"]).status !== 0, "cursor-agent is not installed");
  chief.importWorkflow("name: real-cursor\nagent: cursor\nnodes:\n  - { id: a, type: agent, prompt: 'Reply with the JSON object {\"greeting\": \"hello\"}. Do not run any command.', output-schema: { greeting: string } }\n");
  const r = chief.run(["run", "real-cursor", "--json"], { env: { CHIEF_CURSOR_BIN: "cursor-agent" } });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.json().node_runs[0].output.greeting).toBe("hello");
});

test("E7.4-1 an Antigravity agent node completes with conversation, usage, stdin prompt and MCP note", ({ chief }) => {
  agyConfig(chief);
  const servers = chief.run(["mcp", "list", "--json"], { env: BOTH }).json().filter((s: any) => s.adapter === "antigravity");
  expect(servers.map((s: any) => [s.name, s.config.status])).toEqual([["files", "configured"], ["linear", "configured"], ["old", "disabled"]]);
  chief.importWorkflow(`
name: ag
agent: antigravity
nodes:
  - id: a
    type: agent
    mcp: [linear]
    model: gemini-3.8-flash-low
    prompt: 'Summarise ${fake({ output: { summary: "from agy" }, tokens: { in: 900, out: 80 } })}'
    output-schema: { summary: string }
`);
  const r = chief.run(["run", "ag", "--json"], { env: BOTH });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const n = r.json().node_runs[0];
  const call = chief.calls()[0];
  expect(call.cli).toBe("antigravity");
  expect(n).toMatchObject({ status: "completed", output: { summary: "from agy" }, session_id: call.session, usage: { input_tokens: 900, output_tokens: 85, cache_read_tokens: 40, cost_usd: 0, model: "gemini-3.8-flash-low", invocations: 1 } });
  expect(call.argv.slice(0, 5)).toEqual(["--print=", "--input-format", "stream-json", "--output-format", "stream-json"]);
  expect(values(call.argv, "--model")).toEqual(["gemini-3.8-flash-low"]);
  expect(values(call.argv, "--mode")).toEqual(["plan"]);
  expect(call.argv).not.toContain("--conversation");
  expect(call.prompt).toContain("Output contract");
  expect(call.prompt).toContain("You may use only these MCP servers: linear.");
  expect(call.argv.join(" ")).not.toContain("Summarise");
  // The models come from `agy models`.
  expect(chief.run(["models", "--adapter", "antigravity", "--json"], { env: BOTH }).json().models.map((m: any) => m.value)).toEqual(["gemini-3.8-flash-low", "gemini-4-neon-high"]);
});

test("E7.4-2 Antigravity: needs_input and pause both resume the same conversation; an error result fails the node", async ({ chief }) => {
  chief.importWorkflow(`
name: ag2
agent: antigravity
nodes:
  - { id: ask, type: agent, mcp: [], prompt: 'A ${fake({ needs_input: { question: "go?", proposed: "x" } }, { output: { ok: 1 } })}' }
  - { id: slow, type: agent, tools: default, prompt: 'S ${fake({ sleep_ms: 60000 }, { output: { ok: 2 } })}' }
edges: [ask -> slow]
`);
  chief.run(["run", "ag2"], { env: BOTH });
  const first = chief.calls()[0];
  expect(first.prompt).toContain("Do not call any MCP server tools");
  const bg = chief.start(["gate", "approve", "1"], { env: BOTH });
  await chief.until(() => chief.calls().length === 3 && show(chief).node_runs[1]?.session_id);
  expect(values(chief.calls()[1].argv, "--conversation")).toEqual([first.session]);
  expect(chief.calls()[1].prompt).toContain("The user approved.");
  expect(values(chief.calls()[2].argv, "--mode")).toEqual(["auto"]);
  chief.run(["pause", "1"], { env: BOTH });
  await bg.done;
  expect(show(chief).node_runs[1]).toMatchObject({ status: "interrupted", session_id: chief.calls()[2].session });
  const d = chief.run(["resume", "1", "--json"], { env: BOTH }).json();
  expect(d.run.status).toBe("completed");
  expect(values(chief.calls()[3].argv, "--conversation")).toEqual([chief.calls()[2].session]);

  chief.importWorkflow(`name: ag3\nagent: antigravity\nnodes:\n  - { id: a, type: agent, prompt: 'E ${fake({ error: true })}' }\n`);
  const e = chief.run(["run", "ag3", "--json"], { env: BOTH });
  expect(e.stdout + e.stderr).toContain("simulated agent error");
});

test("E7.4-3 @real Antigravity CLI", ({ chief }) => {
  test.skip(spawnSync("which", ["agy"]).status !== 0, "agy is not installed");
  chief.importWorkflow("name: real-agy\nagent: antigravity\nnodes:\n  - { id: a, type: agent, model: gemini-3.8-flash-low, prompt: 'Reply with the JSON object {\"greeting\": \"hello\"}. Do not run any command.', output-schema: { greeting: string } }\n");
  const r = chief.run(["run", "real-agy", "--json"], { env: { CHIEF_ANTIGRAVITY_BIN: "agy" } });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.json().node_runs[0].output.greeting).toBe("hello");
});

test("E7.5-1 an OpenCode agent node completes with session, usage, cost and per-run MCP scoping", ({ chief }) => {
  opencodeConfig(chief);
  const servers = chief.run(["mcp", "list", "--json"], { env: BOTH }).json().filter((s: any) => s.adapter === "opencode");
  expect(servers.map((s: any) => [s.name, s.config.status])).toEqual([["broken", "failed"], ["context7", "connected"], ["github", "connected"], ["old", "disabled"]]);
  chief.importWorkflow(`
name: oc
agent: opencode
nodes:
  - id: a
    type: agent
    mcp: [github]
    model: opencode/big-pickle
    prompt: 'Summarise ${fake({ output: { summary: "from opencode" }, tokens: { in: 900, out: 80 } })}'
    output-schema: { summary: string }
`);
  const r = chief.run(["run", "oc", "--json"], { env: BOTH });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const n = r.json().node_runs[0];
  const call = chief.calls()[0];
  expect(call.cli).toBe("opencode");
  expect(n).toMatchObject({ status: "completed", output: { summary: "from opencode" }, session_id: call.session, usage: { input_tokens: 950, output_tokens: 85, cache_read_tokens: 10, model: "opencode/big-pickle", invocations: 1 } });
  expect(n.usage.cost_usd).toBeCloseTo(0.003, 6);
  expect(call.argv.slice(0, 3)).toEqual(["run", "--format", "json"]);
  expect(values(call.argv, "-m")).toEqual(["opencode/big-pickle"]);
  expect(values(call.argv, "--agent")).toEqual(["plan"]);
  expect(call.argv).not.toContain("--auto");
  expect(call.argv).not.toContain("-s");
  // Every server the node did not ask for is switched off for this run only.
  expect(JSON.parse(call.config_content)).toEqual({ mcp: { broken: { enabled: false }, context7: { enabled: false }, old: { enabled: false } } });
  expect(call.prompt).toContain("Output contract");
  expect(call.argv.join(" ")).not.toContain("Summarise");
  expect(chief.run(["models", "--adapter", "opencode", "--json"], { env: BOTH }).json().models.map((m: any) => m.value)).toEqual(["opencode/big-pickle", "anthropic/claude-sonnet-5-5"]);
});

test("E7.5-2 OpenCode: needs_input and pause both resume the same session; an error event fails the node", async ({ chief }) => {
  chief.importWorkflow(`
name: oc2
agent: opencode
nodes:
  - { id: ask, type: agent, prompt: 'A ${fake({ needs_input: { question: "go?", proposed: "x" } }, { output: { ok: 1 } })}' }
  - { id: slow, type: agent, tools: default, prompt: 'S ${fake({ sleep_ms: 60000 }, { output: { ok: 2 } })}' }
edges: [ask -> slow]
`);
  chief.run(["run", "oc2"], { env: BOTH });
  const first = chief.calls()[0];
  // Not restricted: no config override.
  expect(first.config_content).toBeNull();
  const bg = chief.start(["gate", "approve", "1"], { env: BOTH });
  await chief.until(() => chief.calls().length === 3 && show(chief).node_runs[1]?.session_id);
  expect(values(chief.calls()[1].argv, "-s")).toEqual([first.session]);
  expect(chief.calls()[1].prompt).toContain("The user approved.");
  expect(chief.calls()[2].argv).toContain("--auto");
  chief.run(["pause", "1"], { env: BOTH });
  await bg.done;
  expect(show(chief).node_runs[1]).toMatchObject({ status: "interrupted", session_id: chief.calls()[2].session });
  const d = chief.run(["resume", "1", "--json"], { env: BOTH }).json();
  expect(d.run.status).toBe("completed");
  expect(values(chief.calls()[3].argv, "-s")).toEqual([chief.calls()[2].session]);

  chief.importWorkflow(`name: oc3\nagent: opencode\nnodes:\n  - { id: a, type: agent, prompt: 'E ${fake({ error: true })}' }\n`);
  const e = chief.run(["run", "oc3", "--json"], { env: BOTH });
  expect(e.stdout + e.stderr).toContain("simulated agent error");
});

test("E7.5-3 @real OpenCode CLI", ({ chief }) => {
  test.skip(spawnSync("which", ["opencode"]).status !== 0, "opencode is not installed");
  writeFileSync(chief.env.OPENCODE_CONFIG, "{}");
  chief.importWorkflow("name: real-oc\nagent: opencode\nnodes:\n  - { id: a, type: agent, model: opencode/big-pickle, prompt: 'Reply with the JSON object {\"greeting\": \"hello\"}. Do not run any command.', output-schema: { greeting: string } }\n");
  const r = chief.run(["run", "real-oc", "--json"], { env: { CHIEF_OPENCODE_BIN: "opencode" } });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(r.json().node_runs[0].output.greeting).toBe("hello");
});

/** The same workflow on every adapter must behave the same. */
const ADAPTERS = ["claude-code", "codex", "cursor", "antigravity", "opencode", "hermes"];
const conformance = (adapter: string) => `
name: conf-${adapter}
agent: ${adapter}
inputs: { items: [one, two] }
nodes:
  - id: plan
    type: agent
    prompt: 'plan ${fake({ output: { items: ["one", "two"], side_effects: [{ kind: "doc", ref: "plan-doc" }] } })}'
    output-schema: { items: [string] }
    compensate: { prompt: 'UNDO-PLAN ${fake({ output: { reverted: ["plan-doc"], failed: [] } })}' }
  - { id: ok, type: gate, kind: approve, value: "{{nodes.plan.output.items}}" }
  - id: act
    type: map
    over: "{{nodes.ok.output.value}}"
    node:
      type: agent
      prompt: 'act on {{item}} ${fake({ needs_input: { question: "write it?", proposed: "text" } }, { text: "oops, no json" }, { output: { done: true, side_effects: [{ kind: "comment", ref: "c", irreversible: true }] } })}'
edges: [plan -> ok, ok -> act]
`;

function runConformance(chief: Chief, adapter: string) {
  expect(chief.importWorkflow(conformance(adapter)).code).toBe(0);
  const name = `conf-${adapter}`;
  const start = chief.run(["run", name, "--json"], { env: BOTH }).json();
  const id = start.run.id;
  const trace: string[] = [start.run.status];
  for (let guard = 0; guard < 10; guard++) {
    const waiting = show(chief, id).gates.filter((g: any) => g.status === "waiting");
    if (!waiting.length) break;
    chief.run(["gate", "approve", String(waiting[0].id)], { env: BOTH });
    trace.push(show(chief, id).run.status);
  }
  const done = show(chief, id);
  const report = chief.run(["revert", String(id), "--json"], { env: BOTH }).json();
  const final = show(chief, id);
  return {
    trace,
    nodes: done.node_runs.map((n: any) => [n.node_id, n.item_index, n.status, n.output && (n.output.done ?? n.output.items ?? n.output.value ?? n.output.length)]),
    gates: done.gates.map((g: any) => [g.kind, g.reason, g.status]),
    invocations: done.node_runs.map((n: any) => n.usage?.invocations ?? null),
    effects: final.side_effects.map((e: any) => [e.kind, e.ref, e.irreversible, !!e.reverted_at]),
    report: { compensated: report.compensated, reverted: report.reverted_effects, manual: report.manual.map((m: any) => [m.node_id, m.item_index, m.reason]) },
    status: final.run.status,
    sessionsResumed: chief.calls().filter((c) => c.resume).length,
  };
}

test("E7.3-1 conformance: the same workflow behaves identically on every adapter", ({ chief }) => {
  test.setTimeout(120_000);
  const results: Record<string, any> = {};
  let seen = 0;
  for (const adapter of ADAPTERS) {
    const r = runConformance(chief, adapter);
    // sessionsResumed is cumulative in the shared log; make it per adapter.
    results[adapter] = { ...r, sessionsResumed: r.sessionsResumed - seen };
    seen = r.sessionsResumed;
  }
  const expected = {
    trace: ["waiting_gate", "waiting_gate", "waiting_gate", "completed"],
    nodes: [["plan", null, "completed", ["one", "two"]], ["ok", null, "completed", ["one", "two"]], ["act", null, "completed", 2], ["act-item", 0, "completed", true], ["act-item", 1, "completed", true]],
    gates: [["approve", "node", "consumed"], ["approve", "needs_input", "consumed"], ["approve", "needs_input", "consumed"]],
    invocations: [1, null, null, 3, 3],
    effects: [["doc", "plan-doc", 0, true], ["comment", "c", 1, false], ["comment", "c", 1, false]],
    report: { compensated: ["plan"], reverted: 1, manual: [["act-item", 1, "irreversible"], ["act-item", 0, "irreversible"]] },
    status: "reverted",
    sessionsResumed: 4,
  };
  for (const adapter of ADAPTERS) expect(results[adapter], adapter).toEqual(expected);
});

test("E7.3-2 doctor and mcp discover report each adapter separately", ({ chief }) => {
  codexConfig(chief);
  cursorConfig(chief);
  agyConfig(chief);
  opencodeConfig(chief);
  hermesConfig(chief);
  const doc = chief.run(["doctor", "--json"], { env: BOTH }).json();
  expect(doc.adapters.map((a: any) => [a.name, a.found, a.version])).toEqual([["claude-code", true, "2.1.311"], ["codex", true, "0.63.0"], ["cursor", true, "2026.10.28-1a2b3c4"], ["antigravity", true, "1.5.11"], ["opencode", true, "1.18.31"], ["hermes", true, "0.21.3"]]);
  expect(doc.adapters[1].note).toContain("not verified");
  expect(doc.adapters[5].note).toContain("not verified");
  const none = chief.run(["doctor", "--json"]).json();
  expect(none.ok).toBe(true);
  expect(none.adapters.map((a: any) => a.found)).toEqual([true, false, false, false, false, false]);

  const list = chief.run(["mcp", "list", "--json"], { env: BOTH }).json();
  expect(list.filter((s: any) => s.adapter === "claude-code")).toHaveLength(5);
  expect(list.filter((s: any) => s.adapter === "codex").map((s: any) => [s.name, s.config.status])).toEqual([["context7", "configured"], ["github", "configured"], ["old-thing", "disabled"]]);
  expect(list.filter((s: any) => s.adapter === "cursor").map((s: any) => s.name)).toEqual(["files", "linear"]);
  expect(list.filter((s: any) => s.adapter === "antigravity").map((s: any) => [s.name, s.config.status])).toEqual([["files", "configured"], ["linear", "configured"], ["old", "disabled"]]);
  expect(list.filter((s: any) => s.adapter === "opencode").map((s: any) => [s.name, s.config.status])).toEqual([["broken", "failed"], ["context7", "connected"], ["github", "connected"], ["old", "disabled"]]);
  expect(list.filter((s: any) => s.adapter === "hermes").map((s: any) => [s.name, s.config.status])).toEqual([["files", "configured"], ["linear", "configured"], ["old", "disabled"]]);
  // A server name is resolved per adapter: `github` is Codex's own, not Claude Code's connector.
  chief.importWorkflow("name: per\nagent: codex\nnodes:\n  - { id: a, type: agent, mcp: [linear], prompt: x }\n");
  expect(chief.run(["run", "per"], { env: BOTH }).stderr).toContain('codex has no MCP server named "linear" (it has: context7, github, old-thing)');
  // A server that is switched off in the CLI's own config stops the run with that reason.
  chief.importWorkflow("name: off\nagent: codex\nnodes:\n  - { id: a, type: agent, mcp: [old-thing], prompt: x }\n");
  expect(chief.run(["run", "off"], { env: BOTH }).stderr).toContain('codex is not connected to MCP server "old_thing": it is disabled');
  // Without the CLIs installed, their servers are not listed.
  expect(chief.run(["mcp", "list", "--json"]).json().map((s: any) => s.adapter)).toEqual(Array(5).fill("claude-code"));
});

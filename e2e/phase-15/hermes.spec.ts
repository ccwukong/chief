import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, fake, FAKE_HERMES, test, type Chief } from "../helpers";

/** The Hermes adapter, pointed at its fake CLI. */
const HERMES = { CHIEF_HERMES_BIN: FAKE_HERMES };
const show = (chief: Chief, id = 1) => chief.run(["runs", "show", String(id), "--json"]).json();
const values = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));

/** `~/.hermes/config.yaml` (HERMES_HOME in the test), the only place Hermes keeps its MCP servers. */
function hermesConfig(chief: Chief) {
  mkdirSync(chief.env.HERMES_HOME, { recursive: true });
  writeFileSync(join(chief.env.HERMES_HOME, "config.yaml"), `
model:
  default: anthropic/claude-sonnet-4.6
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

test("E15.35-1 a Hermes agent node completes with session, usage and the reply from the result record", ({ chief }) => {
  hermesConfig(chief);
  const servers = chief.run(["mcp", "list", "--json"], { env: HERMES }).json().filter((s: any) => s.adapter === "hermes");
  expect(servers.map((s: any) => [s.name, s.config.status])).toEqual([["files", "configured"], ["linear", "configured"], ["old", "disabled"]]);

  chief.importWorkflow(`
name: hm
agent: hermes
nodes:
  - id: a
    type: agent
    mcp: [linear]
    model: anthropic/claude-sonnet-4.6
    prompt: 'Summarise ${fake({ output: { summary: "from hermes" }, tokens: { in: 900, out: 80 } })}'
    output-schema: { summary: string }
`);
  const r = chief.run(["run", "hm", "--json"], { env: HERMES });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const n = r.json().node_runs[0];
  const call = chief.calls()[0];
  expect(call.cli).toBe("hermes");
  expect(n).toMatchObject({
    status: "completed",
    output: { summary: "from hermes" },
    session_id: call.session,
    usage: { input_tokens: 900, output_tokens: 80, cache_read_tokens: 7, cache_write_tokens: 3, cost_usd: 0, model: "anthropic/claude-sonnet-4.6", invocations: 1 },
  });

  // `hermes chat -q <prompt> --format stream-json`, then `-m`; the prompt is never on stdin.
  expect(call.argv[0]).toBe("chat");
  expect(values(call.argv, "--format")).toEqual(["stream-json"]);
  expect(values(call.argv, "-q")[0]).toContain("Summarise");
  expect(values(call.argv, "-m")).toEqual(["anthropic/claude-sonnet-4.6"]);
  expect(call.argv).not.toContain("--resume");
  expect(call.prompt).toContain("You may use only these MCP servers: linear.");
  expect(call.prompt).toContain("Do not call tools of any other MCP server.");

  // Everything was recorded: the command line without a second copy of the prompt, the prompt, both
  // text deltas, the tool call and its result, the whole reply from `result.text`, and stderr.
  const msgs = chief.run(["runs", "replay", "1", "--json"]).json();
  const kinds = msgs.map((m: any) => m.kind);
  const command = msgs.find((m: any) => m.kind === "command");
  expect(command.meta.adapter).toBe("hermes");
  expect(command.content).not.toContain("Summarise");
  expect(msgs.find((m: any) => m.kind === "prompt").content).toContain("You may use only these MCP servers: linear.");
  expect(msgs.filter((m: any) => m.kind === "agent_text").map((m: any) => m.content).join("")).toContain("from hermes");
  expect(msgs.find((m: any) => m.kind === "tool_use")).toMatchObject({ content: JSON.stringify({ path: "x" }, null, 2), meta: { name: "read_file" } });
  expect(msgs.find((m: any) => m.kind === "tool_result")).toMatchObject({ content: "x", meta: { is_error: false } });
  // The `session_id:` line stayed on stderr: it is recorded, and it was never parsed.
  expect(msgs.find((m: any) => m.kind === "stderr").content).toContain(`session_id: ${call.session}`);
  expect(kinds).toEqual(expect.arrayContaining(["command", "prompt", "agent_text", "tool_use", "tool_result", "result", "stderr"]));
});

test("E15.35-2 needs_input resumes the same Hermes session with --resume", ({ chief }) => {
  hermesConfig(chief);
  chief.importWorkflow(`
name: hm2
agent: hermes
nodes:
  - { id: ask, type: agent, mcp: [linear], prompt: 'A ${fake({ needs_input: { question: "go?", proposed: "x" } }, { output: { ok: 1 } })}' }
`);
  const start = chief.run(["run", "hm2", "--json"], { env: HERMES });
  expect(start.json().run.status).toBe("waiting_gate");
  const first = chief.calls()[0];
  expect(first.prompt).toContain("You may use only these MCP servers: linear.");

  const gate = show(chief).gates.find((g: any) => g.status === "waiting");
  expect(gate.reason).toBe("needs_input");
  chief.run(["gate", "approve", String(gate.id)], { env: HERMES });
  const resumed = chief.calls()[1];
  expect(values(resumed.argv, "--resume")).toEqual([first.session]);
  expect(resumed.prompt).toContain("The user approved.");
  expect(show(chief).node_runs[0]).toMatchObject({ status: "completed", output: { ok: 1 }, session_id: first.session });
});

test("E15.35-3 a failed Hermes turn reports the CLI's own error", ({ chief }) => {
  chief.importWorkflow(`name: hm3\nagent: hermes\nnodes:\n  - { id: a, type: agent, prompt: 'E ${fake({ error: true })}' }\n`);
  const r = chief.run(["run", "hm3", "--json"], { env: HERMES });
  expect(r.code).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("simulated agent error");
  const node = show(chief).node_runs[0];
  expect(node.status).toBe("failed");
  expect(node.error).toContain("agent reported an error");
  expect(node.error).toContain("simulated agent error");
});

test("E15.35-4 exit 130 is interruptible and resumable: chief continues the same session with --resume", ({ chief }) => {
  chief.importWorkflow(`name: hm4\nagent: hermes\nnodes:\n  - { id: a, type: agent, prompt: 'I ${fake({ interrupt: true }, { output: { ok: 4 } })}' }\n`);
  const r = chief.run(["run", "hm4", "--json"], { env: HERMES });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const [first, second] = chief.calls();
  // The first turn ended with the documented 130; chief continued it rather than failing the step.
  expect(chief.ends().map((e: any) => e.how)).toEqual(["interrupted", "ok"]);
  expect(values(second.argv, "--resume")).toEqual([first.session]);
  expect(second.prompt).toContain("You were interrupted before finishing.");
  const node = show(chief).node_runs[0];
  expect(node).toMatchObject({ status: "completed", output: { ok: 4 }, session_id: first.session });
  expect(node.error).toBeNull();
});

test("E15.35-5 exit 75 names the provider rate-limit distinctly, so it is worth retrying", ({ chief }) => {
  chief.importWorkflow(`name: hm5\nagent: hermes\nnodes:\n  - { id: a, type: agent, prompt: 'R ${fake({ rate_limited: true })}' }\n`);
  const r = chief.run(["run", "hm5", "--json"], { env: HERMES });
  expect(r.code).not.toBe(0);
  const node = show(chief).node_runs[0];
  expect(node.status).toBe("failed");
  expect(node.error).toContain("rate-limited");
  expect(node.error).toContain("exit code 75");
  expect(node.error).toContain("retry this run");
  // Not the wording of an ordinary failed turn.
  expect(node.error).not.toContain("simulated agent error");
});

test("E15.35-6 Hermes is told which servers it may use, and no server / an unknown one is handled", ({ chief }) => {
  hermesConfig(chief);
  // No server: told so. `tools: default` adds no flag, because Hermes has no documented way to
  // choose its toolsets per run (the adapter's comment and docs/adapters/hermes.md say so).
  chief.importWorkflow(`name: hm6\nagent: hermes\nnodes:\n  - { id: a, type: agent, mcp: [], tools: default, prompt: 'T ${fake({ output: { ok: 1 } })}' }\n`);
  expect(chief.run(["run", "hm6", "--json"], { env: HERMES }).code).toBe(0);
  expect(chief.calls()[0].prompt).toContain("Do not call any MCP server tools in this task.");
  expect(chief.calls()[0].argv).not.toContain("-t");
  expect(chief.calls()[0].argv).not.toContain("--toolsets");

  // A name Hermes does not have, and one its own config switches off, stop the run before any CLI call.
  chief.importWorkflow(`name: hm7\nagent: hermes\nnodes:\n  - { id: a, type: agent, mcp: [nope], prompt: x }\n`);
  const unknown = chief.run(["run", "hm7"], { env: HERMES });
  expect(unknown.stderr).toContain('hermes has no MCP server named "nope" (it has: files, linear, old)');
  chief.importWorkflow(`name: hm8\nagent: hermes\nnodes:\n  - { id: a, type: agent, mcp: [old], prompt: x }\n`);
  expect(chief.run(["run", "hm8"], { env: HERMES }).stderr).toContain('hermes is not connected to MCP server "old": it is disabled');
  expect(chief.calls()).toHaveLength(1);
});

test("E15.35-7 Hermes offers no model list, and says why instead of inventing one", ({ chief }) => {
  const m = chief.run(["models", "--adapter", "hermes", "--json"], { env: HERMES }).json();
  expect(m).toMatchObject({ adapter: "hermes", models: [] });
  expect(m.note).toContain("no model-list command");
});

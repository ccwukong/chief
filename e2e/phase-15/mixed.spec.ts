import { writeFileSync } from "node:fs";
import { expect, fake, FAKE_ANTIGRAVITY, test } from "../helpers";

/**
 * Phase 15, task 15.11: one workflow, several agent CLIs. The question behind it (2026-11-20) was
 * whether a step can use a personal subscription while another uses a work one — it could, because the
 * setting is only the last of three answers (`node.agent ?? workflow.agent ?? default-adapter`). This
 * case runs exactly that: a personal Antigravity reads a calendar server, a gate asks, and a work
 * Claude Code does the work with no MCP server at all.
 */
test("E15.11-1 a personal agent CLI for one step and a work one for the next, in one workflow", async ({ chief }) => {
  // The personal CLI's own servers, read from its config: only the calendar one here.
  writeFileSync(chief.env.FAKE_AGY_MCP, JSON.stringify({ mcpServers: { "google-calendar": { url: "https://mcp.example.test/gcal" } } }));
  chief.importWorkflow(`name: find-slot
agent: claude-code
nodes:
  - id: slots
    type: agent
    agent: antigravity
    mcp: [google-calendar]
    model: gemini-3.8-flash-low
    prompt: 'Find a free 30-minute slot tomorrow. ${fake({ output: { start: "2026-11-21T09:30", end: "2026-11-21T10:00" } })}'
  - id: pick
    type: gate
    kind: input
    options: [09:30, 10:15]
    prompt: Which slot should I start with?
  - id: start
    type: agent
    mcp: []
    prompt: 'Start the task at {{nodes.pick.output.option}}. ${fake({ output: { done: true } })}'
edges:
  - { from: slots, to: pick }
  - { from: pick, to: start }
`);
  const env = { CHIEF_ANTIGRAVITY_BIN: FAKE_ANTIGRAVITY };
  const started = chief.run(["run", "find-slot", "--json"], { env });
  expect(started.code, started.stdout + started.stderr).toBe(0);
  const runId = started.json().run.id;
  await chief.until(() => chief.run(["runs", "show", String(runId), "--json"]).json().run.status === "waiting_gate");

  // The first step ran on the personal CLI, and only the calendar server was offered to it.
  const [personal] = chief.calls();
  expect(personal.cli).toBe("antigravity");
  expect(personal.prompt).toContain("You may use only these MCP servers: google-calendar.");
  expect(personal.argv).toContain("gemini-3.8-flash-low");

  // Answer the gate, as a person would; the last step is the work account, with no server at all.
  const gates = chief.run(["gate", "list", "--json"]).json();
  const gate = (Array.isArray(gates) ? gates : gates.gates)[0];
  expect(chief.run(["gate", "answer", String(gate.id), '{"text": "", "option": "09:30"}', "--json"]).code).toBe(0);
  await chief.until(() => chief.run(["runs", "show", String(runId), "--json"]).json().run.status === "completed");
  const calls = chief.calls();
  expect(calls.length).toBe(2);
  // The record says which CLI ran each step (every run is recorded in full).
  const commands = chief.run(["runs", "replay", String(runId), "--json"]).json().filter((m: any) => m.kind === "command");
  expect(commands.map((m: any) => m.meta.adapter)).toEqual(["antigravity", "claude-code"]);
  // The work step is given the slot the personal one found, and it is given no MCP server at all:
  // `--strict-mcp-config` with an empty list, which the CLI hides every other server behind.
  expect(calls[1].prompt).toContain("09:30");
  expect(calls[1].prompt).not.toContain("MCP");
  const at = calls[1].argv.indexOf("--mcp-config");
  expect(calls[1].argv).toContain("--strict-mcp-config");
  expect(JSON.parse(calls[1].argv[at + 1])).toEqual({ mcpServers: {} });
});

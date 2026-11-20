import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, fake, test, type Chief } from "../helpers";

const events = (chief: Chief, id = 1) => chief.run(["runs", "tail", String(id), "--json"]).stdout.trim().split("\n").map((l) => JSON.parse(l));
const one = (chief: Chief, name: string, nodeFields: string, env?: Record<string, string>) => {
  const imp = chief.importWorkflow(`name: ${name}\nnodes:\n  - id: a\n    type: agent\n${nodeFields.replace(/^/gm, "    ")}\n`);
  expect(imp.code, imp.stderr).toBe(0);
  return chief.run(["run", name, "--json"], { env });
};
/** Value(s) following a flag in the recorded argv, up to the next flag. */
const flagValues = (argv: string[], flag: string) => {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const out: string[] = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith("--"); k++) out.push(argv[k]);
  return out;
};

test("E2.1-1 the stream-json parser captures session, usage, cost and result", ({ chief }) => {
  const r = one(chief, "parse", `prompt: 'go ${fake({ output: { answer: 42 }, cost: 0.25, tokens: { in: 1200, out: 340 } })}'\nmodel: sonnet`);
  expect(r.code, r.stderr).toBe(0);
  const d = r.json();
  const call = chief.calls()[0];
  expect(d.node_runs[0]).toMatchObject({
    status: "completed", session_id: call.session, output: { answer: 42 },
    usage: { input_tokens: 1200, output_tokens: 340, cost_usd: 0.25, model: "sonnet", invocations: 1 },
  });
  const types = events(chief).map((e: any) => e.type);
  expect(types).toEqual(expect.arrayContaining(["agent_text", "agent_invocation"]));
  const inv = events(chief).find((e: any) => e.type === "agent_invocation");
  expect(inv.payload.args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose"]));
});

test("E2.1-2 a CLI crash is retried once", ({ chief }) => {
  const r = one(chief, "crash-once", `prompt: 'go ${fake({ crash_times: 1, output: { ok: true } })}'`);
  expect(r.code, r.stderr).toBe(0);
  const d = r.json();
  expect(d.node_runs[0]).toMatchObject({ status: "completed", attempt: 1 });
  expect(d.node_runs[0].usage.invocations).toBe(2);
  const calls = chief.calls();
  expect(calls).toHaveLength(2);
  expect(calls[1].resume).toBeNull();
  expect(calls[1].session).not.toBe(calls[0].session);
  expect(events(chief).filter((e: any) => e.type === "node_retry")).toHaveLength(1);
});

test("E2.1-3 a CLI that keeps crashing fails the node with its stderr", ({ chief }) => {
  const r = one(chief, "crash-always", `prompt: 'go ${fake({ crash_times: 9 })}'`);
  expect(r.code).toBe(1);
  const d = r.json();
  expect(d.node_runs[0].status).toBe("failed");
  expect(d.node_runs[0].error).toContain("without a result");
  expect(d.node_runs[0].error).toContain("simulated crash");
  expect(chief.calls()).toHaveLength(2);
});

test("E2.1-4 no automatic retry once the node has reported side effects", ({ chief }) => {
  const effect = { kind: "slack_message", ref: "C1/123", url: "https://example.test/m/123", how_to_undo: "delete it", irreversible: false };
  one(chief, "crash-after-write", `prompt: 'go ${fake({ needs_input: { question: "continue?", proposed: "x", side_effects: [effect] } }, { crash_times: 1 })}'`);
  const r = chief.run(["gate", "approve", "1", "--json"]);
  expect(r.code).toBe(1);
  const d = r.json();
  expect(d.node_runs[0].status).toBe("failed");
  expect(d.side_effects).toHaveLength(1);
  expect(chief.calls()).toHaveLength(2);
  expect(events(chief).filter((e: any) => e.type === "node_retry")).toHaveLength(0);
});

test("E2.1-5 @real Claude Code: prompt in, JSON out, usage recorded", ({ chief }) => {
  test.setTimeout(180_000);
  chief.importWorkflow(`
name: real-json
nodes:
  - id: a
    type: agent
    model: haiku
    prompt: 'What is 17 + 25? Do not use tools. Put the number in "sum".'
    output-schema: { sum: number }
`);
  const r = chief.run(["run", "real-json", "--json"], { env: { CHIEF_CLAUDE_BIN: "claude" } });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const n = r.json().node_runs[0];
  expect(n.output.sum).toBe(42);
  expect(Array.isArray(n.output.side_effects)).toBe(true);
  expect(n.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  expect(n.usage.cost_usd).toBeGreaterThan(0);
  expect(n.usage.output_tokens).toBeGreaterThan(0);
  expect(n.usage.model).toContain("haiku");
});

test("E2.2-1 a connector server is allowed and every other known server is hidden", ({ chief }) => {
  const r = one(chief, "scope", "prompt: summarise slack\nmcp: [slack]");
  expect(r.code, r.stderr).toBe(0);
  const argv = chief.calls()[0].argv;
  expect(flagValues(argv, "--allowedTools")).toEqual(["mcp__claude_ai_Slack"]);
  expect(flagValues(argv, "--disallowedTools")!.filter((t) => t.startsWith("mcp__")).sort()).toEqual(["mcp__claude_ai_Atlassian", "mcp__claude_ai_GitHub_Custom", "mcp__claude_ai_Google_Drive", "mcp__claude_ai_Notion"]);
  expect(argv).not.toContain("--strict-mcp-config");
  expect(r.json().node_runs[0].input.mcp).toEqual(["slack"]);
  // The agent is told which servers it has and how to load their (deferred) tools.
  expect(chief.calls()[0].prompt).toContain("MCP servers available to you in this session: claude.ai Slack (tool names start with `mcp__claude_ai_Slack__`)");
  expect(chief.calls()[0].prompt).toContain("ToolSearch");
  // ... and to report a server it cannot reach instead of working around it.
  expect(chief.calls()[0].prompt).toContain('"status": "mcp_unavailable"');
  // No setup step: the run itself asked Claude Code which servers it has.
  expect(chief.mcpReads().control).toBe(1);
});

test("E2.2-2 file-configured servers are passed with a generated config in strict mode", ({ chief }) => {
  // Servers Claude Code has from its own config files (.mcp.json here), not claude.ai connectors.
  const def = { command: "npx", args: ["-y", "files-mcp"] };
  chief.file(".mcp.json", JSON.stringify({ mcpServers: { "local-files": def, "local-db": { command: "db-mcp" } } }));
  const env = { FAKE_CLAUDE_MCP_LIST: chief.file("mcp-list.txt", "claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected\nlocal-files: npx -y files-mcp - ✔ Connected\nlocal-db: db-mcp - ✔ Connected\n") };
  const r = one(chief, "strict", "prompt: read files\nmcp: [local-files]", env);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const argv = chief.calls()[0].argv;
  expect(argv).toContain("--strict-mcp-config");
  expect(JSON.parse(flagValues(argv, "--mcp-config")![0])).toEqual({ mcpServers: { "local-files": def } });
  expect(flagValues(argv, "--allowedTools")).toEqual(["mcp__local-files"]);
  expect(flagValues(argv, "--disallowedTools")!.filter((t) => t.startsWith("mcp__"))).toEqual([]);
});

test("E2.2-3 a node restricted to no MCP servers loads none", ({ chief }) => {
  one(chief, "none", "prompt: think\nmcp: []");
  const argv = chief.calls()[0].argv;
  expect(argv).toContain("--strict-mcp-config");
  expect(JSON.parse(flagValues(argv, "--mcp-config")![0])).toEqual({ mcpServers: {} });
  expect(argv).not.toContain("--allowedTools");
});

test("E2.2-4 unknown and ambiguous server names are refused; a unique prefix or the CLI's own name resolves", ({ chief }) => {
  const unknown = one(chief, "unknown", "prompt: x\nmcp: [jira-cloud]");
  expect(unknown.code).toBe(1);
  expect(unknown.json().error).toContain('claude-code has no MCP server named "jira-cloud" (it has: atlassian, github-custom, google-drive, notion, slack)');

  const env = { FAKE_CLAUDE_MCP_LIST: chief.file("mcp-list.txt", "claude.ai Google Drive: https://d - ✔ Connected\nclaude.ai Google Calendar: https://c - ✔ Connected\nclaude.ai GitHub Custom: https://g - ✔ Connected\n") };
  const ambiguous = one(chief, "ambiguous", "prompt: x\nmcp: [google]", env);
  expect(ambiguous.json().error).toContain('MCP server "google" is ambiguous for claude-code (google-calendar, google-drive)');
  expect(chief.calls()).toHaveLength(0);
  expect(chief.run(["runs", "list", "--json"]).json()).toEqual([]);

  const prefix = one(chief, "prefix", "prompt: x\nmcp: [github]");
  expect(prefix.code, prefix.stdout).toBe(0);
  expect(flagValues(chief.calls()[0].argv, "--allowedTools")).toEqual(["mcp__claude_ai_GitHub_Custom"]);

  const exact = one(chief, "exact", "prompt: x\nmcp: ['claude.ai Slack']");
  expect(exact.code, exact.stdout).toBe(0);
  expect(flagValues(chief.calls()[1].argv, "--allowedTools")).toEqual(["mcp__claude_ai_Slack"]);
});

test("E2.2-5 @real MCP scoping: the allowed connector works, another server is denied", ({ chief }) => {
  test.setTimeout(300_000);
  const env = { CHIEF_CLAUDE_BIN: "claude" };
  // Nothing is registered in chief: the run reads the servers from the real Claude Code.
  chief.importWorkflow(`
name: real-scope
nodes:
  - id: a
    type: agent
    model: haiku
    mcp: [slack]
    prompt: |
      1. Use the Slack tools to search for a public channel named "general". Read only; do not post anything.
      2. Then try once to call the Datadog MCP tool search_datadog_monitors.
      Report {"slack_found": true|false, "datadog": "ok" | "denied" | "unavailable"}.
    output-schema: { slack_found: boolean, datadog: string }
`);
  const r = chief.run(["run", "real-scope", "--json"], { env });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const n = r.json().node_runs[0];
  expect(n.output.slack_found).toBe(true);
  expect(n.output.datadog).not.toBe("ok");
  expect(n.output.side_effects).toEqual([]);
  const inv = events(chief).filter((e: any) => e.type === "agent_invocation");
  expect(inv[0].payload.args).toEqual(expect.arrayContaining(["--allowedTools", "mcp__claude_ai_Slack"]));
  expect(inv[0].payload.args).toContain("mcp__claude_ai_Datadog");
  const tools = events(chief).filter((e: any) => e.type === "agent_tool").map((e: any) => e.payload.name);
  expect(tools.some((t: string) => t.startsWith("mcp__claude_ai_Slack__"))).toBe(true);
});

test("E2.2-6 a server Claude Code is not connected to stops the run with that error", ({ chief }) => {
  // Notion needs authentication in this Claude Code.
  const r = one(chief, "noauth", "prompt: read my notes\nmcp: [notion, slack]");
  expect(r.code).toBe(1);
  expect(r.json().error).toContain('claude-code is not connected to MCP server "claude.ai Notion": it needs authentication');
  expect(chief.calls()).toHaveLength(0);
  expect(chief.run(["runs", "list", "--json"]).json()).toEqual([]);

  // A workflow that ran fine stops as soon as Claude Code loses the connection; nothing is cached across runs.
  expect(one(chief, "was-fine", "prompt: summarise\nmcp: [slack]").code).toBe(0);
  const env = { FAKE_CLAUDE_MCP_LIST: chief.file("mcp-list.txt", "claude.ai Slack: https://mcp.slack.com/mcp - ✘ Failed to connect\n") };
  const lost = chief.run(["run", "was-fine"], { env });
  expect(lost.code).toBe(1);
  expect(lost.stderr).toContain('claude-code is not connected to MCP server "claude.ai Slack": the connection failed');
  expect(chief.calls()).toHaveLength(1);
  // ... and works again once Claude Code is connected again.
  expect(chief.run(["run", "was-fine"]).code).toBe(0);
});

test("E2.2-7 an MCP failure reported by the agent during the run fails the node with its error", ({ chief }) => {
  const turn = { output: { status: "mcp_unavailable", server: "claude.ai Slack", error: "MCP error -32000: Connection closed" } };
  const r = one(chief, "midrun", `prompt: 'summarise ${fake(turn, { output: { ok: true } })}'\nmcp: [slack]\noutput-schema: { summary: string }`);
  expect(r.code).toBe(1);
  const d = r.json();
  expect(d.run.status).toBe("failed");
  expect(d.node_runs[0].error).toBe('MCP server "claude.ai Slack" is not available in claude-code: MCP error -32000: Connection closed');
  // Reported as it is: no repair turn, no retry.
  expect(chief.calls()).toHaveLength(1);
  expect(chief.run(["runs", "show", "1"]).stdout).toContain("MCP error -32000: Connection closed");

  // The server may be named in any of its forms.
  const short = one(chief, "midrun-short", `prompt: 'x ${fake({ output: { status: "mcp_unavailable", server: "slack", error: "timeout" } })}'\nmcp: [slack]`);
  expect(short.json().node_runs[0].error).toContain('MCP server "slack" is not available in claude-code: timeout');
  // A server the node was never given is not this node's problem: the output is taken as it is.
  const other = one(chief, "midrun-other", `prompt: 'x ${fake({ output: { status: "mcp_unavailable", server: "claude.ai Datadog", error: "no such tool", summary: "done" } })}'\nmcp: [slack]\noutput-schema: { summary: string }`);
  expect(other.code, other.stdout).toBe(0);
  expect(other.json().node_runs[0].output).toEqual({ summary: "done", server: "claude.ai Datadog", error: "no such tool", side_effects: [] });
});

test("E9.14-1 by default an agent node may use every server the CLI is connected to", ({ chief }) => {
  // No `mcp` field: nothing to configure, the agent decides.
  const r = one(chief, "open", "prompt: do whatever is needed");
  expect(r.code, r.stdout + r.stderr).toBe(0);
  let argv = chief.calls().at(-1)!.argv;
  expect(flagValues(argv, "--allowedTools")!.sort()).toEqual(["mcp__claude_ai_Atlassian", "mcp__claude_ai_GitHub_Custom", "mcp__claude_ai_Google_Drive", "mcp__claude_ai_Slack"]);
  // The server the CLI is not connected to (Notion needs signing in) is left out; it does not stop the run.
  expect(flagValues(argv, "--disallowedTools")!.filter((t) => t.startsWith("mcp__"))).toEqual(["mcp__claude_ai_Notion"]);
  expect(argv).not.toContain("--strict-mcp-config");
  const prompt = chief.calls().at(-1)!.prompt;
  expect(prompt).toContain("MCP servers available to you in this session: claude.ai Atlassian");
  expect(prompt).toContain("Use the ones the task calls for.");
  expect(prompt).not.toContain("claude.ai Notion");
  expect(r.json().node_runs[0].input.mcp).toBe("all");

  // An empty list: no server at all. A list: only those (and then a server that is not connected does stop the run).
  one(chief, "closed", "prompt: think\nmcp: []");
  argv = chief.calls().at(-1)!.argv;
  expect(argv).toContain("--strict-mcp-config");
  expect(flagValues(argv, "--allowedTools")).toBeNull();
  one(chief, "some", "prompt: x\nmcp: [slack, atlassian]");
  argv = chief.calls().at(-1)!.argv;
  expect(flagValues(argv, "--allowedTools")!.sort()).toEqual(["mcp__claude_ai_Atlassian", "mcp__claude_ai_Slack"]);
  expect(one(chief, "needs-notion", "prompt: x\nmcp: [notion]").json().error).toContain('claude-code is not connected to MCP server "claude.ai Notion"');

  // When the CLI loses a connection, an unrestricted node simply no longer gets that server.
  const env = { FAKE_CLAUDE_MCP_LIST: chief.file("mcp-list.txt", "claude.ai Slack: https://mcp.slack.com/mcp - ✘ Failed to connect\nclaude.ai Atlassian: https://a - ✔ Connected\n") };
  expect(chief.run(["run", "open"], { env }).code).toBe(0);
  expect(flagValues(chief.calls().at(-1)!.argv, "--allowedTools")).toEqual(["mcp__claude_ai_Atlassian"]);
});

test("E2.3-1 the prompt ends with the output contract and the node's schema", ({ chief }) => {
  one(chief, "contract", "prompt: List my items.\noutput-schema: { summary: string, items: [{ title: string, priority }] }");
  const prompt = chief.calls()[0].prompt;
  expect(prompt.startsWith("List my items.")).toBe(true);
  expect(prompt).toContain("Output contract");
  expect(prompt).toContain('{"summary":"string","items":[{"title":"string","priority":null}]}');
  expect(prompt).toContain('"side_effects"');
  expect(prompt).toContain('"status": "needs_input"');
});

test("E2.3-2 the final JSON block is extracted from surrounding prose", ({ chief }) => {
  const text = 'I looked at it.\n\n```json\n{"draft": true}\n```\n\nActually, final answer:\n\n```json\n{"summary": "final", "side_effects": []}\n```\nThanks!';
  const r = one(chief, "extract", `prompt: 'go ${fake({ text })}'`);
  expect(r.json().node_runs[0].output).toEqual({ summary: "final", side_effects: [] });

  const bare = one(chief, "extract-bare", `prompt: 'go ${fake({ text: 'Here you go: {"summary": "no fence", "nested": {"a": [1, 2]}} — done' })}'`);
  expect(bare.json().node_runs[0].output).toEqual({ summary: "no fence", nested: { a: [1, 2] } });
});

test("E2.3-3 a reply without JSON gets one repair turn on the same session", ({ chief }) => {
  const r = one(chief, "repair", `prompt: 'go ${fake({ text: "All done, nothing to report." }, { output: { ok: true } })}'`);
  expect(r.code, r.stderr).toBe(0);
  expect(r.json().node_runs[0]).toMatchObject({ status: "completed", output: { ok: true } });
  const calls = chief.calls();
  expect(calls).toHaveLength(2);
  expect(calls[1].resume).toBe(calls[0].session);
  expect(calls[1].prompt).toContain("did not satisfy the output contract: no JSON block found");
  expect(events(chief).filter((e: any) => e.type === "node_repair")).toHaveLength(1);
});

test("E2.3-4 output that violates the schema twice fails the node", ({ chief }) => {
  const badOut = { summary: 5, items: [{ title: "x" }, { name: "no title" }] };
  const r = one(chief, "schema", `prompt: 'go ${fake({ output: badOut }, { output: badOut }, { output: { summary: "late", items: [] } })}'\noutput-schema: { summary: string, items: [{ title: string }] }`);
  expect(r.code).toBe(1);
  const n = r.json().node_runs[0];
  expect(n.status).toBe("failed");
  expect(n.error).toContain("$.summary: expected string, got number");
  expect(n.error).toContain("$.items[1].title: missing");
  expect(chief.calls()).toHaveLength(2);
});

test("E2.4-1 reported side effects land in the ledger", ({ chief }) => {
  const effects = [
    { kind: "github_review", ref: "org/repo#12", url: "https://example.test/pr/12#r1", how_to_undo: "dismiss the review", irreversible: false },
    { kind: "slack_message", ref: "C1/999", url: "https://example.test/m/999", how_to_undo: "cannot unsend", irreversible: true },
  ];
  const r = one(chief, "ledger", `prompt: 'go ${fake({ output: { done: true, side_effects: effects } })}'`);
  const d = r.json();
  expect(d.side_effects).toHaveLength(2);
  expect(d.side_effects[0]).toMatchObject({ node_run_id: d.node_runs[0].id, kind: "github_review", ref: "org/repo#12", url: "https://example.test/pr/12#r1", how_to_undo: "dismiss the review", irreversible: 0, reverted_at: null });
  expect(d.side_effects[1]).toMatchObject({ kind: "slack_message", irreversible: 1 });
  const text = chief.run(["runs", "show", "1"]).stdout;
  expect(text).toContain("Side effects:");
  expect(text).toMatch(/slack_message\s+C1\/999.*\[irreversible\]/);
});

test("E2.4-2 an effect reported twice is recorded once", ({ chief }) => {
  const x = { kind: "jira_comment", ref: "ABC-1/c1", url: "https://example.test/ABC-1" };
  const y = { kind: "jira_transition", ref: "ABC-1/t1", url: "https://example.test/ABC-1" };
  one(chief, "dedupe", `prompt: 'go ${fake({ needs_input: { question: "more?", proposed: "y", side_effects: [x] } }, { output: { side_effects: [x, y] } })}'`);
  const d = chief.run(["gate", "approve", "1", "--json"]).json();
  expect(d.run.status).toBe("completed");
  expect(d.side_effects.map((e: any) => e.kind)).toEqual(["jira_comment", "jira_transition"]);
});

test("E2.5-1 by default an agent node has no built-in tools beyond tool search", ({ chief }) => {
  one(chief, "tools-default", "prompt: x\nmcp: []");
  const argv = chief.calls()[0].argv;
  expect(argv).not.toContain("--tools");
  expect(flagValues(argv, "--disallowedTools")).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "WebFetch", "Task", "Read", "Grep", "Glob"]));
  expect(argv).not.toContain("--allowedTools");
  // Hiding every built-in tool breaks tool search in the real CLI, so three inert ones stay visible.
  for (const keep of ["ToolSearch", "ListAgents", "ReportFindings", "TaskStop"]) expect(flagValues(argv, "--disallowedTools")).not.toContain(keep);
});

test("E2.5-2 the tools field maps to the built-in tool set", ({ chief }) => {
  one(chief, "ro", "prompt: x\nmcp: []\ntools: read-only");
  let argv = chief.calls().at(-1)!.argv;
  expect(flagValues(argv, "--allowedTools")).toEqual(["Read", "Grep", "Glob"]);
  expect(flagValues(argv, "--disallowedTools")).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]));
  expect(flagValues(argv, "--disallowedTools")).not.toEqual(expect.arrayContaining(["Read"]));

  one(chief, "full", "prompt: x\nmcp: []\ntools: default");
  argv = chief.calls().at(-1)!.argv;
  expect(argv).not.toContain("--disallowedTools");
  expect(argv).not.toContain("--allowedTools");

  one(chief, "listed", "prompt: x\nmcp: []\ntools: [Bash, Read]");
  argv = chief.calls().at(-1)!.argv;
  expect(flagValues(argv, "--allowedTools")).toEqual(["Bash", "Read"]);
  const hidden = flagValues(argv, "--disallowedTools")!;
  expect(hidden).toEqual(expect.arrayContaining(["Edit", "Write", "Grep", "Glob"]));
  expect(hidden).not.toContain("Bash");
  expect(hidden).not.toContain("Read");
  for (const call of chief.calls()) expect(call.argv).not.toContain("--tools");
});

test("E2.5-3 per-node tool rules, permission mode, model and cwd are passed through", ({ chief }) => {
  mkdirSync(join(chief.dir, "repo"));
  one(chief, "pass", [
    "prompt: x", "mcp: [slack]", "model: opus", "cwd: repo", "permission-mode: acceptEdits",
    "allowed-tools: ['Bash(git status)']", "disallowed-tools: [mcp__claude_ai_Slack__slack_send_message]",
  ].join("\n"));
  const call = chief.calls()[0];
  expect(flagValues(call.argv, "--model")).toEqual(["opus"]);
  expect(flagValues(call.argv, "--permission-mode")).toEqual(["acceptEdits"]);
  expect(flagValues(call.argv, "--allowedTools")).toEqual(expect.arrayContaining(["Bash(git status)", "mcp__claude_ai_Slack"]));
  expect(flagValues(call.argv, "--disallowedTools")).toContain("mcp__claude_ai_Slack__slack_send_message");
  expect(realpathSync(call.cwd)).toBe(realpathSync(join(chief.dir, "repo")));
  expect(call.argv).toEqual(expect.arrayContaining(["--permission-prompts", "none", "--disable-slash-commands"]));
});

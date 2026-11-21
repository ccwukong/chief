import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, fake, FAKE_ANTIGRAVITY, FAKE_CODEX, FAKE_CURSOR, FAKE_OPENCODE, test, type Chief } from "../helpers";

type Msg = { id: number; run_id: number; workflow_id: number; node_run_id: number | null; node_id: string | null; direction: string; kind: string; content: string; meta: any };
const replay = (chief: Chief, id = 1, extra: string[] = []): Msg[] => chief.run(["runs", "replay", String(id), "--json", ...extra]).json();
const kinds = (msgs: Msg[], node?: string) => msgs.filter((m) => !node || m.node_id === node).map((m) => `${m.direction}:${m.kind}`);
const of = (msgs: Msg[], kind: string, node?: string) => msgs.filter((m) => m.kind === kind && (!node || m.node_id === node));

test("E9.1-1 the backlog is gone: command, API, template and gate field", async ({ chief }) => {
  const cmd = chief.run(["backlog", "list"]);
  expect(cmd.code).toBe(1);
  expect(cmd.stderr).toContain("unknown command: backlog list");
  expect(chief.run(["--help"]).stdout).not.toContain("backlog");

  const tpl = chief.file("tpl.yaml", "name: tpl\nnodes:\n  - { id: a, type: agent, prompt: 'see {{backlog.open}}' }\n");
  const v = chief.run(["workflow", "validate", tpl, "--json"]);
  expect(v.code).toBe(1);
  expect(v.json().errors.join("\n")).toContain("{{backlog.open}} is no longer available; the backlog was removed");

  const field = chief.file("field.yaml", "name: field\nnodes:\n  - { id: g, type: gate, kind: select, from: [1, 2], unselected-to-backlog: true }\n");
  const imp = chief.run(["workflow", "import", field]);
  expect(imp.code).toBe(1);
  expect(imp.stderr).toContain("`unselected-to-backlog` is no longer available; the backlog was removed");
  expect(imp.stderr).toContain("`unselected`");

  // The schema migration removed the table and added the run record.
  const db = chief.run(["doctor", "--json"]).json().db;
  expect(db.migrations).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(db.schemas)).not.toContain("backlog");
});

test("E9.2-1 an agent run is recorded in full: command, prompt, tool calls with results, reply, result", ({ chief }) => {
  const big = "x".repeat(12_000);
  const tools = [
    { name: "mcp__claude_ai_Slack__slack_search_channels", input: { query: "general" }, result: `found #general ${big}` },
    { name: "mcp__claude_ai_Slack__slack_read_channel", input: { channel: "C1" }, result: "permission denied", is_error: true },
  ];
  chief.importWorkflow(`
name: rec
inputs: { who: team }
nodes:
  - id: plan
    type: agent
    mcp: [slack]
    model: haiku
    prompt: 'Summarise for {{inputs.who}} ${fake({ tools, output: { summary: "all quiet" }, cost: 0.02 })}'
    output-schema: { summary: string }
`);
  expect(chief.run(["run", "rec", "--input", "who=ops"]).code).toBe(0);
  const msgs = replay(chief);
  expect(msgs.every((m) => m.run_id === 1 && m.workflow_id === 1)).toBe(true);
  expect(msgs.map((m) => m.id)).toEqual([...msgs.map((m) => m.id)].sort((a, b) => a - b));
  expect(kinds(msgs)).toEqual([
    "user:run_input", "system:run_started", "system:node_running",
    "in:command", "in:prompt",
    "out:tool_use", "in:tool_result", "out:tool_use", "in:tool_result",
    "out:agent_text", "out:result",
    "system:node_completed", "system:run_completed",
  ]);
  expect(JSON.parse(of(msgs, "run_input")[0].content)).toEqual({ who: "ops" });

  // The prompt exactly as the CLI received it, including what chief appended.
  const prompt = of(msgs, "prompt")[0];
  expect(prompt.content).toBe(chief.calls()[0].prompt);
  expect(prompt.content).toContain("Summarise for ops");
  expect(prompt.content).toContain("Output contract");
  expect(prompt.content).toContain("MCP servers available to you");
  const command = of(msgs, "command")[0];
  expect(command.content).toContain("--allowedTools mcp__claude_ai_Slack");
  expect(command.content).toContain("--model haiku");
  expect(command.meta).toMatchObject({ adapter: "claude-code", resume: null });

  // Tool calls with their input, and results in full (not cut to an excerpt).
  const [use1, use2] = of(msgs, "tool_use");
  expect(use1.meta.name).toBe("mcp__claude_ai_Slack__slack_search_channels");
  expect(JSON.parse(use1.content)).toEqual({ query: "general" });
  const [res1, res2] = of(msgs, "tool_result");
  expect(res1.content).toBe(`found #general ${big}`);
  expect(res1.meta.is_error).toBe(false);
  expect(res2).toMatchObject({ content: "permission denied", meta: { is_error: true } });
  expect(use2.meta.name).toContain("slack_read_channel");

  const result = of(msgs, "result")[0];
  expect(result.content).toContain('"summary": "all quiet"');
  expect(result.meta).toMatchObject({ session_id: chief.calls()[0].session, error: null, usage: { cost_usd: 0.02, model: "haiku" } });
  expect(chief.run(["runs", "show", "1"]).stdout).toContain(`${msgs.length} messages recorded  (chief runs replay 1)`);
});

test("E9.2-2 every invocation of a node is recorded in order, with the gate question and the answer", ({ chief }) => {
  chief.importWorkflow(`
name: multi
nodes:
  - id: review
    type: agent
    prompt: 'Review it ${fake({ needs_input: { question: "Post this?", proposed: { body: "LGTM" } } }, { text: "posted, no json" }, { output: { posted: true } })}'
`);
  chief.run(["run", "multi"]);
  chief.run(["gate", "approve", "1", "--value", '{"body":"LGTM, thanks"}', "--text", "be brief"]);
  const msgs = replay(chief);
  expect(kinds(msgs, "review")).toEqual([
    "system:node_running", "in:command", "in:prompt", "out:agent_text", "out:result",
    "system:gate_question", "system:node_waiting_gate",
    "user:gate_answer",
    "system:node_running", "in:command", "in:prompt", "out:agent_text", "out:result",
    "system:node_repair", "in:command", "in:prompt", "out:agent_text", "out:result",
    "system:node_completed",
  ]);
  expect(JSON.parse(of(msgs, "gate_question")[0].content)).toEqual({ message: "Post this?", value: { body: "LGTM" } });
  expect(of(msgs, "gate_question")[0].meta).toMatchObject({ gate_id: 1, kind: "approve", reason: "needs_input" });
  expect(JSON.parse(of(msgs, "gate_answer")[0].content)).toEqual({ decision: "approve", value: { body: "LGTM, thanks" }, text: "be brief" });

  const prompts = of(msgs, "prompt");
  expect(prompts[0].content).toContain("Review it");
  expect(prompts[1].content).toContain("LGTM, thanks");
  expect(prompts[1].content).toContain("Their reply: be brief");
  expect(prompts[2].content).toContain("did not satisfy the output contract");
  const session = chief.calls()[0].session;
  expect(of(msgs, "command").map((c) => c.meta.resume)).toEqual([null, session, session]);
  expect(of(msgs, "agent_text")[1].content).toBe("posted, no json");
});

test("E9.2-3 a script run is recorded: command, sandbox, stdin, stdout, stderr and exit code", ({ chief }) => {
  chief.file("ok.py", "import json,sys\nd=json.load(sys.stdin)\nsys.stderr.write('working on '+d['name']+'\\n')\nprint(json.dumps({'hello': d['name']}))\n");
  chief.file("bad.sh", "cat > /dev/null\necho 'partial output'\necho 'disk is full' >&2\nexit 7\n");
  chief.importWorkflow(`
name: scripts
nodes:
  - { id: ok, type: script, run: ok.py, input: { name: "{{inputs.name}}" }, timeout: 20s }
  - { id: bad, type: script, run: bad.sh }
edges: [ok -> bad]
`);
  expect(chief.run(["run", "scripts", "--input", "name=Ana"]).code).toBe(1);
  const msgs = replay(chief);
  expect(kinds(msgs, "ok")).toEqual(["system:node_running", "in:command", "in:stdin", "out:stdout", "out:stderr", "out:exit", "system:node_completed"]);
  const cmd = of(msgs, "command", "ok")[0];
  expect(cmd.content).toBe(`python3 ${join(chief.dir, "ok.py")}`);
  expect(cmd.meta).toMatchObject({ cwd: chief.dir, sandbox: { network: false, write: [], env: [] }, timeout_ms: 20_000 });
  expect(JSON.parse(of(msgs, "stdin", "ok")[0].content)).toEqual({ name: "Ana" });
  expect(JSON.parse(of(msgs, "stdout", "ok")[0].content)).toEqual({ hello: "Ana" });
  expect(of(msgs, "stderr", "ok")[0].content).toBe("working on Ana\n");
  expect(of(msgs, "exit", "ok")[0]).toMatchObject({ content: "0", meta: { code: 0, timed_out: false } });

  expect(of(msgs, "stdout", "bad")[0].content).toBe("partial output\n");
  expect(of(msgs, "stderr", "bad")[0].content).toBe("disk is full\n");
  expect(of(msgs, "exit", "bad")[0].meta.code).toBe(7);
  const failed = of(msgs, "node_failed", "bad")[0];
  expect(failed.direction).toBe("system");
  expect(failed.content).toContain("script exited with code 7");
  expect(msgs.at(-1)).toMatchObject({ kind: "run_failed", direction: "system" });
  expect(msgs.at(-1)!.content).toContain("script exited with code 7");
});

test("E9.2-4 failures are recorded: CLI crash with stderr, the retry, and the final error", ({ chief }) => {
  chief.importWorkflow(`name: crash\nnodes:\n  - { id: a, type: agent, prompt: 'go ${fake({ crash_times: 9 })}' }\n`);
  expect(chief.run(["run", "crash"]).code).toBe(1);
  const msgs = replay(chief);
  expect(kinds(msgs, "a")).toEqual([
    "system:node_running", "in:command", "in:prompt", "out:stderr", "out:result",
    "system:node_retry", "in:command", "in:prompt", "out:stderr", "out:result",
    "system:node_failed",
  ]);
  expect(of(msgs, "stderr")[0].content).toContain("fake-claude: simulated crash");
  expect(of(msgs, "result")[0].meta.error).toContain("without a result");
  expect(of(msgs, "node_retry")[0].content).toContain("without a result");
  expect(of(msgs, "node_failed")[0].content).toContain("simulated crash");
  expect(of(msgs, "run_failed")[0].content).toContain("simulated crash");
});

test("E9.2-5 a revert is recorded too: compensation prompt and reply", ({ chief }) => {
  chief.importWorkflow(`
name: undo
nodes:
  - id: a
    type: agent
    prompt: 'A ${fake({ output: { side_effects: [{ kind: "doc", ref: "d1" }] } })}'
    compensate: { prompt: 'UNDO {{output.side_effects}} ${fake({ output: { reverted: ["d1"], failed: [] } })}' }
`);
  chief.run(["run", "undo"]);
  const before = replay(chief).length;
  chief.run(["revert", "1"]);
  const after = replay(chief).slice(before);
  expect(kinds(after)).toEqual(["system:revert_started", "system:node_running", "in:command", "in:prompt", "out:agent_text", "out:result", "system:node_completed", "system:revert_report"]);
  expect(of(after, "prompt")[0].content).toContain('UNDO [');
  expect(of(after, "prompt")[0].content).toContain('"ref": "d1"');
  expect(of(after, "node_running")[0].meta.phase).toBe("compensate");
  expect(of(after, "revert_report")[0].meta).toMatchObject({ compensated: ["a"], reverted_effects: 1 });
  expect(of(replay(chief), "side_effect")[0].meta).toMatchObject({ kind: "doc", ref: "d1" });
});

test("E9.2-6 runs are listed per workflow and a replay can be filtered and read as text", ({ chief }) => {
  chief.importWorkflow(`name: one\nnodes:\n  - { id: a, type: agent, prompt: 'first ${fake({ text: "y".repeat(5000) + '\\n```json\\n{"ok": true}\\n```' })}' }\n  - { id: b, type: agent, prompt: 'second' }\nedges: [a -> b]\n`);
  chief.importWorkflow("name: two\nnodes:\n  - { id: z, type: agent, prompt: other }\n");
  chief.run(["run", "one"]);
  chief.run(["run", "two"]);
  chief.run(["run", "one"]);
  expect(chief.run(["runs", "list", "--workflow", "one", "--json"]).json().map((r: any) => r.id)).toEqual([3, 1]);
  expect(chief.run(["runs", "list", "--workflow", "two", "--json"]).json().map((r: any) => r.id)).toEqual([2]);
  expect(chief.run(["runs", "list", "--json"]).json()).toHaveLength(3);
  expect(chief.run(["runs", "list", "--workflow", "nope"]).stderr).toContain('workflow "nope" not found');
  // Each run's record belongs to its workflow.
  expect(new Set(replay(chief, 2).map((m) => m.workflow_id))).toEqual(new Set([2]));
  expect(new Set(replay(chief, 3).map((m) => m.workflow_id))).toEqual(new Set([1]));

  const onlyB = replay(chief, 1, ["--node", "b"]);
  expect(onlyB.length).toBeGreaterThan(3);
  expect(onlyB.every((m) => m.node_id === "b")).toBe(true);

  const text = chief.run(["runs", "replay", "1"]).stdout;
  expect(text).toMatch(/^Replay of run 1 \(one v1, completed\): \d+ recorded messages/);
  expect(text).toMatch(/── #\d+ {2}\d\d:\d\d:\d\d {2}→ to worker {2}prompt {2}\[a #1\]/);
  expect(text).toMatch(/← from worker {2}agent_text {2}\[a #1\]/);
  expect(text).toContain("more characters; add --full]");
  const full = chief.run(["runs", "replay", "1", "--full"]).stdout;
  expect(full).toContain("y".repeat(5000));
  expect(full).not.toContain("add --full]");
  expect(chief.run(["runs", "replay", "99"]).stderr).toContain("run 99 not found");
});

test("E9.2-7 the record and the per-workflow run list are available over the API", async ({ chief }) => {
  chief.importWorkflow(`name: api-rec\nnodes:\n  - { id: a, type: agent, prompt: 'hello ${fake({ output: { n: 1 } })}' }\n  - { id: g, type: gate, kind: approve, value: "{{nodes.a.output.n}}" }\nedges: [a -> g]\n`);
  chief.importWorkflow("name: other\nnodes:\n  - { id: z, type: agent, prompt: other }\n");
  const s = await chief.serve();
  try {
    const id = (await s.api("POST", "/api/runs", { workflow: "api-rec" })).body.run.id;
    await chief.until(async () => (await s.api("GET", `/api/runs/${id}`)).body.run.status === "waiting_gate");
    await s.api("POST", "/api/runs", { workflow: "other" });
    const t = await s.api<Msg[]>("GET", `/api/runs/${id}/transcript`);
    expect(t.status).toBe(200);
    expect(t.body.map((m) => m.kind)).toEqual(expect.arrayContaining(["run_input", "command", "prompt", "agent_text", "result", "gate_question"]));
    expect(t.body.find((m) => m.kind === "prompt")!.content).toContain("hello");
    expect((await s.api("GET", `/api/runs/${id}`)).body.messages).toBe(t.body.length);

    const last = t.body.at(-1)!.id;
    await s.api("POST", "/api/gates/1/answer", { answer: { decision: "approve" } });
    await chief.until(async () => (await s.api("GET", `/api/runs/${id}`)).body.run.status === "completed");
    const more = await s.api<Msg[]>("GET", `/api/runs/${id}/transcript?after=${last}`);
    expect(more.body[0]).toMatchObject({ kind: "gate_answer", direction: "user" });
    expect(more.body.every((m) => m.id > last)).toBe(true);
    expect((await s.api<Msg[]>("GET", `/api/runs/${id}/transcript?node=g`)).body.every((m) => m.node_id === "g")).toBe(true);
    expect((await s.api("GET", "/api/runs/999/transcript")).status).toBe(404);

    expect((await s.api("GET", "/api/runs?workflow=api-rec")).body.map((r: any) => r.workflow_name)).toEqual(["api-rec"]);
    expect((await s.api("GET", "/api/runs")).body).toHaveLength(2);
    expect((await s.api("GET", "/api/runs?workflow=ghost")).status).toBe(404);
  } finally { await s.stop(); }
});

test("E9.2-9 the record is written as it happens and survives a killed process, pause and resume", async ({ chief }) => {
  chief.importWorkflow(`name: live\nnodes:\n  - { id: slow, type: agent, prompt: 'long task ${fake({ sleep_ms: 60000 }, { output: { done: true } })}' }\n`);
  const bg = chief.start(["run", "live"]);
  await chief.until(() => chief.calls().length === 1);
  // While the agent is still working, its command and prompt are already in the database.
  await chief.until(() => of(replay(chief), "prompt").length === 1);
  bg.proc.kill("SIGKILL");
  await bg.done;
  expect(of(replay(chief), "prompt")[0].content).toContain("long task");

  chief.run(["resume", "1"]);
  const msgs = replay(chief);
  expect(kinds(msgs)).toEqual([
    "user:run_input", "system:run_started", "system:node_running", "in:command", "in:prompt",
    "system:run_interrupted", "system:run_resumed",
    "system:node_running", "in:command", "in:prompt", "out:agent_text", "out:result",
    "system:node_completed", "system:run_completed",
  ]);
  expect(of(msgs, "prompt")[1].content).toContain("You were interrupted");
  expect(of(msgs, "command")[1].meta.resume).toBe(chief.calls()[0].session);
});

test("E9.5-1 chief models lists what Claude Code itself offers, without running an agent turn", ({ chief }) => {
  const r = chief.run(["models", "--json"]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.json()).toEqual({
    adapter: "claude-code",
    models: [
      { value: "default", label: "Default (recommended) (claude-fable-5-1)", description: "Fable 5.1" },
      { value: "opus", label: "Opus 5.5 (claude-opus-5-5)", description: "For complex work" },
      { value: "sonnet", label: "Sonnet 5.5 (claude-sonnet-5-5)", description: "Most efficient" },
      { value: "haiku", label: "Haiku 5.5 (claude-haiku-5-5)", description: "Fastest" },
    ],
  });
  expect(chief.calls()).toHaveLength(0);
  expect(chief.run(["models"]).stdout).toMatch(/haiku\s+Haiku 5\.5 \(claude-haiku-5-5\)\s+Fastest/);
  expect(chief.run(["models", "--adapter", "nope"]).stderr).toContain('unknown agent adapter "nope"');
});

test("E9.5-2 Codex models come from its config, Cursor's, Antigravity's and OpenCode's from their models command; a missing CLI gives none", ({ chief }) => {
  mkdirSync(chief.env.CODEX_HOME, { recursive: true });
  writeFileSync(join(chief.env.CODEX_HOME, "config.toml"), 'model = "gpt-5-codex"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n\n[profiles.same]\nmodel = "gpt-5-codex"\n');
  const env = { CHIEF_CODEX_BIN: FAKE_CODEX, CHIEF_CURSOR_BIN: FAKE_CURSOR, CHIEF_ANTIGRAVITY_BIN: FAKE_ANTIGRAVITY, CHIEF_OPENCODE_BIN: FAKE_OPENCODE };
  const codex = chief.run(["models", "--adapter", "codex", "--json"], { env }).json();
  expect(codex.models).toEqual([{ value: "gpt-5-codex", label: "gpt-5-codex (configured default)" }, { value: "gpt-5-mini", label: "gpt-5-mini (profile fast)" }]);
  expect(codex.note).toContain("Codex has no model list command");

  const cursor = chief.run(["models", "--adapter", "cursor", "--json"], { env }).json();
  expect(cursor.models).toEqual([{ value: "auto", label: "auto", description: "Let Cursor choose" }, { value: "gpt-5", label: "gpt-5" }, { value: "sonnet-4.5", label: "sonnet-4.5", description: "Anthropic" }]);

  const agy = chief.run(["models", "--adapter", "antigravity", "--json"], { env }).json();
  expect(agy.models).toEqual([{ value: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" }, { value: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" }]);
  const oc = chief.run(["models", "--adapter", "opencode", "--json"], { env }).json();
  expect(oc.models).toEqual([{ value: "opencode/big-pickle", label: "opencode/big-pickle" }, { value: "anthropic/claude-sonnet-5-5", label: "anthropic/claude-sonnet-5-5" }]);

  for (const a of ["codex", "antigravity", "opencode"]) expect(chief.run(["models", "--adapter", a, "--json"]).json()).toEqual({ adapter: a, models: [], note: "CLI not installed" });
});

test("E9.5-3 the model list is available over the API, per adapter", async ({ chief }) => {
  const s = await chief.serve({ env: { CHIEF_CURSOR_BIN: FAKE_CURSOR } });
  try {
    const def = await s.api("GET", "/api/models");
    expect(def.body.adapter).toBe("claude-code");
    expect(def.body.models.map((m: any) => m.value)).toEqual(["default", "opus", "sonnet", "haiku"]);
    expect((await s.api("GET", "/api/models?adapter=cursor")).body.models.map((m: any) => m.value)).toEqual(["auto", "gpt-5", "sonnet-4.5"]);
    expect((await s.api("GET", "/api/models?adapter=codex")).body).toEqual({ adapter: "codex", models: [], note: "CLI not installed" });
    expect((await s.api("GET", "/api/models?adapter=nope")).status).toBe(400);
  } finally { await s.stop(); }
});

test("E9.12-1 a server list that is still loading is waited for, never taken as empty", ({ chief }) => {
  // Like the real CLI just after it starts: first no servers at all, then servers that are still connecting.
  const env = { FAKE_CLAUDE_MCP_SLOW: "1" };
  const list = chief.run(["mcp", "list", "--json"], { env }).json();
  expect(list.map((s: any) => s.name)).toEqual(["atlassian", "github-custom", "google-drive", "notion", "slack"]);
  // The statuses are the settled ones, not "pending".
  expect(list.map((s: any) => s.config.status)).toEqual(["connected", "connected", "connected", "needs-auth", "connected"]);
  expect(chief.mcpReads()).toEqual({ control: 1, probes: 0, lists: 0 });

  // A run started while the list is still loading sees the servers too.
  chief.importWorkflow("name: slow-start\nnodes:\n  - { id: a, type: agent, mcp: [slack], prompt: hi }\n");
  const r = chief.run(["run", "slow-start", "--json"], { env });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  expect(chief.calls()[0].argv).toContain("mcp__claude_ai_Slack");
});

test("E9.12-2 without the control interface chief falls back to the session start, then to `claude mcp list`", ({ chief }) => {
  // An older CLI: no mcp_status request, and a session start that lists no servers.
  const list = chief.run(["mcp", "list", "--json"], { env: { FAKE_CLAUDE_NO_INIT_MCP: "1" } }).json();
  expect(list.map((s: any) => s.name)).toEqual(["atlassian", "github-custom", "google-drive", "notion", "slack"]);
  expect(list.find((s: any) => s.name === "notion").config).toMatchObject({ status: "needs-auth", detail: "Needs authentication" });
  expect(chief.mcpReads()).toEqual({ control: 0, probes: 1, lists: 1 });
});

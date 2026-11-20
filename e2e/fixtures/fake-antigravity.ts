#!/usr/bin/env node
/**
 * Stand-in for the Antigravity CLI (`agy`), with the events agy 1.5.11 prints:
 * `--version`, `models`, `mcp list`, and `--print= --input-format stream-json --output-format stream-json`
 * with the prompt as a `{"event":"user","message":…}` line on stdin and `--conversation <id>` to resume.
 * Its MCP servers are read from the file in FAKE_AGY_MCP (same format as `~/.gemini/config/mcp_config.json`).
 */
import { existsSync, readFileSync } from "node:fs";
import { scripted } from "./fake-agent-core.ts";
import { exitAfterFlush, readStdin } from "./node-compat.ts";

const argv = process.argv.slice(2);
const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv.includes("--version")) { console.log("1.5.11"); await exitAfterFlush(0); }
if (argv[0] === "models") { console.log("gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-4-neon-high\tGemini 4 Neon (High)"); await exitAfterFlush(0); }
if (argv[0] === "mcp" && argv[1] === "list") {
  const file = process.env.FAKE_AGY_MCP;
  const defs: Record<string, any> = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {} : {};
  if (!Object.keys(defs).length) { console.log("No MCP servers configured."); await exitAfterFlush(0); }
  console.log("NAME     TYPE   STATUS    COMMAND/URL");
  for (const [name, d] of Object.entries(defs)) {
    const url = d.url ?? d.serverUrl;
    console.log(`${name}  ${url ? "http" : "stdio"}  ${d.disabled ? "disabled" : "enabled"}  ${url ?? [d.command, ...(d.args ?? [])].join(" ")}`);
  }
  await exitAfterFlush(0);
}
if (!argv.includes("--print=") || flag("--input-format") !== "stream-json" || flag("--output-format") !== "stream-json") {
  console.error("fake-agy: only --print= --input-format stream-json --output-format stream-json is supported"); await exitAfterFlush(64);
}

const first = (await readStdin()).split("\n").find((l) => l.trim());
const msg = first ? JSON.parse(first) : null;
if (msg?.event !== "user" || !msg.message) { emit({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: 'stream input message is missing the "event" field' } }); await exitAfterFlush(1); }
const prompt = String(msg.message.content);
const model = flag("--model") ?? "gemini-fake";
const s = scripted("antigravity", argv, prompt, flag("--conversation"));
const id = s.sessionId;
const usage = { input_tokens: s.turn.tokens?.in ?? 100, output_tokens: s.turn.tokens?.out ?? 20, thinking_tokens: 5, cache_read_tokens: 40, total_tokens: 0 };

emit({ event: "init", conversation_id: id, init: { model, cwd: process.cwd(), tools: ["read_file", "run_command"] } });
emit({ event: "step_update", step_update: { conversation_id: id, step_index: 0, state: "DONE", step_type: "user_input" } });
if (s.crash) { console.error("fake-agy: simulated crash"); s.logEnd("crash"); await exitAfterFlush(1); }
if (await s.sleep()) { s.logEnd("sigint"); await exitAfterFlush(130); }
if (s.turn.error) {
  emit({ event: "result", result: { conversation_id: id, status: "ERROR", response: "", error: "simulated agent error" } });
  s.logEnd("error"); await exitAfterFlush(1);
}
emit({ event: "step_update", step_update: { conversation_id: id, step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "read_file", tool_info: { name: "read_file", parameters: { Path: "x" } } } });
emit({ event: "step_update", step_update: { conversation_id: id, step_index: 1, state: "DONE", step_type: "tool", tool_name: "read_file", tool_info: { name: "read_file", output: "x" } } });
const text = s.text();
emit({ event: "step_update", step_update: { conversation_id: id, step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: text } });
emit({ event: "step_update", step_update: { conversation_id: id, step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "\n", usage } });
emit({ event: "result", result: { conversation_id: id, status: "SUCCESS", response: text + "\n", num_turns: 1, usage } });
s.logEnd("ok");

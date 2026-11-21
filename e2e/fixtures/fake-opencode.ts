#!/usr/bin/env node
/**
 * Stand-in for the OpenCode CLI, with the events opencode 1.18.31 prints:
 * `--version`, `models`, `debug config`, `mcp list`, and `run --format json [-m …] [-s <id>]` with the
 * prompt on stdin. The config is the JSON file in OPENCODE_CONFIG with OPENCODE_CONFIG_CONTENT merged
 * over it (as the real CLI does); the invocation log records OPENCODE_CONFIG_CONTENT as `config_content`.
 */
import { existsSync, readFileSync } from "node:fs";
import { scripted } from "./fake-agent-core.ts";
import { exitAfterFlush, readStdin } from "./node-compat.ts";

const argv = process.argv.slice(2);
const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const flag = (...names: string[]) => { for (const n of names) { const i = argv.indexOf(n); if (i >= 0) return argv[i + 1]; } return undefined; };

function config(): any {
  const file = process.env.OPENCODE_CONFIG;
  const base = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const over = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : {};
  const mcp: Record<string, any> = { ...(base.mcp ?? {}) };
  for (const [k, v] of Object.entries(over.mcp ?? {})) mcp[k] = { ...(mcp[k] ?? {}), ...(v as object) };
  return { ...base, ...over, mcp };
}

if (argv.includes("--version")) { console.log("1.18.31"); await exitAfterFlush(0); }
if (argv[0] === "models") { console.log("opencode/big-pickle\nanthropic/claude-sonnet-5-5"); await exitAfterFlush(0); }
if (argv[0] === "debug" && argv[1] === "config") { console.log(JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config() }, null, 2)); await exitAfterFlush(0); }
if (argv[0] === "mcp" && argv[1] === "list") {
  const defs = Object.entries(config().mcp ?? {});
  if (!defs.length) { console.log("┌  MCP Servers\n│\n▲  No MCP servers configured\n│\n└  Add servers with: opencode mcp add"); await exitAfterFlush(0); }
  console.log("\x1b[0m\n┌  MCP Servers\n│");
  for (const [name, d] of defs as [string, any][]) {
    const target = d.url ?? (d.command ?? []).join(" ");
    if (d.enabled === false) console.log(`●  ○ ${name} \x1b[90mdisabled\n│      \x1b[90m${target}\n│`);
    else if (d.fake_status === "failed") console.log(`●  ✗ ${name} \x1b[90mfailed\n│      SSE error: simulated\n│      \x1b[90m${target}\n│`);
    else console.log(`●  ✓ ${name} \x1b[90mconnected\n│      \x1b[90m${target}\n│`);
  }
  console.log(`└  ${defs.length} server(s)`);
  await exitAfterFlush(0);
}
if (argv[0] !== "run" || flag("--format") !== "json") { console.error("fake-opencode: only `run --format json` is supported"); await exitAfterFlush(64); }

const prompt = await readStdin();
const s = scripted("opencode", argv, prompt, flag("-s", "--session"), { config_content: process.env.OPENCODE_CONFIG_CONTENT ?? null });
const sessionID = s.sessionId;
const ev = (type: string, part: Record<string, unknown> = {}) => emit({ type, timestamp: Date.now(), sessionID, part: { sessionID, messageID: "msg_1", ...part } });

ev("step_start", { type: "step-start" });
if (s.crash) { console.error("fake-opencode: simulated crash"); s.logEnd("crash"); await exitAfterFlush(1); }
if (await s.sleep()) { s.logEnd("sigint"); await exitAfterFlush(130); }
if (s.turn.error) { emit({ type: "error", timestamp: Date.now(), sessionID, error: { name: "UnknownError", data: { message: "simulated agent error" } } }); s.logEnd("error"); await exitAfterFlush(0); }
ev("tool_use", { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "x" }, output: "x" } });
ev("step_finish", { type: "step-finish", reason: "tool-calls", tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 10, write: 0 } }, cost: 0.001 });
ev("step_start", { type: "step-start" });
ev("text", { type: "text", text: s.text() });
ev("step_finish", { type: "step-finish", reason: "stop", tokens: { input: s.turn.tokens?.in ?? 100, output: s.turn.tokens?.out ?? 20, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.002 });
s.logEnd("ok");

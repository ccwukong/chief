#!/usr/bin/env node
/**
 * Stand-in for the Claude Code CLI in e2e tests. It reproduces the parts of the headless
 * contract chief relies on (see docs/adapters/claude-code.md): `--version`, `mcp list`,
 * and `-p --output-format stream-json` with sessions, `--resume`, SIGINT and usage.
 *
 * Behaviour is scripted from the prompt: `<fake>{"turns":[{...},{...}]}</fake>`.
 * One entry per turn of the session. Turn fields:
 *   output        object   JSON to finish with (side_effects defaults to [])
 *   needs_input   {question, proposed}
 *   text          string   raw reply instead of a JSON block
 *   sleep_ms      number   wait before replying (SIGINT during the wait ends the turn)
 *   crash_times   number   exit 1 without a result for the first N sessions started with this prompt
 *   error         true | string  finish with an error result (a string is its message)
 *   cost          number   total_cost_usd for the turn (default 0.01)
 *   tokens        {in, out}
 *   write_file    {path, content}  simulate a tool writing a file
 *   tools         [{name, input, result, is_error}]  tool calls made before the reply
 *   by_start      [turn, turn, …]  the turn to play for the 1st, 2nd, … session started with this
 *                 prompt (the last one repeats): a step that fails once and works when retried
 * Without a directive the reply is {"ok": true, "side_effects": []}, unless FAKE_CLAUDE_RULES
 * points to a JSON file of [{ match, turns }] rules matched against the first prompt.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { exitAfterFlush, readStdin, sleep } from "./node-compat.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

if (argv.includes("--version")) { console.log(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.311"} (Claude Code)`); await exitAfterFlush(0); }

// The servers this "Claude Code" has. FAKE_CLAUDE_MCP_LIST=<file> replaces them (same text format as `claude mcp list`).
const mcpListText = process.env.FAKE_CLAUDE_MCP_LIST ? readFileSync(process.env.FAKE_CLAUDE_MCP_LIST, "utf8") : [
  "Checking MCP server health…", "",
  "claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected",
  "claude.ai GitHub Custom: https://api.githubcopilot.com/mcp - ✔ Connected",
  "claude.ai Atlassian: https://mcp.atlassian.com/v1/mcp - ✔ Connected",
  "claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected",
  "claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication",
].join("\n") + (() => {
  // Servers that this "Claude Code" has only in the folder it runs in (like local scope or .mcp.json):
  // the lines of fake-mcp-list.txt there, in the same format.
  try { return "\n" + readFileSync(join(process.cwd(), "fake-mcp-list.txt"), "utf8").trim(); } catch { return ""; }
})();

if (argv[0] === "mcp" && argv[1] === "list") {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ event: "mcp-list", ts: Date.now() }) + "\n");
  console.log(mcpListText);
  await exitAfterFlush(0);
}

// The SDK control protocol: answer `control_request` lines, never run a turn.
//   initialize  → the model list
//   mcp_status  → the servers and their connection status
// FAKE_CLAUDE_MCP_SLOW=1: the first answers are empty, then still connecting, like the real CLI
// right after it starts. FAKE_CLAUDE_NO_INIT_MCP=1: an older CLI without mcp_status.
if (argv.includes("--input-format")) {
  const log = (event: string) => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ event, ts: Date.now() }) + "\n"); };
  const fileDefs: Record<string, any> = (() => { try { return JSON.parse(readFileSync(join(process.cwd(), ".mcp.json"), "utf8")).mcpServers ?? {}; } catch { return {}; } })();
  const servers = [...mcpListText.matchAll(/^(.+?): .+ - (✔|!|✘)/gm)].map((m) => ({
    name: m[1], status: m[2] === "✔" ? "connected" : m[2] === "!" ? "needs-auth" : "failed",
    scope: m[1].startsWith("claude.ai ") ? "claudeai" : "project", config: m[1].startsWith("claude.ai ") ? { type: "claudeai-proxy" } : fileDefs[m[1]],
  }));
  let polls = 0;
  let buf = "";
  const answer = (req: any) => {
    const ok = (response: object) => emit({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response } });
    if (req.request?.subtype === "initialize") {
      log("models");
      ok({ models: [
        { value: "default", resolvedModel: "claude-fable-5-1", displayName: "Default (recommended)", description: "Fable 5.1" },
        { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work" },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient" },
        { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Fastest" },
      ] });
    } else if (req.request?.subtype === "mcp_status" && !process.env.FAKE_CLAUDE_NO_INIT_MCP) {
      if (++polls === 1) log("mcp-control");
      const slow = !!process.env.FAKE_CLAUDE_MCP_SLOW;
      if (slow && polls <= 2) ok({ mcpServers: [] });
      else if (slow && polls <= 4) ok({ mcpServers: servers.map((s) => ({ ...s, status: s.status === "connected" ? "pending" : s.status })) });
      else ok({ mcpServers: servers });
    } else {
      emit({ type: "control_response", response: { subtype: "error", request_id: req.request_id, error: `Unsupported control request subtype: ${req.request?.subtype}` } });
    }
  };
  setTimeout(() => { void exitAfterFlush(0); }, 15_000); // chief ends the process once it has its answer
  for await (const chunk of process.stdin) {
    buf += new TextDecoder().decode(chunk as Buffer);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) answer(JSON.parse(line)); }
  }
  await exitAfterFlush(0);
}

if (!argv.includes("-p")) { console.error("fake-claude: only -p, --version and `mcp list` are supported"); await exitAfterFlush(64); }

const stdinText = await readStdin();

// chief reads the server list from the init line of a throw-away session and then kills it.
// FAKE_CLAUDE_NO_INIT_MCP=1 simulates a CLI whose init line does not report servers.
if (stdinText.startsWith("chief-mcp-probe")) {
  const servers = [...mcpListText.matchAll(/^(.+?): .+ - (✔|!|✘)/gm)].map((m) => ({ name: m[1], status: m[2] === "✔" ? "connected" : m[2] === "!" ? "needs-auth" : "failed", source: "fake" }));
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ event: "mcp-probe", ts: Date.now() }) + "\n");
  emit({ type: "system", subtype: "init", session_id: randomUUID(), model: "claude-fake-1", tools: [], ...(process.env.FAKE_CLAUDE_NO_INIT_MCP ? {} : { mcp_servers: servers }) });
  await sleep(process.env.FAKE_CLAUDE_NO_INIT_MCP ? 50 : 5000); // killed by chief as soon as it has the list
  await exitAfterFlush(0);
}

const stateDir = process.env.FAKE_CLAUDE_STATE ?? "/tmp/fake-claude-state";
mkdirSync(stateDir, { recursive: true });
const prompt = stdinText;
const resume = flag("--resume");
const model = flag("--model") ?? "claude-fake-1";

let session: { id: string; first_prompt: string; turn: number };
if (resume) {
  const f = join(stateDir, `${resume}.json`);
  if (!existsSync(f)) { emit({ type: "result", subtype: "error_during_execution", is_error: true, result: `No conversation found with session ID: ${resume}`, session_id: resume, total_cost_usd: 0 }); await exitAfterFlush(1); }
  session = JSON.parse(readFileSync(f, "utf8"));
} else {
  session = { id: randomUUID(), first_prompt: prompt, turn: 0 };
}
const save = () => writeFileSync(join(stateDir, `${session.id}.json`), JSON.stringify(session));

// How many sessions have been started with this exact first prompt (for crash_times).
const promptKey = join(stateDir, `prompt-${createHash("sha1").update(session.first_prompt).digest("hex")}.count`);
let starts = existsSync(promptKey) ? Number(readFileSync(promptKey, "utf8")) : 0;
if (!resume) { starts++; writeFileSync(promptKey, String(starts)); }

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, prompt, cwd: process.cwd(), session: session.id, resume: resume ?? null, turn: session.turn, pid: process.pid, ts: Date.now() }) + "\n");
}
const logEnd = (how: string) => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ event: "end", how, session: session.id, pid: process.pid, ts: Date.now() }) + "\n"); };

const m = session.first_prompt.match(/<fake>([\s\S]*?)<\/fake>/);
let script: any = {};
if (m) { try { script = JSON.parse(m[1]); } catch (e) { console.error("fake-claude: bad <fake> directive: " + e); await exitAfterFlush(65); } }
// Prompts that cannot carry a directive (the shipped examples) are scripted from a rules file:
// FAKE_CLAUDE_RULES=<json file> with [{ "match": "<substring of the first prompt>", "turns": [...] }].
let ruled = false;
if (!m && process.env.FAKE_CLAUDE_RULES) {
  const rule = (JSON.parse(readFileSync(process.env.FAKE_CLAUDE_RULES, "utf8")) as any[]).find((r) => session.first_prompt.includes(r.match));
  if (rule) { script = rule; ruled = true; }
}
const turns: any[] = script.turns ?? (m || ruled ? [script] : []);
const scripted = turns[session.turn] ?? {};
const turn = Array.isArray(scripted.by_start) ? scripted.by_start[Math.min(starts, scripted.by_start.length) - 1] ?? {} : scripted;
session.turn++;
save();

emit({ type: "system", subtype: "init", session_id: session.id, model, tools: ["ToolSearch"], mcp_servers: [], permissionMode: "default" });

const usage = () => ({ input_tokens: turn.tokens?.in ?? 100, output_tokens: turn.tokens?.out ?? 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const result = (extra: object) => emit({ type: "result", session_id: session.id, usage: usage(), modelUsage: { [model]: {} }, permission_denials: [], num_turns: 1, ...extra });

if (turn.crash_times && starts <= turn.crash_times) { console.error("fake-claude: simulated crash"); logEnd("crash"); await exitAfterFlush(1); }

if (turn.sleep_ms) {
  let interrupted = false;
  process.on("SIGINT", () => { interrupted = true; });
  const until = Date.now() + turn.sleep_ms;
  while (Date.now() < until && !interrupted) await sleep(25);
  if (interrupted) { result({ subtype: "error_during_execution", is_error: true, total_cost_usd: 0.001 }); logEnd("sigint"); await exitAfterFlush(0); }
}

if (turn.write_file) writeFileSync(turn.write_file.path, turn.write_file.content ?? "");

// Tool calls come before the result, whether the turn ends in an error or not: a CLI can make
// calls and then fail, and chief's record (and "what went wrong?") shows them.
for (const [i, t] of (turn.tools ?? []).entries()) {
  emit({ type: "assistant", message: { role: "assistant", model, content: [{ type: "tool_use", id: `toolu_${i}`, name: t.name, input: t.input ?? {} }] }, session_id: session.id });
  emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: t.result ?? "", is_error: !!t.is_error }] }, session_id: session.id });
}

if (turn.error) { result({ subtype: "error_during_execution", is_error: true, result: typeof turn.error === "string" ? turn.error : "simulated agent error", total_cost_usd: turn.cost ?? 0.01 }); await exitAfterFlush(0); }

let text: string;
if (turn.text !== undefined) text = turn.text;
else {
  const body = turn.needs_input
    ? { status: "needs_input", question: turn.needs_input.question, proposed: turn.needs_input.proposed ?? null, side_effects: turn.needs_input.side_effects ?? [] }
    : { side_effects: [], ...(turn.output ?? { ok: true }) };
  text = "Done.\n\n```json\n" + JSON.stringify(body, null, 2) + "\n```";
}
emit({ type: "assistant", message: { role: "assistant", model, content: [{ type: "text", text }] }, session_id: session.id });
result({ subtype: "success", is_error: false, result: text, total_cost_usd: turn.cost ?? 0.01 });
logEnd("ok");

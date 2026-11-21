#!/usr/bin/env node
/**
 * Stand-in for NousResearch Hermes Agent: `hermes --version`, and
 * `hermes chat -q "<prompt>" --format stream-json [--resume <id>] [-m <model>]`
 * with the documented JSONL events (system, text, tool_use, tool_result, result).
 *
 * Two things the real CLI documents are reproduced on purpose: the `session_id:` line stays on
 * **stderr** (chief must never parse stderr), and the process exit code matches the terminal
 * `result` record's `exit_code` (0, 1, 130 or 75).
 */
import { scripted } from "./fake-agent-core.ts";
import { exitAfterFlush } from "./node-compat.ts";

const argv = process.argv.slice(2);
/** Every event carries `timestamp` in epoch milliseconds. */
const emit = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify({ timestamp: Date.now(), ...o }) + "\n");
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv.includes("--version")) { console.log("hermes 0.21.3"); await exitAfterFlush(0); }
if (argv[0] !== "chat" || flag("--format") !== "stream-json") {
  console.error('fake-hermes: only `chat -q "<prompt>" --format stream-json` is supported');
  await exitAfterFlush(64);
}
const prompt = flag("-q") ?? flag("--query");
if (!prompt) { console.error("fake-hermes: --format stream-json requires -q"); await exitAfterFlush(64); }

const s = scripted("hermes", argv, prompt, flag("--resume") ?? flag("-r"));
const model = flag("-m") ?? flag("--model") ?? "hermes-fake";
const id = s.sessionId;

// The real CLI prints diagnostics and the session line on stderr; parse only stdout.
process.stderr.write(`session_id: ${id}\n`);
emit({ type: "system", subtype: "init", model, session_id: id });

if (s.crash) { console.error("fake-hermes: simulated crash"); s.logEnd("crash"); await exitAfterFlush(1); }
// chief paused (SIGINT): the terminal record still arrives, with exit_code 130.
if (await s.sleep()) {
  emit({ type: "result", session_id: id, exit_code: 130, text: "", error: "interrupted", duration_ms: 1 });
  s.logEnd("sigint"); await exitAfterFlush(130);
}
if (s.turn.rate_limited) {
  emit({ type: "result", session_id: id, exit_code: 75, text: "", error: "provider rate limited (simulated)", duration_ms: 1 });
  s.logEnd("rate-limited"); await exitAfterFlush(75);
}
// Hermes itself was interrupted (not by chief): same 130 record, and the session can be resumed.
if (s.turn.interrupt) {
  emit({ type: "result", session_id: id, exit_code: 130, text: "", error: "interrupted", duration_ms: 1 });
  s.logEnd("interrupted"); await exitAfterFlush(130);
}
if (s.turn.error) {
  emit({ type: "result", session_id: id, exit_code: 1, text: "", error: "simulated agent error", duration_ms: 1 });
  s.logEnd("error"); await exitAfterFlush(1);
}

emit({ type: "tool_use", name: "read_file", input: { path: "x" } });
emit({ type: "tool_result", name: "read_file", output: "x", duration_ms: 2, is_error: false });
// `text` is a delta: two of them make the whole reply, and `result.text` repeats it whole.
const text = s.text();
const cut = Math.max(1, Math.floor(text.length / 2));
emit({ type: "text", text: text.slice(0, cut) });
emit({ type: "text", text: text.slice(cut) });
const tokens = {
  input: s.turn.tokens?.in ?? 100,
  output: s.turn.tokens?.out ?? 20,
  total: (s.turn.tokens?.in ?? 100) + (s.turn.tokens?.out ?? 20),
  cache_read: s.turn.tokens?.cache_read ?? 7,
  cache_write: s.turn.tokens?.cache_write ?? 3,
};
emit({ type: "result", session_id: id, exit_code: 0, text, tokens, duration_ms: 5 });
s.logEnd("ok");

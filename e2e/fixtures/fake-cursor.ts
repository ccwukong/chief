#!/usr/bin/env node
/**
 * Stand-in for the Cursor CLI: `--version` and `-p --output-format stream-json … "<prompt>"`
 * with the documented events (system/init, assistant, result). The prompt is the last argument.
 */
import { scripted } from "./fake-agent-core.ts";
import { exitAfterFlush } from "./node-compat.ts";

const argv = process.argv.slice(2);
const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

if (argv.includes("--version")) { console.log("2026.10.28-1a2b3c4"); await exitAfterFlush(0); }
if (argv[0] === "models") { console.log("Available models\n\n  auto - Let Cursor choose\n  gpt-5\n  sonnet-4.5 - Anthropic\n\nTip: use --model to pick one"); await exitAfterFlush(0); }
if (!argv.includes("-p") || flag("--output-format") !== "stream-json") { console.error("fake-cursor: only -p --output-format stream-json is supported"); await exitAfterFlush(64); }

const prompt = argv.at(-1)!;
const model = flag("--model") ?? "cursor-fake-1";
const s = scripted("cursor", argv.slice(0, -1), prompt, flag("--resume"));

emit({ type: "system", subtype: "init", apiKeySource: "login", cwd: process.cwd(), session_id: s.sessionId, model, permissionMode: "default" });
if (s.crash) { console.error("fake-cursor: simulated crash"); s.logEnd("crash"); await exitAfterFlush(1); }
if (await s.sleep()) { s.logEnd("sigint"); await exitAfterFlush(130); }
if (s.turn.error) { console.error("fake-cursor: simulated agent error"); s.logEnd("error"); await exitAfterFlush(1); }
const text = s.text();
emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: s.sessionId });
emit({ type: "result", subtype: "success", is_error: false, duration_ms: 1200, duration_api_ms: 1200, result: text, session_id: s.sessionId });
s.logEnd("ok");

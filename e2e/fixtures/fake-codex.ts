#!/usr/bin/env node
/**
 * Stand-in for the OpenAI Codex CLI: `codex --version` and `codex exec [resume <id>] --json … -`
 * with the documented JSONL events (thread.started, turn.started, item.completed, turn.completed).
 */
import { scripted } from "./fake-agent-core.ts";
import { exitAfterFlush, readStdin } from "./node-compat.ts";

const argv = process.argv.slice(2);
const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

if (argv.includes("--version")) { console.log("codex-cli 0.63.0"); await exitAfterFlush(0); }
if (argv[0] !== "exec" || !argv.includes("--json")) { console.error("fake-codex: only `exec --json` is supported"); await exitAfterFlush(64); }

const resume = argv[1] === "resume" ? argv[2] : undefined;
const prompt = argv.at(-1) === "-" ? await readStdin() : argv.at(-1)!;
const s = scripted("codex", argv, prompt, resume);

emit({ type: "thread.started", thread_id: s.sessionId });
emit({ type: "turn.started" });
if (s.crash) { console.error("fake-codex: simulated crash"); s.logEnd("crash"); await exitAfterFlush(1); }
if (await s.sleep()) { s.logEnd("sigint"); await exitAfterFlush(130); }
if (s.turn.error) { emit({ type: "turn.failed", error: { message: "simulated agent error" } }); s.logEnd("error"); await exitAfterFlush(1); }
emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: s.text() } });
emit({ type: "turn.completed", usage: { input_tokens: s.turn.tokens?.in ?? 100, cached_input_tokens: 0, output_tokens: s.turn.tokens?.out ?? 20, reasoning_output_tokens: 0 } });
s.logEnd("ok");

/**
 * Shared scripting for the fake Codex, Cursor, Antigravity and OpenCode CLIs. Same `<fake>{"turns":[…]}</fake>` directive,
 * session state and invocation log as fake-claude.ts (which stays self-contained).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { die, sleep } from "./node-compat.ts";

export interface Scripted {
  sessionId: string;
  turn: any;
  /** True when this turn is scripted to crash for this session start. */
  crash: boolean;
  logEnd: (how: string) => void;
  /** Wait for the scripted sleep; resolves true when SIGINT arrived first. */
  sleep: () => Promise<boolean>;
  /** Final reply text for the turn. */
  text: () => string;
}

/** `extra` is added to the invocation log line (for example the environment a CLI was given). */
export function scripted(cli: string, argv: string[], prompt: string, resume: string | undefined, extra: Record<string, unknown> = {}): Scripted {
  const stateDir = process.env.FAKE_CLAUDE_STATE ?? "/tmp/fake-claude-state";
  mkdirSync(stateDir, { recursive: true });
  let session: { id: string; first_prompt: string; turn: number };
  if (resume) {
    const f = join(stateDir, `${resume}.json`);
    if (!existsSync(f)) die(1, `${cli}: no session ${resume}`);
    session = JSON.parse(readFileSync(f, "utf8"));
  } else session = { id: randomUUID(), first_prompt: prompt, turn: 0 };

  const key = join(stateDir, `prompt-${createHash("sha1").update(cli + session.first_prompt).digest("hex")}.count`);
  let starts = existsSync(key) ? Number(readFileSync(key, "utf8")) : 0;
  if (!resume) { starts++; writeFileSync(key, String(starts)); }

  const log = process.env.FAKE_CLAUDE_LOG;
  if (log) appendFileSync(log, JSON.stringify({ cli, argv, prompt, cwd: process.cwd(), session: session.id, resume: resume ?? null, turn: session.turn, pid: process.pid, ts: Date.now(), ...extra }) + "\n");

  const m = session.first_prompt.match(/<fake>([\s\S]*?)<\/fake>/);
  const script = m ? JSON.parse(m[1]) : {};
  const turn = (script.turns ?? (m ? [script] : []))[session.turn] ?? {};
  session.turn++;
  writeFileSync(join(stateDir, `${session.id}.json`), JSON.stringify(session));

  return {
    sessionId: session.id,
    turn,
    crash: !!turn.crash_times && starts <= turn.crash_times,
    logEnd: (how) => { if (log) appendFileSync(log, JSON.stringify({ event: "end", cli, how, session: session.id, pid: process.pid, ts: Date.now() }) + "\n"); },
    sleep: async () => {
      if (!turn.sleep_ms) return false;
      let interrupted = false;
      process.on("SIGINT", () => { interrupted = true; });
      const until = Date.now() + turn.sleep_ms;
      while (Date.now() < until && !interrupted) await sleep(25);
      return interrupted;
    },
    text: () => {
      if (turn.text !== undefined) return turn.text;
      const body = turn.needs_input
        ? { status: "needs_input", question: turn.needs_input.question, proposed: turn.needs_input.proposed ?? null, side_effects: turn.needs_input.side_effects ?? [] }
        : { side_effects: [], ...(turn.output ?? { ok: true }) };
      return "Done.\n\n```json\n" + JSON.stringify(body, null, 2) + "\n```";
    },
  };
}

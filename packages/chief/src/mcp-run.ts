/**
 * Run one of the CLI's own `mcp` commands, the way a person would type it, and show what it prints.
 *
 * The page shows the exact command (`claude mcp add --transport stdio slack -- npx -y pkg`), the person edits the
 * name or the package in place, presses Run, and reads the output as it arrives — including the messages a stdio
 * server prints while the CLI starts it.
 *
 * **No shell.** The text is split by a tokenizer of our own, so `"` and `'` group an argument and nothing is ever
 * expanded, substituted or piped: `$(…)`, `|`, `;`, backticks and globs are passed as ordinary characters, which is
 * also why a value can contain a space without quoting beyond what the CLI itself expects. On top of that the argv
 * is checked before it runs: it must start with **this adapter's own program** and its second word must be `mcp`, so
 * the box can only ever run the CLI's MCP command and not, say, `rm`.
 *
 * Why not just run anything: a free-text command box that runs what it is given is a remote shell for anything that
 * can reach the local server. This one is a shortcut for one family of commands, and says so when it is not one.
 */
import { adapterBin, adapterPrograms, getAdapter } from "./adapters/index.ts";
import type { Store } from "./store/store.ts";
import { runProcess } from "./util/proc.ts";

export type CmdStatus = "running" | "done" | "failed" | "cancelled";

export interface CmdRun {
  id: string;
  adapter: string;
  argv: string[];
  /** What will actually run, quoted for reading. */
  command: string;
  status: CmdStatus;
  /** Every line the command printed, in order, as it arrived: stdout and stderr interleaved by arrival. */
  lines: string[];
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
}

interface Live extends CmdRun {
  cancel: () => void;
}

/**
 * Split a command line into argv, POSIX-style for quoting only.
 *
 * `'…'` is literal, `"…"` allows `\"` and `\\`, a backslash outside quotes escapes the next character, and
 * whitespace separates words. Nothing else is special: there is no expansion, no comment, no operator.
 */
export function splitCommand(text: string): string[] | { error: string } {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let seen = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null; else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) { cur += text[++i]; continue; }
      if (c === '"') quote = null; else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; seen = true; continue; }
    if (c === "\\") { if (i + 1 < text.length) { cur += text[++i]; seen = true; } continue; }
    if (c === " " || c === "\t" || c === "\n") {
      if (cur || seen) { out.push(cur); cur = ""; seen = false; }
      continue;
    }
    // An operator is not a command separator here: it is a character that reached us by mistake.
    if (c === "|" || c === ";" || c === "`" || c === "$" || c === "&" || c === ">" || c === "<") {
      return { error: `"${c}" has no meaning here: this runs one command, not a shell line` };
    }
    cur += c; seen = true;
  }
  if (quote) return { error: `a ${quote === "'" ? "single" : "double"} quote is never closed` };
  if (cur || seen) out.push(cur);
  return out;
}

/** `argv` quoted for a person to read back, so a value with a space is visibly one argument. */
export function quoteArgv(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(" ");
}

const MAX_MS = 5 * 60_000;
const KEEP_MS = 10 * 60_000;
const MAX_LINES = 4000;
const runs = new Map<string, Live>();
let seq = 0;

const prune = () => {
  const now = Date.now();
  for (const [id, r] of runs) {
    const ended = r.finishedAt ?? r.startedAt;
    if (now - ended > (r.finishedAt ? KEEP_MS : MAX_MS)) { if (!r.finishedAt) r.cancel(); runs.delete(id); }
  }
};

const view = (r: Live): CmdRun => ({
  id: r.id, adapter: r.adapter, argv: r.argv, command: r.command, status: r.status,
  lines: r.lines.slice(-MAX_LINES), exitCode: r.exitCode, startedAt: r.startedAt, finishedAt: r.finishedAt,
});

export function runMcpCommand(store: Store, adapterName: string, text: string, cwd: string): CmdRun {
  prune();
  // Resolves the CLI's path (and throws for a name chief does not know) before anything is spawned.
  if (!getAdapter(store, adapterName)) throw new Error(`unknown agent CLI "${adapterName}"`);
  const parts = splitCommand(text.trim());
  if (!Array.isArray(parts)) throw new Error(parts.error);
  if (!parts.length) throw new Error("type the command to run");
  // The one rule that makes this box safe: this CLI's program, and its `mcp` subcommand.
  const [program, sub] = parts;
  const allowed = adapterPrograms(store, adapterName);
  const name = program.split("/").pop() ?? program;
  if (!allowed.includes(program) && !allowed.includes(name)) {
    throw new Error(`this box runs ${adapterName}'s own program (${adapterBin(store, adapterName)}), not ${program}`);
  }
  if (sub !== "mcp") throw new Error(`this box runs the CLI's mcp command, not "${parts.slice(0, 2).join(" ")}"`);

  const id = `${adapterName}-${++seq}`;
  let asked = false;
  const live: Live = {
    id, adapter: adapterName, argv: parts, command: quoteArgv(parts), status: "running",
    lines: [], exitCode: null, startedAt: Date.now(), finishedAt: null, cancel: () => { asked = true; },
  };
  runs.set(id, live);

  void runProcess({
    argv: parts, cwd, timeoutMs: MAX_MS, env: process.env as Record<string, string>,
    // The whole point: a stdio server prints as it starts, so both streams are followed live rather than at the end.
    onStdoutLine: (line) => { if (live.lines.length < MAX_LINES) live.lines.push(line); },
    shouldStop: () => (asked ? "cancel" : null),
  }).then((r) => {
    live.finishedAt = Date.now();
    live.exitCode = r.code;
    // stderr is kept too, marked, because a CLI that refuses usually says so there.
    for (const line of r.stderr.split("\n")) if (line.trim() && live.lines.length < MAX_LINES) live.lines.push(`! ${line}`);
    if (r.spawnError) live.lines.push(`! ${r.spawnError}`);
    if (r.timedOut) live.lines.push("! it did not finish within five minutes");
    // The exit code is not the answer with these CLIs (they print a refusal and exit 0), so a refusal is read from
    // the output as well — the same lesson the sign-in learned.
    const refused = /no mcp server named|is not configured|already exists|error:/i.test(live.lines.join("\n"));
    live.status = r.stopped === "cancel" ? "cancelled" : r.code === 0 && !r.spawnError && !refused ? "done" : "failed";
  }).catch((e: any) => {
    live.finishedAt = Date.now(); live.status = "failed"; live.lines.push(`! ${e?.message ?? String(e)}`);
  });

  return view(live);
}

export function mcpCommandState(id: string): CmdRun | null {
  prune();
  const r = runs.get(id);
  return r ? view(r) : null;
}

export function cancelMcpCommand(id: string): CmdRun {
  const r = runs.get(id);
  if (!r) throw new Error("that command is no longer running");
  r.cancel();
  return view(r);
}

/** What the box offers as a starting point: the CLI's own add command, written for a real example. */
export function commandTemplate(store: Store, adapterName: string): string {
  const bin = adapterBin(store, adapterName);
  return adapterName === "claude-code"
    ? `${bin} mcp add --transport stdio <name> -- npx -y <package>`
    : `${bin} mcp add <name> npx -y <package>`;
}

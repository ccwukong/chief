/**
 * MCP sign-in, carried out through the CLI's own login command.
 *
 * An OAuth flow cannot be a one-shot spawn: the CLI prints an authorization URL, a person approves it in
 * a browser, and only then does the redirect come back — on the same stdin. So the child is held open in
 * a registry, its output is parsed for the URL, and the pasted redirect is written back when it arrives.
 *
 * What chief does **not** do (AGENTS.md): it never sees, stores or forwards a credential. The token is
 * exchanged by the CLI and kept by the CLI; the authorization code in the redirect is handed straight to
 * the waiting child, never written to the database, the run record or the log. The registry holds it in
 * memory for the length of one flow and drops it when the child exits.
 */
import type { AgentAdapter } from "./adapters/types.ts";
import { runProcess } from "./util/proc.ts";

export type AuthStatus = "starting" | "waiting_url" | "waiting_redirect" | "done" | "failed" | "cancelled";

export interface AuthFlow {
  id: string;
  adapter: string;
  name: string;
  action: "login" | "logout";
  mode: "url" | "browser";
  status: AuthStatus;
  /** The command being run, so the page can show it: a sign-in that touches your credentials is readable first. */
  command: string;
  /** The authorization URL the CLI printed, for the page to link. Never a credential. */
  url: string | null;
  /** What the CLI printed, trimmed: enough for a person to see what happened, and no secrets. */
  output: string;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface Live extends AuthFlow {
  write: ((text: string) => void) | null;
  cancel: () => void;
}

/** A flow nobody finished is dropped after this: an abandoned login must not hold a child for ever. */
const MAX_MS = 10 * 60_000;
/** Kept a while after it ends, so the page can show the result after the wait. */
const KEEP_MS = 10 * 60_000;

const flows = new Map<string, Live>();
let seq = 0;

const prune = () => {
  const now = Date.now();
  for (const [id, f] of flows) {
    const ended = f.finishedAt ?? f.startedAt;
    const tooOld = now - ended > (f.finishedAt ? KEEP_MS : MAX_MS);
    if (tooOld) { if (!f.finishedAt) f.cancel(); flows.delete(id); }
  }
};

/** The view the page gets: no writer, no cancel handle. */
const view = (f: Live): AuthFlow => ({
  id: f.id, adapter: f.adapter, name: f.name, action: f.action, mode: f.mode, status: f.status, command: f.command,
  url: f.url, output: f.output.slice(-4000), error: f.error, startedAt: f.startedAt, finishedAt: f.finishedAt,
});

const URL_RE = /https?:\/\/[^\s"'<>]+/;

/**
 * Start a sign-in (or sign-out) for one server.
 *
 * `url` mode is the full flow in chief's window: the CLI is asked not to open a browser and to print the
 * URL, the page shows it and a box for the redirect. `browser` mode is a CLI that opens the browser
 * itself: chief starts it, keeps the child for its output, and reports the exit — and also picks up a URL
 * if one appears, so a CLI that turns out to print one is not a dead end.
 */
/**
 * Start a sign-in (or sign-out) for one server.
 *
 * The exit code is **not** the answer: these CLIs report "No MCP server named …" and still exit 0, which
 * made chief claim "signed in" when nothing had happened (reported 2026-11-21). So the result is decided by
 * `verify` — the server re-reads the CLI's own list and says whether the status actually changed — and the
 * CLI's output is quoted when it did not.
 */
export function beginMcpAuth(
  adapter: AgentAdapter,
  opts: { action: "login" | "logout"; name: string; cwd: string; verify?: () => Promise<boolean> },
): AuthFlow {
  prune();
  if (!adapter.mcpAuth) throw new Error(`${adapter.name} has no command for sign-in`);
  const plan = adapter.mcpAuth(opts);
  if (!plan) throw new Error(`${adapter.name} has no command for ${opts.action === "login" ? "signing in" : "signing out"}`);
  const id = `${adapter.name}-${++seq}`;
  let askedToStop = false;
  const live: Live = {
    id, adapter: adapter.name, name: opts.name, action: opts.action, mode: plan.mode, command: plan.command,
    status: "starting", url: null, output: "", error: null, startedAt: Date.now(), finishedAt: null,
    write: null, cancel: () => { askedToStop = true; },
  };
  flows.set(id, live);

  // The run is awaited in the background: the page polls for its state instead of holding a request open
  // for as long as a person takes to click through an OAuth screen.
  void runProcess({
    argv: plan.argv,
    cwd: opts.cwd,
    timeoutMs: MAX_MS,
    env: process.env as Record<string, string>,
    // Cancelling is a signal to the whole process group, the same way a paused run is stopped.
    shouldStop: () => (askedToStop ? "cancel" : null),
    stdinOpen: plan.mode === "url" ? (write) => { live.write = write; live.status = "waiting_redirect"; } : undefined,
    onStdoutLine: (line) => {
      live.output += `${line}\n`;
      if (!live.url) {
        const m = URL_RE.exec(line);
        // The authorization URL, not just any link: it is the one that opens the consent page.
        if (m && /authorize|oauth|consent|login|auth/i.test(m[0])) { live.url = m[0]; live.status = "waiting_redirect"; }
        else if (m) live.url = live.url ?? m[0];
      }
    },
  }).then(async (r) => {
    live.finishedAt = Date.now();
    live.write = null;
    if (r.stopped === "cancel") { live.status = "cancelled"; return; }
    if (r.timedOut) { live.status = "failed"; live.error = "the sign-in was not finished within ten minutes"; return; }
    if (r.spawnError) { live.status = "failed"; live.error = r.spawnError; return; }
    const said = `${r.stdout}\n${r.stderr}`.trim();
    // A refusal the CLI reports without failing: "No MCP server named …" arrives with exit code 0, so it is
    // looked for in the output as well as in the code.
    const refused = /no mcp server named|not found|unknown server|is not configured/i.test(said);
    if (r.code !== 0 || refused) {
      live.status = "failed";
      live.error = (said || `exit code ${r.code}`).slice(0, 600);
      return;
    }
    // The only trustworthy answer is the CLI's own list, re-read: the status has to have changed.
    let changed = true;
    if (opts.verify) {
      try { changed = await opts.verify(); } catch { changed = false; }
    }
    live.finishedAt = Date.now();
    if (!changed) {
      live.status = "failed";
      live.error = "the CLI finished but nothing changed: its list still reports the same status" + (said ? ` (it said: ${said.slice(0, 300)})` : "");
      return;
    }
    live.status = "done";
  }).catch((e: any) => {
    live.finishedAt = Date.now(); live.status = "failed"; live.error = e?.message ?? String(e);
  });

  return view(live);
}

/**
 * What a sign-in would run, without starting it: the argv the CLI would be given. Same reason as `apply`'s
 * dry run — and it means the slug-to-name translation can be checked without touching anyone's account.
 */
export function planMcpAuth(adapter: AgentAdapter, opts: { action: "login" | "logout"; name: string; cwd: string }) {
  if (!adapter.mcpAuth) throw new Error(`${adapter.name} has no command for signing in`);
  const plan = adapter.mcpAuth(opts);
  if (!plan) throw new Error(`${adapter.name} has no command for ${opts.action === "login" ? "signing in" : "signing out"}`);
  return { command: plan.command, mode: plan.mode, note: plan.note ?? null };
}

/** Hand the pasted redirect back to the waiting CLI. The code is written to the pipe and nowhere else. */
export function answerMcpAuth(id: string, redirect: string): AuthFlow {
  const f = flows.get(id);
  if (!f) throw new Error("that sign-in is no longer waiting");
  if (!f.write) throw new Error("that sign-in is not waiting for a redirect");
  const text = redirect.trim();
  if (!text) throw new Error("paste the URL the browser landed on");
  f.output += "(redirect pasted)\n"; // the value itself is never echoed, logged or stored
  f.write(`${text}\n`);
  return view(f);
}

export function cancelMcpAuth(id: string): AuthFlow {
  const f = flows.get(id);
  if (!f) throw new Error("that sign-in is no longer running");
  f.cancel();
  if (!f.finishedAt) { f.status = "cancelled"; f.finishedAt = Date.now(); }
  return view(f);
}

export function mcpAuthState(id: string): AuthFlow | null {
  prune();
  const f = flows.get(id);
  return f ? view(f) : null;
}

export function mcpAuthList(): AuthFlow[] {
  prune();
  return [...flows.values()].map(view).sort((a, b) => b.startedAt - a.startedAt);
}

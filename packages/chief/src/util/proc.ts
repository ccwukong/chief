import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type StopReason = "pause" | "cancel" | null;

export interface ProcOptions {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  /** Called for every complete stdout line as it arrives. */
  onStdoutLine?: (line: string) => void;
  /** Called once the process exists, with an identity that survives a chief crash. */
  onSpawn?: (child: ChildIdentity) => void;
  /** Polled while the process runs; a non-null answer stops it (pause → SIGINT, cancel → SIGTERM). */
  shouldStop?: () => StopReason;
  maxOutputBytes?: number;
}

export interface ProcResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stopped: StopReason;
  truncated: boolean;
  spawnError?: string;
}

const live = new Set<number>();
let hooked = false;

function killGroup(pid: number, signal: NodeJS.Signals) {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

/** Children run in their own process group; make sure none outlive chief. */
function hookExit() {
  if (hooked) return;
  hooked = true;
  process.on("exit", () => { for (const pid of live) killGroup(pid, "SIGKILL"); });
}

/**
 * Spawn a process in its own process group, stream stdout line by line, and enforce
 * timeout / pause / cancel by signalling the whole group.
 *
 * On `node:child_process`: a missing binary arrives as an `error` event rather than a thrown
 * error, `close` (not `exit`) is what says the pipes have been drained, and the input has to be
 * written and ended by hand.
 */
export async function runProcess(o: ProcOptions): Promise<ProcResult> {
  hookExit();
  const max = o.maxOutputBytes ?? 20 * 1024 * 1024;
  let child: ChildProcess;
  try {
    child = spawn(o.argv[0], o.argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  } catch (e: any) {
    return { code: null, signal: null, stdout: "", stderr: "", timedOut: false, stopped: null, truncated: false, spawnError: e?.message ?? String(e) };
  }

  let spawnError: string | undefined;
  child.on("error", (e: any) => { spawnError ??= e?.message ?? String(e); });
  const pid = child.pid;
  if (pid == null) {
    return { code: null, signal: null, stdout: "", stderr: "", timedOut: false, stopped: null, truncated: false, spawnError: spawnError ?? `could not start ${o.argv[0]}` };
  }
  live.add(pid);
  if (o.onSpawn) o.onSpawn({ pid, started: processStart(pid) });

  let timedOut = false;
  let stopped: StopReason = null;
  let truncated = false;
  let escalate: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: NodeJS.Signals) => {
    killGroup(pid, signal);
    escalate ??= setTimeout(() => killGroup(pid, "SIGKILL"), 5000);
  };
  const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; stop("SIGTERM"); }, o.timeoutMs) : undefined;
  const poll = o.shouldStop
    ? setInterval(() => {
        if (stopped || spawnError) return;
        const r = o.shouldStop!();
        if (r) { stopped = r; stop(r === "pause" ? "SIGINT" : "SIGTERM"); }
      }, 250)
    : undefined;

  // The child may exit before reading its whole input (a `--version` probe, a CLI that ignores
  // stdin): that is not an error for us.
  child.stdin?.on("error", () => { /* EPIPE */ });
  child.stdin?.end(o.stdin ?? "");

  const readOut = (async () => {
    const dec = new TextDecoder();
    let buf = "", all = "";
    const stdout = child.stdout!;
    for await (const chunk of stdout as AsyncIterable<Uint8Array>) {
      const text = dec.decode(chunk, { stream: true });
      if (all.length + text.length > max) { truncated = true; stop("SIGTERM"); stdout.destroy(); break; }
      all += text;
      if (o.onStdoutLine) {
        buf += text;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) o.onStdoutLine(line); }
      }
    }
    if (o.onStdoutLine && buf.trim()) o.onStdoutLine(buf);
    return all;
  })();

  const readErr = (async () => {
    let all = "";
    try {
      for await (const chunk of child.stderr as AsyncIterable<Buffer>) all += chunk.toString();
    } catch { /* the stream was closed under us */ }
    return all.slice(0, 200_000);
  })();

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => child.once("close", (code, signal) => res({ code, signal })));

  const [stdout, stderr, status] = await Promise.all([readOut, readErr, exited]);
  clearTimeout(timer); clearTimeout(escalate); clearInterval(poll);
  live.delete(pid);
  if (spawnError) return { code: null, signal: null, stdout, stderr, timedOut, stopped, truncated, spawnError };
  return { code: status.code, signal: status.signal == null ? null : String(status.signal), stdout, stderr, timedOut, stopped, truncated };
}

export interface ChildIdentity { pid: number; started: string | null }

/** Start time of a process as reported by `ps`, used to tell a process from a later one that reuses its pid. */
export function processStart(pid: number): string | null {
  const r = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** Kill a child (and its process group) left behind by a chief process that died. */
export function killOrphan(child: ChildIdentity): boolean {
  if (!child?.pid || !child.started || processStart(child.pid) !== child.started) return false;
  killGroup(child.pid, "SIGTERM");
  setTimeout(() => { if (processStart(child.pid) === child.started) killGroup(child.pid, "SIGKILL"); }, 3000).unref?.();
  return true;
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/**
 * Resolve a binary on PATH (or return it unchanged when it is a path that exists).
 * The agent CLIs are found nowhere else, so it has to work for a bare name, a relative path and
 * an absolute one.
 */
export function which(bin: string): string | null {
  if (!bin) return null;
  const look = (p: string) => {
    try { accessSync(p, constants.X_OK); return existsSync(p) ? p : null; } catch { return null; }
  };
  if (isAbsolute(bin)) return look(bin);
  if (bin.includes("/")) return look(bin);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const hit = look(join(dir, bin));
    if (hit) return hit;
  }
  return null;
}

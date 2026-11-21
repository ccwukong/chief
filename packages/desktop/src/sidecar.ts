import { spawn, type ChildProcess } from "node:child_process";
import type { Log } from "./log.ts";
export class SidecarError extends Error {
  readonly lines: string[];
  constructor(message: string, lines: string[]) {
    super(message);
    this.lines = lines;
  }
}
export interface SidecarOptions {
  /** The program that runs the server: the app's own binary, which is Node when ELECTRON_RUN_AS_NODE is set. */
  runtime: string;
  script: string;
  env: NodeJS.ProcessEnv;
  log: Log;
  /** Called when the server ends without having been asked to. */
  onLost: (why: { code: number | null; signal: string | null; lines: string[] }) => void;
  startTimeoutMs?: number;
}
/**
 * `chief serve --port 0 --no-open` as a child process of the app. It is the same bundle the CLI runs,
 * so the engine, the database and the scheduler are the ones `chief serve` has; the app is a window
 * over it. The port is the one the server prints; the page is shown once `/api/meta` answers.
 */
export class Sidecar {
  private opts: SidecarOptions;
  private child: ChildProcess | null = null;
  private stopping = false;
  private tail: string[] = [];
  port = 0;
  constructor(opts: SidecarOptions) {
    this.opts = opts;
  }
  /** The last lines the server printed, for a message that says why it did not start. */
  lastLines(): string[] { return [...this.tail]; }
  get url(): string { return `http://127.0.0.1:${this.port}`; }
  get pid(): number | undefined { return this.child?.pid; }
  async start(): Promise<number> {
    const { runtime, script, env, log } = this.opts;
    this.stopping = false;
    this.tail = [];
    this.port = 0;
    log.note(`starting ${script} serve --port 0 --no-open`);
    const child = spawn(runtime, [script, "serve", "--port", "0", "--no-open"], {
      // The pipe on stdin is how the server learns that the app is gone (CHIEF_EXIT_WITH_PARENT), even after a crash.
      env: { ...env, ELECTRON_RUN_AS_NODE: "1", CHIEF_EXIT_WITH_PARENT: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin!.on("error", () => { /* the server ended */ });
    let portSeen: (port: number) => void = () => {};
    const portLine = new Promise<number>((res) => { portSeen = res; });
    const feed = (chunk: Buffer, buf: { s: string }) => {
      const text = chunk.toString();
      log.raw(text);
      buf.s += text;
      let i: number;
      while ((i = buf.s.indexOf("\n")) >= 0) {
        const line = buf.s.slice(0, i).replace(/\r$/, "");
        buf.s = buf.s.slice(i + 1);
        if (!line.trim()) continue;
        this.tail.push(line);
        if (this.tail.length > 40) this.tail.shift();
        const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
        if (m && !this.port) portSeen(Number(m[1]));
      }
    };
    const out = { s: "" }, err = { s: "" };
    child.stdout!.on("data", (d) => feed(d, out));
    child.stderr!.on("data", (d) => feed(d, err));
    const ended = new Promise<{ code: number | null; signal: string | null }>((res) => child.once("close", (code, signal) => res({ code, signal })));
    child.once("error", (e) => { this.tail.push(String(e.message)); });
    let started = false;
    void ended.then(({ code, signal }) => {
      log.note(`server ended (code ${code}, signal ${signal})`);
      if (this.child === child) this.child = null;
      if (started && !this.stopping) this.opts.onLost({ code, signal, lines: this.lastLines() });
    });
    const failed = (message: string) => new SidecarError(message, this.lastLines());
    const first = await Promise.race([
      portLine.then((port) => ({ port })),
      ended.then((e) => ({ ended: e })),
      new Promise<{ timeout: true }>((res) => setTimeout(() => res({ timeout: true }), this.opts.startTimeoutMs ?? 30_000).unref()),
    ]);
    if ("ended" in first) throw failed(`The server stopped before it was ready (${first.ended.signal ?? `exit code ${first.ended.code}`}).`);
    if ("timeout" in first) { await this.stop(); throw failed("The server did not report a port in time."); }
    this.port = first.port;
    // The port is printed once the socket is bound; /api/meta answering says the app is up.
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 30_000);
    for (;;) {
      try {
        const res = await fetch(`${this.url}/api/meta`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) break;
      } catch { /* not yet */ }
      if (!this.child) throw failed("The server stopped before it answered.");
      if (Date.now() > deadline) { await this.stop(); throw failed("The server did not answer in time."); }
      await new Promise((r) => setTimeout(r, 100));
    }
    started = true;
    log.note(`server is up on ${this.url} (pid ${child.pid})`);
    return this.port;
  }
  /** SIGTERM, then SIGKILL after a few seconds. The server's exit hook kills the agent CLIs it started. */
  async stop(graceMs = 5000): Promise<void> {
    const child = this.child;
    this.stopping = true;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((res) => child.once("close", () => res()));
    child.kill("SIGTERM");
    const killer = setTimeout(() => { this.opts.log.note("the server ignored SIGTERM; sending SIGKILL"); child.kill("SIGKILL"); }, graceMs);
    await closed;
    clearTimeout(killer);
  }
}

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve as nodeServe } from "@hono/node-server";
import { EngineError, recover } from "../engine/engine.ts";
import { debugLogging, describeEvent, enableLog, log, logDebug } from "../log.ts";
import { which } from "../util/proc.ts";
import { dbPath, defaultWorkspace } from "../paths.ts";
import type { Store } from "../store/store.ts";
import { createApp, diskAssets, type WebAssets } from "./app.ts";
import { detectProviders } from "../providers.ts";
import { startScheduler } from "./scheduler.ts";

async function loadAssets(): Promise<WebAssets | null> {
  try {
    // Present only in a build: scripts/build.ts generates it from packages/web/dist.
    // @ts-expect-error the module exists only during a build
    const mod = await import("./web-assets.generated.ts");
    if (mod?.assets) return mod.assets as WebAssets;
  } catch { /* not a build */ }
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../../../web/dist");
  return existsSync(join(dist, "index.html")) ? diskAssets(dist) : null;
}

/**
 * Open the web UI in the person's browser, with the system's opener (`open` on macOS, `xdg-open` on
 * Linux, `start` on Windows) or the command in CHIEF_BROWSER with the URL as its argument. Failing
 * to open is logged, never fatal: the URL is printed anyway.
 */
function openBrowser(url: string): string | null {
  const own = process.env.CHIEF_BROWSER?.trim();
  const [cmd, args] = own ? [own, [url]] : process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  // `spawn` reports a missing command asynchronously, after this returns; the caller has to know
  // now that nothing was opened, so the command is looked up first.
  const found = cmd.includes("/") ? (existsSync(cmd) ? cmd : null) : which(cmd);
  if (!found) return `${cmd}: no such command`;
  try {
    const child = spawn(found, args, { stdio: "ignore", detached: true });
    child.on("error", () => { /* the URL is printed by the caller anyway */ });
    child.unref();
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

/** Listen on 127.0.0.1, with no timeout that would cut an SSE stream, and resolve once bound. */
function listen(fetch: (req: Request) => Response | Promise<Response>, port: number): Promise<Server> {
  return new Promise((res, rej) => {
    const server = nodeServe({ fetch, hostname: "127.0.0.1", port }) as unknown as Server;
    server.once("error", rej);
    server.once("listening", () => {
      server.off("error", rej);
      // Node's own request timeout (5 min) would end a long-lived stream; the keep-alive timeout
      // applies between requests, so it is left generous but finite.
      server.requestTimeout = 0;
      server.headersTimeout = 60_000;
      server.keepAliveTimeout = 65_000;
      res(server);
    });
  });
}

export async function serve(store: Store, port: number, opts: { open?: boolean } = {}) {
  // The terminal shows what the server does: requests that change something or fail, runs and
  // steps as they start, finish or fail, gates waiting, MCP servers read. CHIEF_LOG=debug: everything.
  enableLog();
  const names = new Map<number, string | null>();
  const workflowOf = (runId: number) => {
    if (!names.has(runId)) { const r = store.getRun(runId); names.set(runId, r ? store.getWorkflow(r.workflow_id)?.name ?? null : null); }
    return names.get(runId) ?? null;
  };
  store.onEvent = (e) => {
    const line = describeEvent({ ...e, workflow: workflowOf(e.runId) });
    if (line) (line.debug ? logDebug : log)(line.text);
  };
  for (const id of recover(store)) log(`run ${id} was interrupted by a previous exit; resume it from the Runs page or with: chief resume ${id}`);
  store.pruneDrafts();
  // Which agent CLIs are there, so the app can say so on its first page rather than at the first run
  // (task 15.15). In the background: a CLI that hangs on `--version` must not hold the server up.
  void detectProviders(store).then((ps) => {
    const found = ps.filter((p) => p.found).map((p) => p.name);
    log(found.length ? `agent CLIs found: ${found.join(", ")}` : "no agent CLI found: a run cannot start until one is installed");
  }).catch((e) => logDebug(`could not look for the agent CLIs: ${e?.message ?? e}`));
  const assets = await loadAssets();
  let actualPort = port;
  const { app, launch } = createApp(store, { port: () => actualPort, assets });
  // Hono on Node. Two things have to be set by hand: the request and header timeouts are disabled
  // so a long SSE stream is never cut, and a port already in use arrives as the server's `error`
  // event instead of a thrown error.
  let server: Server;
  try {
    server = await listen(app.fetch, port);
  } catch {
    // Almost always: another `chief serve` is still running on this port.
    let other = "";
    try {
      const meta = await (await fetch(`http://127.0.0.1:${port}/api/meta`, { signal: AbortSignal.timeout(1500) })).json();
      if (meta?.adapters) other = " by another chief server";
    } catch { /* not a chief server, or not answering */ }
    throw new EngineError(`port ${port} is already in use${other}. Stop that process first (Ctrl+C in its terminal, or find it with: lsof -nP -iTCP:${port} -sTCP:LISTEN), or start this one on another port: chief serve --port ${port + 1}`);
  }
  const address = server.address();
  actualPort = typeof address === "object" && address ? address.port : port;
  // CHIEF_SCHEDULER_NOW pins the scheduler's clock (tests only).
  const pinned = process.env.CHIEF_SCHEDULER_NOW ? new Date(process.env.CHIEF_SCHEDULER_NOW) : null;
  startScheduler(store, launch, pinned ? () => pinned : undefined);
  console.log(`chief is serving on http://127.0.0.1:${actualPort}${assets ? "" : "  (web UI not built: API only)"}`);
  // Node ends a process on SIGTERM/SIGINT without running its `exit` handlers, and the exit handler in
  // util/proc.ts is what kills the agent CLIs this server started (they run in their own process
  // groups). Leaving through process.exit keeps them from outliving the server; the runs they were
  // in are marked interrupted by `recover` on the next start.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => process.exit(0));
  // The desktop app starts this server with a pipe on its stdin. When the app goes away, even by a
  // crash or a kill, the pipe closes and the server follows, so no second server can end up running
  // over the same database next to the one the next app start launches.
  if (process.env.CHIEF_EXIT_WITH_PARENT) {
    process.stdin.on("end", () => process.exit(0));
    process.stdin.on("close", () => process.exit(0));
    process.stdin.resume();
  }
  log(`database ${dbPath()}`);
  log(`workflow folders in ${store.getSetting<string | null>("workspace-dir", null) || defaultWorkspace()} (unless a workflow sets its own)`);
  log(`logging changes, runs and failures${debugLogging() ? ", and every request (CHIEF_LOG=debug)" : "; set CHIEF_LOG=debug to see every request"}`);
  // The page opens by itself once the server listens; `--no-open` (or no built web UI) skips it.
  if (opts.open && assets) {
    const url = `http://127.0.0.1:${actualPort}`;
    const problem = openBrowser(url);
    if (problem) log(`could not open the browser (${problem}); open ${url} yourself`);
    else log(`opened ${url} in your browser (chief serve --no-open to skip this)`);
  }
  return { server, port: actualPort };
}

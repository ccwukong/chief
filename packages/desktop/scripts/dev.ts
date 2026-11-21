/**
 * `npm run dev:desktop` — the app as a window over a live development setup.
 *
 * Three processes, each reloading on its own:
 *
 *   the web UI      Vite on http://127.0.0.1:5173, so a page or a stylesheet edit is in the window
 *                   without a reload (hot module replacement);
 *   the server      `packages/chief/src/cli.ts serve` from source under `node --watch` on
 *                   http://127.0.0.1:8080, so an edit to the engine restarts it in place;
 *   the app itself  `src/main.ts` bundled by esbuild into `dist/desktop-dev/app/main.cjs`; when that
 *                   bundle changes the app is relaunched.
 *
 * The window starts no sidecar in this mode: `CHIEF_DESKTOP_DEV_URL` makes it show the Vite page and
 * leave the server to this script (see `src/main.ts`). The Vite dev server proxies `/api` to 8080 as
 * the server's own host and origin (`packages/web/vite.config.ts`), so the server's host/origin guard
 * still accepts writes.
 *
 * Development only. `npm run build:desktop` and the packaged app do not use any of this.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { context, type BuildContext } from "esbuild";
import { ensureDevBundle } from "./dev-bundle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const root = resolve(pkg, "../..");
const stage = join(root, "dist/desktop-dev");
const appDir = join(stage, "app");
// The ports can be moved (CHIEF_DEV_API, CHIEF_DEV_WEB_PORT), which is how the e2e case runs the loop
// beside whatever else is on this machine. Vite reads the first one for its proxy's target.
const API = process.env.CHIEF_DEV_API ?? "http://127.0.0.1:8080";
const WEB_PORT = Number(process.env.CHIEF_DEV_WEB_PORT ?? 5173);
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const electronApp = join(root, "node_modules/electron/dist/Electron.app");
/** Vite is the web package's dependency and need not be hoisted to the root. */
const viteBin = join(dirname(createRequire(join(root, "packages/web/package.json")).resolve("vite/package.json")), "bin/vite.js");
const icon = join(pkg, "assets/icon.icns");
const version: string = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
const electronVersion: string = JSON.parse(readFileSync(join(root, "node_modules/electron/package.json"), "utf8")).version;

if (process.platform !== "darwin") {
  console.error("The chief desktop app is macOS only (docs/desktop.md).");
  process.exit(1);
}
for (const [what, file] of [["Electron", electronApp], ["Vite", viteBin], ["the app icon", icon]] as const) {
  if (!existsSync(file)) {
    console.error(`${what} is not installed (${file} is missing). Run \`npm install\` first.`);
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;
let electron: ChildProcess | null = null;
let server: ChildProcess | null = null;
let vite: ChildProcess | null = null;
let watcher: BuildContext | null = null;
let relaunching = false;
let pendingRelaunch = false;

/** SIGTERM, then SIGKILL after a few seconds. A detached child is a process-group leader, so its own children go with it. */
async function stop(child: ChildProcess | null, group = false, graceMs = 4000): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((res) => child.once("close", () => res()));
  const send = (signal: NodeJS.Signals) => {
    try { if (group) process.kill(-child.pid!, signal); else child.kill(signal); } catch { /* already gone */ }
  };
  send("SIGTERM");
  const killer = setTimeout(() => send("SIGKILL"), graceMs);
  // The grace on top of SIGKILL keeps a missed "close" from hanging the whole shutdown.
  await Promise.race([closed, sleep(graceMs + 2000)]);
  clearTimeout(killer);
}

async function shutdown(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log("\nchief dev: stopping the app, the server and the web UI");
  await Promise.all([stop(electron), stop(vite, true), stop(server, true)]);
  await watcher?.dispose().catch(() => { /* nothing to clean up */ });
  process.exit(code);
}

// SIGHUP too: a loop started in the background of a shell goes away with that shell, and the server and
// Vite it started (in their own process groups, so their own agent CLIs go with them) must not stay.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal as NodeJS.Signals, () => void shutdown(0));

/** A process started in its own group, so a stop takes the children it started as well. */
function start(command: string, args: string[], env: NodeJS.ProcessEnv = process.env, cwd = root): ChildProcess {
  return spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "inherit", "inherit"] });
}

async function ready(url: string, child: ChildProcess, what: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${what} exited (code ${child.exitCode}) before it was ready`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${what} did not answer on ${url} within ${ms / 1000} s`);
    await sleep(250);
  }
}

async function startApp(): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, CHIEF_DESKTOP_DEV_URL: WEB };
  delete env.ELECTRON_RUN_AS_NODE; // inherited from a shell that serves the CLI, it would run Electron as Node
  // chief's own bundle, so the menu bar says chief and the Dock shows chief's icon, not Electron's.
  const executable = ensureDevBundle({ electronApp, out: join(stage, "chief.app"), icon, electronVersion });
  const child = spawn(executable, [appDir], { env, stdio: "inherit" });
  electron = child;
  child.once("exit", (code) => {
    if (electron === child) electron = null;
    if (stopping || relaunching) return;
    console.log(`\nchief dev: the app exited (${code === null ? "a signal" : `code ${code}`}); stopping the development servers`);
    void shutdown(code ?? 0);
  });
}

/** Relaunch the app on a main-process change. A change during a relaunch is remembered, never dropped. */
async function relaunchApp(): Promise<void> {
  if (stopping) return;
  if (relaunching) { pendingRelaunch = true; return; }
  relaunching = true;
  try {
    console.log("chief dev: the main process changed; restarting the app");
    await stop(electron);
    if (!stopping) await startApp();
  } finally {
    relaunching = false;
    if (pendingRelaunch) { pendingRelaunch = false; void relaunchApp(); }
  }
}

/** Is the development API port free? A second server on it would be a second scheduler over one database. */
function free(port: number): Promise<boolean> {
  return new Promise((res) => {
    const probe = createServer();
    probe.once("error", () => res(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => res(true)));
  });
}

async function main(): Promise<void> {
  const apiPort = Number(new URL(API).port);
  if (!(await free(apiPort))) {
    console.error(`chief dev: port ${apiPort} is already in use (another \`chief serve\` or \`npm run serve:dev\`). Stop it first.`);
    process.exit(1);
  }

  // A stage of its own: the development bundle never mixes with dist/desktop, the one the e2e cases launch.
  // The renamed Electron app beside it is kept, since it is rebuilt only when Electron or the icon changes.
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "chief", productName: "chief", version, main: "main.cjs", description: "chief for macOS", license: "Apache-2.0" }, null, 2) + "\n");

  let firstBuildDone: () => void = () => {};
  const firstBuild = new Promise<void>((res) => { firstBuildDone = res; });
  let firstBuildFailed = false;
  watcher = await context({
    entryPoints: [join(pkg, "src/main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22",
    outfile: join(appDir, "main.cjs"), external: ["electron"], sourcemap: false, logLevel: "warning",
    plugins: [{
      name: "relaunch-on-change",
      setup(build) {
        let first = true;
        let timer: NodeJS.Timeout | undefined;
        build.onEnd((result) => {
          if (result.errors.length) {
            console.error("chief dev: the main process did not build; the running app keeps the last good one");
            if (first) { first = false; firstBuildFailed = true; firstBuildDone(); }
            return;
          }
          if (first) { first = false; firstBuildDone(); return; }
          clearTimeout(timer);
          timer = setTimeout(() => void relaunchApp(), 300);
        });
      },
    }],
  });
  await watcher.watch();
  await firstBuild;
  if (firstBuildFailed) throw new Error("the main process did not build (see the errors above)");

  server = start(process.execPath, ["--watch", join(root, "packages/chief/src/cli.ts"), "serve", "--port", String(apiPort), "--no-open"]);
  vite = start(process.execPath, [viteBin, "--port", String(WEB_PORT), "--strictPort"], { ...process.env, CHIEF_DEV_API: API }, join(root, "packages/web"));
  await Promise.all([ready(`${API}/api/meta`, server, "the server"), ready(`${WEB}/`, vite, "the web UI")]);

  console.log(`\nchief dev: web UI ${WEB} (hot reload), server ${API} (restarts on an engine change)`);
  console.log("chief dev: edit a page, the engine or the main process; Ctrl+C stops everything\n");
  await startApp();
}

void main().catch(async (e: unknown) => {
  console.error(`\nchief dev: ${(e as Error)?.message ?? String(e)}`);
  await shutdown(1);
});

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, ROOT_DIR } from "../helpers";
export { expect, ROOT_DIR };
export const STAGE = join(ROOT_DIR, "dist/desktop");
export const ELECTRON_BIN = join(ROOT_DIR, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
export const APP_DIR = join(STAGE, "app");
export const VERSION: string = JSON.parse(readFileSync(join(ROOT_DIR, "packages/desktop/package.json"), "utf8")).version;
function newest(dir: string): number {
  let t = 0;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const s = statSync(p);
    t = Math.max(t, s.isDirectory() ? newest(p) : s.mtimeMs);
  }
  return t;
}
let built: Promise<void> | null = null;
/** The server bundle and the app, built once per run and again only when a source is newer. All desktop cases share one worker, so this does not race. */
export function ensureDesktopBuilt(): Promise<void> {
  built ??= (async () => {
    const sources = Math.max(...["packages/chief/src", "packages/web/src", "packages/desktop/src", "packages/desktop/scripts"].map((d) => newest(join(ROOT_DIR, d))), statSync(join(ROOT_DIR, "packages/desktop/package.json")).mtimeMs);
    const main = join(APP_DIR, "main.cjs");
    if (existsSync(main) && statSync(main).mtimeMs >= sources && statSync(join(STAGE, "server/chief.mjs")).mtimeMs >= sources) return;
    execSync("npm run build && npm run build --workspace desktop", { cwd: ROOT_DIR, stdio: "inherit" });
  })();
  return built;
}
export interface Desktop {
  app: ElectronApplication;
  page: Page;
  /** The server the window shows, e.g. http://127.0.0.1:51234 */
  url: string;
  logPath: string;
  log: () => string;
  api: <T = any>(path: string) => Promise<T>;
  /** Quit through the app (⌘Q) and wait for the process to end. */
  quit: () => Promise<void>;
}
export interface LaunchOptions {
  /** Added to the app's environment; `undefined` removes a variable the harness would set. */
  env?: Record<string, string | undefined>;
  /** Launch this built app (`…/chief.app/Contents/MacOS/chief`) instead of the staged one. */
  executable?: string;
  /** Do not wait for the window to show the server (a case about a server that does not start). */
  waitForServer?: boolean;
}
export const test = base.extend<{ desktop: { launch: (o?: LaunchOptions) => Promise<Desktop>; fakeHome: string; root: string; env: () => Record<string, string> } }>({
  desktop: async ({ chief }, use) => {
    await ensureDesktopBuilt();
    // A home of its own with an empty .zshrc: the login shell the app asks for its environment is then quick and knows nothing of the person running the suite.
    const fakeHome = join(chief.home, "..", "fake-home");
    mkdirSync(fakeHome, { recursive: true });
    if (!existsSync(join(fakeHome, ".zshrc"))) writeFileSync(join(fakeHome, ".zshrc"), "");
    const root = join(chief.home, ".."); // chief's folder: CHIEF_HOME's parent holds logs/ and desktop/ too
    const running: { app: ElectronApplication; proc: ReturnType<ElectronApplication["process"]> }[] = [];
    const env = () => {
      const e: Record<string, string> = { ...chief.env, HOME: fakeHome, SHELL: "/bin/zsh" };
      delete e.ELECTRON_RUN_AS_NODE;
      // zsh reads its startup files from $ZDOTDIR when that is set, which would bypass the fake home.
      delete e.ZDOTDIR;
      return e;
    };
    const launch = async (o: LaunchOptions = {}): Promise<Desktop> => {
      const merged: Record<string, string | undefined> = { ...env(), ...o.env };
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
      const app = await electron.launch(o.executable ? { executablePath: o.executable, env: merged as Record<string, string>, timeout: 60_000 } : { args: [APP_DIR], env: merged as Record<string, string>, timeout: 60_000 });
      running.push({ app, proc: app.process() });
      const page = await app.firstWindow();
      const logPath = join(root, "logs", "chief.log");
      const d: Desktop = {
        app, page, logPath, url: "",
        log: () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : ""),
        api: async (path) => (await fetch(d.url + path)).json() as any,
        quit: async () => {
          const exited = new Promise<void>((res) => app.process().once("exit", () => res()));
          await app.evaluate(({ app }) => app.quit()).catch(() => {});
          await exited;
        },
      };
      if (o.waitForServer !== false) {
        await expect.poll(() => page.url(), { timeout: 45_000 }).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
        d.url = new URL(page.url()).origin;
      }
      return d;
    };
    await use({ launch, fakeHome, root, env });
    for (const { app, proc } of running) {
      if (proc.exitCode === null) { await app.close().catch(() => {}); if (proc.exitCode === null) proc.kill("SIGKILL"); }
    }
  },
});

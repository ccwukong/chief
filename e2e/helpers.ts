import { test as base, expect, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT_DIR = ROOT;
export const CLI = join(ROOT, "packages/chief/src/cli.ts");
/**
 * Select a step's tab on a run's page.
 *
 * The steps of a run are tabs (task 15.93): only the selected step's row is in the DOM, so a case that inspects a step
 * other than the one in view must select it first. Harmless when the tab is already selected, and a no-op on a page that
 * has no step tabs (the run has not started), so a case may call it unconditionally.
 */
export async function showStep(page: Page, nodeId: string): Promise<void> {
  const tab = page.getByTestId(`node-tab-${nodeId}`);
  if (await tab.count()) await tab.click();
}

export const FAKE_CLAUDE = join(ROOT, "e2e/fixtures/fake-claude.ts");
export const FAKE_CODEX = join(ROOT, "e2e/fixtures/fake-codex.ts");
export const FAKE_CURSOR = join(ROOT, "e2e/fixtures/fake-cursor.ts");
export const FAKE_ANTIGRAVITY = join(ROOT, "e2e/fixtures/fake-antigravity.ts");
export const FAKE_OPENCODE = join(ROOT, "e2e/fixtures/fake-opencode.ts");
export const FAKE_HERMES = join(ROOT, "e2e/fixtures/fake-hermes.ts");
export const EXAMPLES = join(ROOT, "examples");

export interface CliResult { code: number; stdout: string; stderr: string; json: <T = any>() => T }

export interface Server {
  url: string;
  port: number;
  proc: ChildProcess;
  /** Call the JSON API. Returns status and parsed body (or text when it is not JSON). */
  api: <T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: T }>;
  stop: () => Promise<void>;
  /** Everything the server printed so far (stdout and stderr). */
  output: () => string;
}

export interface Chief {
  /** Isolated CHIEF_HOME for this test. */
  home: string;
  /** Working directory for this test's workflow files and scripts (inside the user's home, so the sandbox accepts it as cwd). */
  dir: string;
  env: Record<string, string>;
  run: (args: string[], opts?: { env?: Record<string, string>; cwd?: string }) => CliResult;
  /** Start the CLI without waiting for it. */
  start: (args: string[], opts?: { env?: Record<string, string> }) => { proc: ChildProcess; done: Promise<CliResult> };
  /** Write a file under `dir` and return its path. */
  file: (name: string, content: string, mode?: number) => string;
  /** Write a workflow YAML under `dir`, import it, and return the import result. */
  importWorkflow: (yaml: string, extraArgs?: string[]) => CliResult;
  /** Invocations recorded by the fake Claude CLI. */
  calls: () => { cli?: string; argv: string[]; prompt: string; cwd: string; session: string; resume: string | null; turn: number; pid: number; ts: number }[];
  /** How often chief asked the fake Claude CLI for its MCP servers: over the control protocol, by session probe, and by `mcp list`. */
  mcpReads: () => { control: number; probes: number; lists: number };
  /** How each fake Claude process ended: ok, sigint or crash. */
  ends: () => { how: string; session: string; pid: number; ts: number }[];
  /** Start `chief serve` on a free port and wait until it answers. */
  serve: (opts?: { env?: Record<string, string> }) => Promise<Server>;
  /** Poll until `fn` returns a truthy value. */
  until: <T>(fn: () => T | Promise<T>, timeoutMs?: number) => Promise<T>;
}

function result(code: number | null, stdout: string, stderr: string): CliResult {
  return { code: code ?? -1, stdout, stderr, json: () => { try { return JSON.parse(stdout); } catch { throw new Error(`not JSON:\n${stdout}\n${stderr}`); } } };
}

export const test = base.extend<{ chief: Chief }>({
  chief: async ({}, use, testInfo) => {
    // The unique part goes last and is never cut off: two runs of one test must not share a directory.
    const title = testInfo.titlePath.slice(1).join("-").replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 70).toLowerCase();
    const slug = `${title}-${testInfo.repeatEachIndex}-${testInfo.retry}-${testInfo.workerIndex}`;
    // chief's home must not sit inside a script's working directory (it is a protected path).
    const base = join(ROOT, "e2e/.tmp", slug);
    rmSync(base, { recursive: true, force: true });
    const dir = join(base, "work");
    mkdirSync(join(base, "home"), { recursive: true });
    mkdirSync(dir, { recursive: true });
    const log = join(base, "fake-claude.log");
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CHIEF_HOME: join(base, "home"),
      CHIEF_CLAUDE_BIN: FAKE_CLAUDE,
      // Codex, Cursor, Antigravity, OpenCode and Hermes are "not installed" unless a test points these at the fakes.
      CHIEF_CODEX_BIN: "/nonexistent/codex",
      CHIEF_CURSOR_BIN: "/nonexistent/cursor-agent",
      CHIEF_ANTIGRAVITY_BIN: "/nonexistent/agy",
      CHIEF_OPENCODE_BIN: "/nonexistent/opencode",
      CHIEF_HERMES_BIN: "/nonexistent/hermes",
      CODEX_HOME: join(base, "codex-home"),
      CURSOR_CONFIG_HOME: join(base, "cursor-home"),
      HERMES_HOME: join(base, "hermes-home"),
      FAKE_AGY_MCP: join(base, "agy-mcp.json"),
      OPENCODE_CONFIG: join(base, "opencode.json"),
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_STATE: join(base, "fake-state"),
      CHIEF_NOTIFY_LOG: join(base, "notify.log"),
      // The MCP list is re-asked until it has settled; tests do not need to wait half a second each time.
      CHIEF_MCP_POLL_MS: "40",
    };
    // Node warns on stderr when NO_COLOR and FORCE_COLOR are both set: the harness's own colour
    // settings must not reach the product's output (case E9.9-3 compares chief's stderr exactly).
    delete env.NO_COLOR;
    const procs: ChildProcess[] = [];
    const lines = (): any[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    const chief: Chief = {
      home: env.CHIEF_HOME, dir, env,
      run: (args, opts = {}) => {
        const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...opts.env }, cwd: opts.cwd ?? dir, encoding: "utf8", timeout: 120_000 });
        return result(r.status, r.stdout ?? "", r.stderr ?? "");
      },
      start: (args, opts = {}) => {
        const proc = spawn(process.execPath, [CLI, ...args], { env: { ...env, ...opts.env }, cwd: dir });
        procs.push(proc);
        let stdout = "", stderr = "";
        proc.stdout!.on("data", (d) => (stdout += d));
        proc.stderr!.on("data", (d) => (stderr += d));
        const done = new Promise<CliResult>((res) => proc.on("close", (code) => res(result(code, stdout, stderr))));
        return { proc, done };
      },
      file: (name, content, mode) => {
        const p = join(dir, name);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content, mode ? { mode } : undefined);
        return p;
      },
      importWorkflow: (yaml, extraArgs = []) => {
        const name = yaml.match(/^name:\s*(\S+)/m)?.[1] ?? "wf";
        return chief.run(["workflow", "import", chief.file(`${name}.yaml`, yaml), "--json", ...extraArgs]);
      },
      serve: async (opts = {}) => {
        const { proc } = chief.start(["serve", "--port", "0", "--no-open"], opts);
        let out = "";
        proc.stdout!.on("data", (d) => (out += d));
        proc.stderr!.on("data", (d) => (out += d));
        const port = await chief.until(() => Number(out.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1]) || (proc.exitCode !== null ? Promise.reject(new Error("chief serve exited:\n" + out)) : 0), 15_000);
        const url = `http://127.0.0.1:${port}`;
        return {
          url, port, proc,
          output: () => out,
          api: async (method, path, body, headers = {}) => {
            const res = await fetch(url + path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
            const text = await res.text();
            let parsed: any = text;
            try { parsed = JSON.parse(text); } catch { /* text response */ }
            return { status: res.status, body: parsed };
          },
          stop: () => new Promise<void>((res) => { if (proc.exitCode !== null) return res(); proc.once("close", () => res()); proc.kill("SIGTERM"); }),
        };
      },
      calls: () => lines().filter((l) => !l.event),
      ends: () => lines().filter((l) => l.event === "end"),
      mcpReads: () => ({ control: lines().filter((l) => l.event === "mcp-control").length, probes: lines().filter((l) => l.event === "mcp-probe").length, lists: lines().filter((l) => l.event === "mcp-list").length }),
      until: async (fn, timeoutMs = 20_000) => {
        const t0 = Date.now();
        for (;;) {
          const v = await fn();
          if (v) return v;
          if (Date.now() - t0 > timeoutMs) throw new Error("until(): timed out");
          await new Promise((r) => setTimeout(r, 100));
        }
      },
    };
    // Tests use the fake CLI's MCP list unless they set their own.
    await use(chief);
    for (const p of procs) if (p.exitCode === null) p.kill("SIGKILL");
  },
});

export { expect };

/** Shorthand for a scripted fake-agent directive inside a prompt. */
export const fake = (...turns: object[]) => `<fake>${JSON.stringify({ turns })}</fake>`;

/**
 * The designer's layout choices that open everything (sidebar, blocks column, side panel), stored
 * the way the page stores them. On a window narrower than 1600 px the designer starts compact; the
 * browser cases were written for the open layout, so they begin as a user who opened it all would.
 * The case for the compact layout (E9.59-1) starts without this.
 */
export const ROOMY_LAYOUT_KEYS = ["ui:designer-panel-open", "ui:designer-blocks-open", "ui:designer-sidenav-open"];
export async function roomyLayout(srv: Server) {
  await srv.api("PUT", "/api/drafts/" + encodeURIComponent("ui:designer-panel-open"), { value: { compact: true, wide: true }, seq: 1 });
  await srv.api("PUT", "/api/drafts/" + encodeURIComponent("ui:designer-blocks-open"), { value: { compact: true, wide: true }, seq: 1 });
  await srv.api("PUT", "/api/drafts/" + encodeURIComponent("ui:designer-sidenav-open"), { value: true, seq: 1 });
}

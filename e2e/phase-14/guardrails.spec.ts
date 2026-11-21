import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { parse } from "yaml";
import { expect, ROOT_DIR, test } from "../helpers";

/**
 * Task 14.1: the corrections are encoded as rules, not comments.
 *
 * A lint rule that stops matching looks exactly like a clean codebase, so each one is made to fail
 * here on purpose. The sources are linted through ESLint's API with a path inside the repository
 * (`lintText` never writes a file), so this case cannot disturb another worker that is watching the
 * checkout — which is what a probe file did before.
 */

const eslint = new ESLint({ cwd: ROOT_DIR });

/** Lint `source` as if it were the file at `relPath`; returns whether it is an error and the messages. */
const lintAs = async (relPath: string, source: string) => {
  const results = await eslint.lintText(source, { filePath: join(ROOT_DIR, relPath) });
  const messages = results.flatMap((r) => r.messages);
  return { failed: messages.some((m) => m.severity === 2), out: messages.map((m) => `${m.ruleId}: ${m.message}`).join("\n") };
};

test("E14.1-1 the guardrails exist, fire on the mistakes they name, and let the legitimate case through", async () => {
  test.setTimeout(300_000);

  // ── the rules are declared ────────────────────────────────────────────────────────────────────
  const config = readFileSync(join(ROOT_DIR, "eslint.config.js"), "utf8");
  expect(config).toContain("local/no-raw-timers");
  expect(config).toContain("local/task-id-in-todos");
  expect(config).toContain("no-restricted-imports");
  expect(config, "the timers rule has exactly one allowlisted module").toContain("packages/web/src/polling.ts");
  const rules = readFileSync(join(ROOT_DIR, "eslint.local-rules.js"), "utf8");
  for (const name of ["no-raw-timers", "task-id-in-todos"]) expect(rules).toContain(`"${name}"`);
  const polling = readFileSync(join(ROOT_DIR, "packages/web/src/polling.ts"), "utf8");
  expect(polling).toContain("export function usePolling");
  expect(polling).toContain("export function useReveal");

  // ── the renderer/main boundary, in both directions ───────────────────────────────────────────
  const engineIntoPage = await lintAs("packages/web/src/probe-engine.ts", 'import "../../chief/src/store/store.ts";\nexport const a = 1;\n');
  expect(engineIntoPage.failed, engineIntoPage.out).toBe(true);
  expect(engineIntoPage.out).toContain("HTTP only");

  const pageIntoEngine = await lintAs("packages/chief/src/probe-web.ts", 'import "../../web/src/api.ts";\nexport const b = 1;\n');
  expect(pageIntoEngine.failed, pageIntoEngine.out).toBe(true);
  expect(pageIntoEngine.out).toContain("headless");

  // The page is the renderer; packages/desktop is the main process. Neither may reach into the other,
  // and the main process may not open the database (the server owns it).
  const mainIntoPage = await lintAs("packages/web/src/probe-main.ts", 'import "../../desktop/src/main.ts";\nexport const k = 1;\n');
  expect(mainIntoPage.failed, mainIntoPage.out).toBe(true);
  expect(mainIntoPage.out).toMatch(/never imports Electron|renderer/);

  const electronInPage = await lintAs("packages/web/src/probe-electron.ts", 'import { app } from "electron";\nexport const l = app;\n');
  expect(electronInPage.failed, electronInPage.out).toBe(true);

  const pageIntoMain = await lintAs("packages/desktop/src/probe-page.ts", 'import "../../web/src/api.ts";\nexport const m = 1;\n');
  expect(pageIntoMain.failed, pageIntoMain.out).toBe(true);
  expect(pageIntoMain.out).toMatch(/over HTTP/);

  const engineInMain = await lintAs("packages/desktop/src/probe-engine.ts", 'import { DatabaseSync } from "node:sqlite";\nexport const n = DatabaseSync;\n');
  expect(engineInMain.failed, engineInMain.out).toBe(true);
  expect(engineInMain.out).toContain("Only the server opens the database");

  // ── timers: the shapes that papered over a signal are refused… ───────────────────────────────
  const interval = await lintAs("packages/web/src/probe-interval.ts", "export const c = setInterval(() => {}, 1000);\n");
  expect(interval.failed, interval.out).toBe(true);
  expect(interval.out).toContain("usePolling");

  const zeroDelay = await lintAs("packages/web/src/probe-zero.ts", "export const d = setTimeout(() => {}, 0);\n");
  expect(zeroDelay.failed, zeroDelay.out).toBe(true);
  expect(zeroDelay.out).toContain("races the DOM");

  const noDelay = await lintAs("packages/web/src/probe-nodelay.ts", "export const e = setTimeout(() => {});\n");
  expect(noDelay.failed, noDelay.out).toBe(true);

  const frame = await lintAs("packages/web/src/probe-raf.ts", "export const f = requestAnimationFrame(() => {});\n");
  expect(frame.failed, frame.out).toBe(true);

  // …the sanctioned module is exempt…
  const allowed = await lintAs("packages/web/src/polling.ts", polling);
  expect(allowed.failed, allowed.out).toBe(false);

  // …and a timeout with a real delay, which is debouncing, is not a mistake.
  const debounce = await lintAs("packages/web/src/probe-debounce.ts", "export const g = setTimeout(() => {}, 400);\n");
  expect(debounce.failed, debounce.out).toBe(false);

  // ── a TODO must name the task that will handle it ────────────────────────────────────────────
  const anonymous = await lintAs("packages/web/src/probe-todo.ts", "// TODO: tidy this up later\nexport const h = 1;\n");
  expect(anonymous.failed, anonymous.out).toBe(true);
  expect(anonymous.out).toContain("names no task");

  const owned = await lintAs("packages/web/src/probe-todo-owned.ts", "// TODO(14.1): tidy this up later\nexport const i = 1;\n");
  expect(owned.failed, owned.out).toBe(false);

  // Prose that happens to contain the word is not a directive.
  const prose = await lintAs("packages/web/src/probe-prose.ts", "// The todo list is rendered below.\nexport const j = 1;\n");
  expect(prose.failed, prose.out).toBe(false);

  // ── the gates exist and are what they claim ──────────────────────────────────────────────────
  expect(existsSync(join(ROOT_DIR, ".github/workflows/ci.yml"))).toBe(true);
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8"));
  expect(pkg.scripts.lint, "warnings must fail the build").toContain("--max-warnings 0");
  const ci = readFileSync(join(ROOT_DIR, ".github/workflows/ci.yml"), "utf8");
  // `npm run check` is typecheck + lint (--max-warnings 0) + guardrails, so one step covers the three.
  for (const step of ["npm ci", "npm run build:web", "npm run check", "npx playwright test"]) expect(ci, step).toContain(step);
  // The suite runs on macOS, not Linux: the script sandbox has no Linux backend, so the script cases
  // cannot pass there and a Linux run reports "no script sandbox backend" as 51 unrelated failures
  // (task 15.19). The platform-independent gate may stay on Linux, and does.
  const parsed = parse(ci) as { jobs: Record<string, { "runs-on": string; steps: { run?: string }[] }> };
  const suites = Object.values(parsed.jobs).filter((j) => j.steps.some((s) => String(s.run ?? "").includes("npx playwright test")));
  expect(suites.length, "one job runs the suite").toBe(1);
  expect(suites[0]["runs-on"]).toMatch(/^macos/);

  // The real tree passes the gate it now enforces.
  const whole = spawnSync("npx", ["eslint", "packages", "e2e", "--max-warnings", "0"], { cwd: ROOT_DIR, encoding: "utf8", timeout: 240_000 });
  expect(whole.status, `${whole.stdout}${whole.stderr}`).toBe(0);
});

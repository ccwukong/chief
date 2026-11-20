import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, ROOT_DIR, test } from "../helpers";

/**
 * Task 14.2: the rules are usable without any particular editor or agent tool.
 *
 * `scripts/guardrails.mjs` is plain Node with no dependency, so the check below copies it into a
 * throw-away tree and breaks one rule at a time there. It never touches this checkout, which keeps it
 * safe beside cases that snapshot the working tree.
 */

const SCRIPT = join(ROOT_DIR, "scripts/guardrails.mjs");

/** A throw-away tree the script sees as a repository, with the checker copied into it. */
const scaffold = () => {
  const dir = mkdtempSync(join(tmpdir(), "chief-guardrails-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(SCRIPT, join(dir, "scripts/guardrails.mjs"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe" }));
  return dir;
};

/** Write `rel` under `dir`, creating its directories. */
const put = (dir: string, rel: string, body: string) => {
  mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(dir, rel), body);
};

const run = (dir: string) => {
  const r = spawnSync(process.execPath, [join(dir, "scripts/guardrails.mjs")], { cwd: dir, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

test("E14.2-1 the guardrails run on Node alone, in any editor, and name the fix for each violation", () => {
  test.setTimeout(300_000);
  // ── the artifact itself is editor-independent ────────────────────────────────────────────────
  const source = readFileSync(SCRIPT, "utf8");
  expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
  // No import of anything but Node built-ins: it must run before `npm install`, in any editor, in CI.
  for (const m of source.matchAll(/^import .* from "([^"]+)";$/gm)) expect(m[1], "only node: imports").toMatch(/^node:/);
  const pkg = JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8"));
  expect(pkg.scripts.guardrails).toBe("node scripts/guardrails.mjs");
  expect(pkg.scripts.check, "check runs all three").toContain("npm run guardrails");
  const ci = readFileSync(join(ROOT_DIR, ".github/workflows/ci.yml"), "utf8");
  expect(ci).toContain("npm run check");
  // The instruction files for agents point at the rules, whatever tool reads them.
  const claude = readFileSync(join(ROOT_DIR, "CLAUDE.md"), "utf8");
  expect(claude).toContain("AGENTS.md");
  expect(claude).toContain("docs/guardrails.md");
  expect(readFileSync(join(ROOT_DIR, "AGENTS.md"), "utf8")).toContain("docs/guardrails.md");
  const doc = readFileSync(join(ROOT_DIR, "docs/guardrails.md"), "utf8");
  // Headings use inline code (`docs/`), so compare the text with the backticks removed.
  const plain = doc.replace(/`/g, "");
  for (const rule of ["Three parts, one boundary", "Timers are a design decision", "TODO names the task", "kebab-case", "Markdown lives in docs/", "suppression says why", "<schema>__<name>", "State is in ~/.chief"]) {
    expect(plain, rule).toContain(rule);
  }
  expect(doc, "no Cursor-only instruction").not.toMatch(/\bcursor-agent\b|\.cursor\/rules|pstack/i);

  // ── each rule fails on its mistake, in a clean tree ──────────────────────────────────────────
  const cases: { files: Record<string, string>; expect: string; rule: string }[] = [
    { rule: "naming", expect: "kebab-case", files: { "packages/web/src/BadName.ts": "export const a = 1;\n" } },
    { rule: "markdown", expect: "Markdown outside docs/", files: { "docs/ok.md": "# fine\n", "packages/web/NOTES.md": "# notes\n" } },
    { rule: "suppression", expect: "suppression with no reason", files: { "packages/web/src/a.ts": "// eslint-disable-next-line no-console\nexport const b = 1;\n" } },
    { rule: "state-home", expect: "~/.chief", files: { "packages/chief/src/paths.ts": 'export const h = () => "x";\n' } },
    { rule: "no-bun", expect: "Invokes Bun", files: { "e2e/global-setup.ts": 'export default () => require("node:child_process").execSync("bun run build:web");\n' } },
    { rule: "state-home (desktop)", expect: "~/.chief", files: { "packages/desktop/src/locations.ts": 'import { app } from "electron";\nexport const p = app.getPath("userData");\n' } },
  ];
  for (const c of cases) {
    const dir = scaffold();
    try {
      for (const [rel, body] of Object.entries(c.files)) put(dir, rel, body);
      const r = run(dir);
      expect(r.code, `${c.rule}: ${r.out}`).toBe(1);
      expect(r.out, c.rule).toContain(c.expect);
      expect(r.out, `${c.rule} must say what to do`).toMatch(/fix:/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // ── and passes on a tree that follows them ───────────────────────────────────────────────────
  const good = scaffold();
  try {
    put(good, "packages/web/src/my-file.ts", "export const c = 1;\n");
    put(good, "packages/web/src/a.ts", "// eslint-disable-next-line no-console -- the probe proves the rule reads a reason\nexport const d = 1;\n");
    put(good, "packages/chief/src/paths.ts", 'import { homedir } from "node:os";\nimport { join } from "node:path";\nexport const chiefHome = () => join(homedir(), ".chief", "state");\n');
    put(good, "packages/chief/src/store/migrations/010-new.sql", "CREATE TABLE run__things (id INTEGER PRIMARY KEY);\nCREATE INDEX run__things_id ON run__things (id);\n");
    put(good, "docs/design.md", "# design\n");
    put(good, "packages/desktop/src/locations.ts", 'import { homedir } from "node:os";\nimport { join } from "node:path";\nexport const chiefRoot = (env = process.env) => join(env.CHIEF_HOME || join(homedir(), ".chief", "state"));\n');
    const r = run(good);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("guardrails: ok");
  } finally { rmSync(good, { recursive: true, force: true }); }

  // ── this repository passes its own gate ─────────────────────────────────────────────────────
  const self = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT_DIR, encoding: "utf8", timeout: 120_000 });
  expect(self.status, `${self.stdout}${self.stderr}`).toBe(0);
  expect(self.stdout).toContain("guardrails: ok");
});

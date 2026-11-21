#!/usr/bin/env node
/**
 * The repository's own rules, checked with nothing but Node.
 *
 * `npm run guardrails` — no editor, no IDE plugin, no agent tooling. It works the same for a person
 * in Vim, a CI runner, or an agent with a shell. The rules that need a parser (the web/engine
 * boundary, raw timers, TODO ownership) live in ESLint (`eslint.config.js`) because a syntax-aware
 * check gives a precise line and a fix; this file covers the rules ESLint cannot see, so there is no
 * second implementation of anything and nothing to drift.
 *
 * Each rule prints what is wrong, where, and what to do instead. Exit code 1 when any rule fails, so
 * it can be a pre-commit hook or a CI step. The principles behind them are in docs/guardrails.md.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const problems = [];
const fail = (rule, file, message, fix) => problems.push({ rule, file, message, fix });

/** Files the rules apply to: source, never dependencies or build output. */
const SOURCE = /\.(ts|tsx|mjs|js)$/;
/** This file necessarily contains the patterns it looks for, as data. */
const EXEMPT = new Set(["scripts/guardrails.mjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "test-results", "playwright-report", ".git", ".chief", ".tmp"]);

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const rel = (p) => relative(ROOT, p);
/** The code with comments removed: a rule about what code does must not read what prose says. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (p) => readFileSync(p, "utf8");
const all = walk(ROOT);

// ── 1. Names ─────────────────────────────────────────────────────────────────────────────────────
// Lower-case kebab-case everywhere, because a name is context: an agent that sees `tick.hot.ts` or
// `electron-renderer/` knows something it was never told (AGENTS.md, "File and directory names").
for (const p of all) {
  if (!SOURCE.test(p)) continue;
  const name = p.split("/").pop();
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) {
    fail("naming", rel(p), `"${name}" is not lower-case kebab-case.`, "Rename it (my-file.ts), or the name stops telling a reader — or an agent — what it is.");
  }
}

// ── 2. Markdown lives in docs/ ──────────────────────────────────────────────────────────────────
// An agent that turns a correction into a new .md file is documenting its own reasoning, and the next
// agent treats that file as a source of truth. Specifications belong in docs/, not beside the code.
const ROOT_MD = new Set(["README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "CHANGELOG.md"]);
for (const p of all) {
  if (!p.endsWith(".md")) continue;
  const r = rel(p);
  if (r.startsWith("docs/") || ROOT_MD.has(r)) continue;
  fail("markdown", r, "Markdown outside docs/ (and the root files that must be there).", "Put the content in the code, in a lint rule, or in docs/ — a new .md next to the source becomes an unfalsifiable rule.");
}

// ── 3. A suppression must say why ───────────────────────────────────────────────────────────────
/** Is `index` inside a string literal on that line? A probe source quoted in a test is not a suppression. */
const insideString = (line, index) => {
  let inSingle = false, inDouble = false, inTemplate = false;
  for (let i = 0; i < index; i++) {
    const c = line[i];
    if (c === "\\") { i++; continue; }
    if (c === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
    else if (c === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
    else if (c === "`" && !inSingle && !inDouble) inTemplate = !inTemplate;
  }
  return inSingle || inDouble || inTemplate;
};
// `eslint-disable-next-line` with no reason is the same escape hatch as a comment: it hides the rule
// from the next reader and from everyone after them.
for (const p of all) {
  if (!SOURCE.test(p) || EXEMPT.has(rel(p))) continue;
  read(p).split("\n").forEach((line, i) => {
    // `eslint-disable…` needs the reason after `--`; TypeScript's directives take free text after them.
    const eslintMatch = line.match(/eslint-disable(?:-next-line|-line)?\b(.*)$/);
    const tsMatch = line.match(/@ts-(?:ignore|expect-error)\b(.*)$/);
    // Only a real comment counts: a test that quotes a suppression in a string is not suppressing anything.
    const eslint = eslintMatch && !insideString(line, eslintMatch.index) ? eslintMatch : null;
    const ts = tsMatch && !insideString(line, tsMatch.index) ? tsMatch : null;
    if (eslint) {
      if (!/--\s*\S/.test(eslint[1] ?? "")) {
        fail("suppression", rel(p), `line ${i + 1}: eslint suppression with no reason.`, "Add `-- why this line must break the rule`, or fix the line: an unexplained suppression is invisible debt.");
      }
      return;
    }
    if (ts && !/\S/.test((ts[1] ?? "").replace(/^["']|["']$/g, ""))) {
      fail("suppression", rel(p), `line ${i + 1}: ${line.includes("expect-error") ? "@ts-expect-error" : "@ts-ignore"} with no explanation.`, "Say what the error is and why it is expected: `// @ts-expect-error — sqlite returns unknown`.");
    }
  });
}

// ── 4. SQL names say which feature owns them ───────────────────────────────────────────────────
// One database, one schema per feature: `<schema>__<table>` (dev plan §4). Migration 003 established
// the convention and renamed what 001–002 had created (`ALTER TABLE workflows RENAME TO
// workflow__definitions`, and so on), so those two are history and an applied migration is never
// edited. The rule therefore starts at 003: a new migration, or an edit to 003 and later, must not
// introduce a bare name.
const MIGRATIONS = join(ROOT, "packages/chief/src/store/migrations");
try {
  for (const name of readdirSync(MIGRATIONS)) {
    if (!name.endsWith(".sql")) continue;
    // 001 and 002 predate the convention; 003 renamed every table they created.
    if (Number(name.slice(0, 3)) < 3) continue;
    const sql = read(MIGRATIONS + "/" + name);
    for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_]+)/gi)) {
      const [, kind, ident] = m;
      if (!ident.includes("__") && !ident.startsWith("sqlite_")) {
        fail("sql-naming", rel(join(MIGRATIONS, name)), `${kind} "${ident}" has no schema prefix.`, "Name it <schema>__<table> (workflow__definitions, run__messages, …) so the schema it belongs to is visible in the name.");
      }
    }
  }
} catch { /* no migrations yet */ }

// ── 5. State has one home, and it is not the checkout ──────────────────────────────────────────
// The state is in ~/.chief (decision 14). If a default ever points back into a checkout, a workflow's
// folder — and anything an MCP client puts in it — can be committed by accident.
const paths = (() => { try { return read(join(ROOT, "packages/chief/src/paths.ts")); } catch { return ""; } })();
// The desktop app writes its log and Electron profile beside the state, so it must derive the same
// root: a fixed ~/Library/Application Support path would split the app's data from the CLI's.
const desktopLocations = (() => { try { return read(join(ROOT, "packages/desktop/src/locations.ts")); } catch { return ""; } })();
if (desktopLocations) {
  if (!/"\.chief"/.test(desktopLocations)) {
    fail("state-home", "packages/desktop/src/locations.ts", "The desktop app does not keep its files under ~/.chief.", "Derive the root from CHIEF_HOME or ~/.chief/state, as the server does (dev plan §3, decision 14).");
  }
  if (/Application Support/.test(stripComments(desktopLocations))) {
    fail("state-home", "packages/desktop/src/locations.ts", "The desktop app writes to ~/Library/Application Support.", "Keep the log and Electron profile in ~/.chief beside the database, so one folder holds everything (decision 14).");
  }
}
if (paths) {
  if (!/homedir\(\)\s*,\s*"\.chief"/.test(paths)) {
    fail("state-home", "packages/chief/src/paths.ts", "The default home is not under the user's ~/.chief.", "Keep `join(homedir(), \".chief\", \"state\")` as the default and let CHIEF_HOME override it (dev plan §3, decision 14).");
  }
  if (/sourceRoot|CHIEF_BUILT_FROM/.test(paths)) {
    fail("state-home", "packages/chief/src/paths.ts", "A checkout-based home is back.", "State must not depend on which checkout it runs from: that was removed in task 13.1.");
  }
}

// ── 6. No script depends on a tool the project does not ship ───────────────────────────────────
// The engine ran on Bun until 2026-11-20; a leftover `bun run …` in a setup file hung the suite once
// already, and the same mistake would break CI for anyone who has no Bun installed.
for (const file of ["package.json", "e2e/global-setup.ts", "e2e/helpers.ts", "packages/chief/scripts/build.ts", "playwright.config.ts"]) {
  let text;
  try { text = read(join(ROOT, file)); } catch { continue; }
  if (/(exec|execSync|spawn|spawnSync)\(\s*["'`]bunx?\b/.test(text) || /"\s*bunx?\s+"?,/.test(text)) {
    fail("no-bun", file, "Invokes Bun, which the project does not depend on.", "Use `npm run …` or `process.execPath`: the engine is on Node (task 11.x) and CI has no Bun.");
  }
}

// ── 7. A tooltip is scanned, not read ──────────────────────────────────────────────────────────
// The four building blocks were once one 1,249-character paragraph in a 320 px bubble, and a person
// said what every reader would say: "too clunky and poorly arranged, impossible to read". A "?" is a
// reminder at the point of use; the depth belongs in docs/. Six short lines is the ceiling, and a
// line break is what makes a list of four things read as four things.
const HELP = "packages/web/src/help.ts";
{
  let text;
  try { text = read(join(ROOT, HELP)); } catch { text = ""; }
  // One entry per top-level `"id": {` at two spaces; an entry may be all on that line, so the rest of it is
  // part of the body. A regex over the whole file cannot do this: a one-line entry has no `\n  },` and the
  // match then swallows the entries after it (which is how a first version checked three entries of fifty).
  const entries = [];
  for (const line of text.split("\n")) {
    const open = /^  "?([\w-]+)"?: \{/.exec(line);
    if (open) { entries.push({ id: open[1], body: [line.slice(open[0].length)] }); continue; }
    if (/^\};?\s*$/.test(line)) { if (entries.length) entries[entries.length - 1].closed = true; continue; }
    const last = entries[entries.length - 1];
    if (last && !last.closed) last.body.push(line);
  }
  const quoted = (v) => [...v.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"')).join("\n");
  for (const { id, body } of entries) {
    const joinedBody = body.join("\n");
    // Only what the bubble shows as prose: `text`, not `example` (a code block has its own shape).
    const field = /(?:^|\{|\n)\s*text: (\[[\s\S]*?\]\.join\("\\n"\)|"(?:[^"\\]|\\.)*")/.exec(joinedBody);
    if (!field) continue;
    const joined = quoted(field[1].replace(/\.join\("\\n"\)$/, ""));
    const lines = joined.split("\n").filter((l) => l.trim());
    const chars = joined.replace(/\s+/g, " ").length;
    if (lines.length > 6) fail("help-short", HELP, `"${id}" has ${lines.length} lines of tooltip text.`, "One line per thing, at most six: a tooltip is scanned at the point of use. Put the rest in docs/workflow-guide.md.");
    if (chars > 420) fail("help-short", HELP, `"${id}" is ${chars} characters in a 320 px bubble.`, "Cut it to a few short lines. A tooltip that needs a paragraph is documentation: docs/workflow-guide.md.");
    if (lines.length > 1 && !/\.join\("\\n"\)/.test(field[1])) {
      fail("help-short", HELP, `"${id}" is written across lines but they are not joined with "\\n".`, 'Write it as [...].join("\\n"): the bubble renders the breaks (whitespace-pre-line), and without them the "lines" collapse into one paragraph.');
    }
    // Only for an entry written as a list (an array joined with "\n"): there, a semicolon is two ideas sharing
    // one line, which is the thing that made the first version unreadable. A plain one-line string is read as
    // one line, and half of this file is written that way, so the rule does not ask for a rewrite of those.
    if (field[1].startsWith("[")) {
      for (const line of lines) {
        if (/;\s/.test(line)) fail("help-short", HELP, `"${id}": "${line.slice(0, 60)}…" chains two sentences with a semicolon.`, "One sentence per line, on its own line: a semicolon is two ideas sharing one, and the reader has to unpick them.");
      }
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────────────────────────────
const RULES = {
  naming: "Names are lower-case kebab-case",
  markdown: "Markdown lives in docs/",
  suppression: "Every suppression says why",
  "sql-naming": "Every table and index is <schema>__<name>",
  "state-home": "State is in ~/.chief, never in a checkout",
  "no-bun": "No dependency on a runtime the project does not ship",
  "help-short": "A tooltip is scanned, not read",
};

if (!problems.length) {
  console.log(`guardrails: ok — ${Object.keys(RULES).length} rules, ${all.length} files checked`);
  console.log("  the boundary, timer and TODO rules are checked by ESLint (npm run lint); npm run check runs both");
  process.exit(0);
}

const byRule = new Map();
for (const p of problems) {
  if (!byRule.has(p.rule)) byRule.set(p.rule, []);
  byRule.get(p.rule).push(p);
}
for (const [rule, list] of byRule) {
  console.error(`\n${RULES[rule] ?? rule} — ${list.length} problem${list.length === 1 ? "" : "s"}`);
  for (const p of list) console.error(`  ${p.file}: ${p.message}\n    fix: ${p.fix}`);
}
console.error(`\nguardrails: ${problems.length} problem${problems.length === 1 ? "" : "s"}. The principles are in docs/guardrails.md.`);
process.exit(1);

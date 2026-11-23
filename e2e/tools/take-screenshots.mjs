// Takes the screenshots shown in the README, from a throw-away chief with made-up data:
// its own home folder, the shipped example workflow, and the fake agent CLIs (no tokens spent,
// nothing real is read or written). Run from the repo root, after `npm run build:web`:
//
//   node e2e/tools/take-screenshots.mjs [work-folder]
//
// The pictures are written to docs/screenshots/. The set follows the pages a person meets first
// (dev plan task 15.19): the run list, the designer, a gate waiting, the schedules, and the settings
// where the agent CLIs and the appearance are chosen.
import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Each agent CLI's binary, so a masked path still reads as one (`~/.local/bin/claude`). */
const CLI_BIN = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent", antigravity: "agy", opencode: "opencode", hermes: "hermes" };
const work = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "chief-shots-")));
const out = join(root, "docs/screenshots");
const flow = join(work, "flows", "daily-slack");
for (const d of [out, flow, join(work, "state")]) mkdirSync(d, { recursive: true });

const ITEMS = [
  { title: "Review the pull request for the export API", kind: "code-review", priority: "P1", url: "https://example.test/pr/12" },
  { title: "Reply to Dana about the release date", kind: "other", priority: "P1", url: "https://example.test/thread/881" },
  { title: "Write the ADR for the queue migration", kind: "doc", priority: "P2", url: "https://example.test/thread/902" },
  { title: "Update the ticket for the login bug", kind: "jira", priority: "P3", url: "https://example.test/browse/APP-431" },
];
const rules = join(work, "rules.json");
/**
 * chief bot's answer to the question the screenshot asks: the `chief-workflow` block is what the designer
 * applies to the canvas, so the picture shows a real exchange rather than a mock-up.
 */
const BUILT = {
  name: "weekly-review",
  nodes: [
    { id: "collect", type: "agent", prompt: "Collect this week's shipped changes from the repository and the team's notes." },
    { id: "draft", type: "agent", prompt: "Write the review from:\n{{nodes.collect.output}}" },
    { id: "approve", type: "gate", kind: "ask", prompt: "Show me the draft and ask whether to publish it." },
  ],
  edges: [{ from: "collect", to: "draft" }, { from: "draft", to: "approve" }],
  inputs: {},
};
const block = (tag, value) => "```" + tag + "\n" + JSON.stringify(value, null, 2) + "\n```";
writeFileSync(rules, JSON.stringify([
  { match: "Summarise what happened in my Slack", turns: [{ text: "Four things need you today. The pull request and the reply to Dana are the urgent ones.\n\n```json\n" + JSON.stringify({ summary: "A quiet day: one review request, one question about the release, and two follow-ups.", items: ITEMS }) + "\n```", cost: 0.21, tokens: { in: 18400, out: 950 } }] },
  { match: "Action item:", turns: [{ output: { result: "Done. Nothing was posted without asking." }, cost: 0.08, tokens: { in: 6200, out: 410 } }] },
  {
    match: "Build a weekly review",
    turns: [{
      text: "Built it: three steps on the canvas — collect what shipped, draft the review from it, then a gate so you approve before anything is published.\n\n" + block("chief-workflow", BUILT),
      cost: 0.03,
      tokens: { in: 4200, out: 620 },
    }],
  },
]));

const env = {
  ...process.env,
  CHIEF_HOME: join(work, "state"),
  CHIEF_CLAUDE_BIN: join(root, "e2e/fixtures/fake-claude.ts"),
  // All five, so the Agent CLIs grid in the pictures shows what it looks like when they are found.
  CHIEF_CODEX_BIN: join(root, "e2e/fixtures/fake-codex.ts"),
  CHIEF_CURSOR_BIN: join(root, "e2e/fixtures/fake-cursor.ts"),
  CHIEF_ANTIGRAVITY_BIN: join(root, "e2e/fixtures/fake-antigravity.ts"),
  CHIEF_OPENCODE_BIN: join(root, "e2e/fixtures/fake-opencode.ts"),
  CODEX_HOME: join(work, "codex-home"),
  CURSOR_CONFIG_HOME: join(work, "cursor-home"),
  OPENCODE_CONFIG: join(work, "opencode.json"),
  FAKE_AGY_MCP: join(work, "agy-mcp.json"),
  FAKE_CLAUDE_STATE: join(work, "fake-state"),
  FAKE_CLAUDE_RULES: rules,
  CHIEF_MCP_POLL_MS: "40",
};
const cli = join(root, "packages/chief/src/cli.ts");
copyFileSync(join(root, "examples/daily-slack.yaml"), join(flow, "daily-slack.yaml"));
const imported = spawnSync(process.execPath, [cli, "workflow", "import", join(flow, "daily-slack.yaml")], { env, encoding: "utf8" });
if (imported.status !== 0) throw new Error("import failed:\n" + imported.stdout + imported.stderr);

const server = spawn(process.execPath, [cli, "serve", "--port", "0"], { env });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out\n" + log); await new Promise((r) => setTimeout(r, 100)); } };
const url = await until(() => log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
const api = async (method, path, body) => (await fetch(url + path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })).json();
const waitRun = (id, status) => until(async () => { const d = await api("GET", `/api/runs/${id}`); return d.run?.status === status ? d : null; });

try {
  // An earlier run that went all the way, and one that waits for an answer.
  const first = (await api("POST", "/api/runs", { workflow: "daily-slack" })).run.id;
  let d = await waitRun(first, "waiting_gate");
  await api("POST", `/api/gates/${d.gates.find((g) => g.status === "waiting").id}/answer`, { answer: { mode: "one-by-one", selected: [0, 1] } });
  await until(async () => ["waiting_gate", "completed", "failed"].includes((await api("GET", `/api/runs/${first}`)).run.status) && (await api("GET", `/api/runs/${first}`)).node_runs.length > 2);
  const second = (await api("POST", "/api/runs", { workflow: "daily-slack" })).run.id;
  await waitRun(second, "waiting_gate");
  // Two schedules, one of them switched off, so the page shows both states.
  await api("POST", "/api/schedules", { workflow: "daily-slack", cron: "30 8 * * 1-5", inputs: {} });
  const off = await api("POST", "/api/schedules", { workflow: "daily-slack", cron: "0 18 * * 5", inputs: {} });
  await api("PATCH", `/api/schedules/${off.id}`, { enabled: false });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
  /**
   * Take a machine out of the picture.
   *
   * These images are published — in the README and on the landing page — and a path on the machine that took them
   * names the person using it. The one that leaked was the **Claude Code path** on Settings: it is filled from what
   * `doctor` detected, and in this throw-away chief the fake CLIs live inside the checkout, so the field read
   * `/Users/<name>/Documents/projects/chief/e2e/fixtures/fake-claude.ts` (reported 2026-11-23).
   *
   * Two parts, and the second is the one that matters: every place a path is printed gets a plausible generic value,
   * and then `assertNothingPersonal` **fails the run** if the home folder or the checkout path is still anywhere in
   * the page. A field added later without masking cannot quietly end up in a published picture.
   */
  const tidy = () => page.evaluate((bins) => {
    const setValue = (sel, value) => { const el = document.querySelector(sel); if (el) el.value = value; };
    const setText = (sel, value) => { const el = document.querySelector(sel); if (el) el.textContent = value; };
    // The workflow's folder, and the server list's folder.
    setValue('[data-testid="wf-base-dir"]', "~/.chief/workspace/daily-slack");
    setText('[data-testid="palette-mcp-folder"]', "in ~/.chief/workspace/daily-slack");
    // Each agent CLI's path, as the settings card shows it.
    for (const [name, bin] of Object.entries(bins)) setValue(`[data-testid="setting-${name}-path"]`, `~/.local/bin/${bin}`);
    // The "Run a command" boxes on the MCP card begin with the CLI's binary, which is as personal as the path field:
    // in this throw-away chief it is the fixture inside the checkout. Only the leading binary is replaced; the rest of
    // the command is the CLI's own words and is the point of the picture.
    for (const [name, bin] of Object.entries(bins)) {
      const box = document.querySelector(`[data-testid="mcp-command-line-${name}"]`);
      if (box && box.value) box.value = box.value.replace(/^\S*\/(\S+)/, `~/.local/bin/${bin}`);
    }
    // The workspace field's hint prints the resolved default folder.
    const hint = document.querySelector('[data-testid="setting-workspace-dir"]')?.closest("label")?.querySelector("span.block");
    if (hint) hint.textContent = "Base directory for workflows created in the designer. Empty: ~/.chief/workspace";
  }, CLI_BIN);

  /** No home path, no checkout path, in any field or anywhere in the text. Throws rather than publishing it. */
  const assertNothingPersonal = () => page.evaluate(([home, checkout]) => {
    const bad = [];
    for (const el of document.querySelectorAll("input, textarea")) {
      const v = String(el.value ?? "");
      if (v.includes(home) || v.includes(checkout)) bad.push(`${el.dataset.testid ?? el.tagName} = ${v}`);
    }
    const text = document.body.innerText;
    if (text.includes(home)) bad.push("the page text contains the home folder");
    if (text.includes(checkout)) bad.push("the page text contains the checkout path");
    return bad;
  }, [homedir(), root]);

  const shot = async (name) => {
    await tidy();
    const bad = await assertNothingPersonal();
    if (bad.length) throw new Error(`${name} would publish a machine path:\n  ${bad.join("\n  ")}\nMask it in tidy() before taking the picture.`);
    await page.screenshot({ path: join(out, name) });
    console.log("wrote", join("docs/screenshots", name));
  };

  await page.goto(`${url}/#/designer/daily-slack`);
  await page.locator('[data-testid="palette"][data-ready="true"]').waitFor();
  await page.locator('.react-flow__node:has([data-testid="flow-node-plan"])').click();
  await page.locator('[data-testid="node-prompt"]').waitFor();
  await page.waitForTimeout(700);
  await shot("designer.png");

  await page.goto(`${url}/#/runs/${second}`);
  await page.locator('[data-testid="gate-notice"]').waitFor();
  await page.locator('[data-reason="node"]').scrollIntoViewIfNeeded();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  await shot("run-gate.png");

  await page.goto(`${url}/#/runs`);
  await page.locator(`[data-testid="run-row-${second}"]`).waitFor();
  await page.setViewportSize({ width: 1360, height: 520 });
  await page.waitForTimeout(300);
  await shot("runs.png");

  // The pages added after the first set of pictures.
  await page.setViewportSize({ width: 1360, height: 760 });
  await page.goto(`${url}/#/schedules`);
  await page.locator('[data-testid="schedule-row-1"]').waitFor();
  await page.waitForTimeout(400);
  await shot("schedules.png");

  await page.goto(`${url}/#/settings`);
  await page.locator('[data-testid="providers"]').waitFor();
  await page.locator('[data-testid="provider-claude-code"]').click();
  await page.waitForTimeout(900); // the CLIs are looked for
  await shot("settings.png");

  // chief bot building a workflow: the panel on the right, the steps it made on the canvas behind it.
  // A fake agent answers with the `chief-workflow` block the designer understands, so the picture shows a
  // real exchange — the question, the answer, the change it lists — and not a mock-up.
  await api("DELETE", "/api/assistant");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${url}/#/designer`);
  await page.locator('[data-testid="nav-assistant"]').waitFor();
  await page.locator('[data-testid="nav-assistant"]').click();
  await page.locator('[data-testid="assistant-question"]').fill("Build a weekly review: collect what shipped, draft it, and let me approve before it is published.");
  await page.locator('[data-testid="assistant-send"]').click();
  await page.locator('[data-testid="flow-node-collect"]').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1200);
  await shot("chief-bot.png");

  // One picture in the dark theme, since the theme is a feature and a screenshot is how it is seen.
  // The run open in its panel over the list is the densest page, so it shows the theme best.
  //
  // The theme is read before the first render (`main.tsx`), so the page must be *reloaded* after the
  // setting changes: `page.goto` to another hash is a same-document navigation, and the picture then
  // came out light with a caption saying dark (found 2026-11-20, E15.19-1 now checks the pixels).
  await api("PUT", "/api/settings", { theme: "dark" });
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.goto(`${url}/#/runs/${first}`);
  await page.reload();
  // The caption says the run is open in the panel over the list, so the picture must be that screen
  // (not the standalone `#/runs/<id>/full` page, which has no list behind it).
  await page.locator('[data-testid="run-panel-body"]').waitFor();
  await page.locator('[data-testid="run-status"]').waitFor();
  // The signal that the theme is painted, rather than a wait: the script cannot save a light picture
  // labelled dark.
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.waitForTimeout(800);
  await shot("run-dark.png");
  await api("PUT", "/api/settings", { theme: "light" });
  await browser.close();
} finally {
  server.kill("SIGTERM");
}

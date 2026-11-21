import { expect, FAKE_ANTIGRAVITY, fake, test } from "../helpers";
import type { Page } from "@playwright/test";

/**
 * Phase 15, tasks 15.1 and 15.9: the Schedules page, and the workflow canvases being chief's own.
 * Kept in its own file so the cases run on a page of their own; the scheduler itself is covered by
 * Phase 8 (E8.1-2, E8.1-3).
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

test("E15.1-1 the Schedules page lists, adds, disables, removes and pages schedules", async ({ chief, page }) => {
  chief.importWorkflow("name: daily\nnodes:\n  - { id: a, type: agent, prompt: 'A run' }\n");
  chief.importWorkflow("name: weekly\nnodes:\n  - { id: a, type: agent, prompt: 'B run' }\n");
  const srv = await chief.serve();
  try {
    await page.goto(`${srv.url}/#/schedules`);
    // The sidebar has it, and the empty page says what a schedule is for.
    await expect(tid(page, "nav-schedules")).toBeVisible();
    await expect(tid(page, "schedules-empty")).toContainText("No schedules yet");

    // Add two: the row shows the workflow, the expression, what it means, its next firing and its inputs.
    await tid(page, "schedule-workflow").selectOption("daily");
    await tid(page, "schedule-cron").fill("0 9 * * *");
    await tid(page, "schedule-inputs").fill('{ "day": "today" }');
    await tid(page, "schedule-add").click();
    await expect(tid(page, "schedule-row-1")).toContainText("daily");
    await expect(tid(page, "schedule-description-1")).toHaveText("every day at 09:00");
    await expect(tid(page, "schedule-cron-1")).toHaveText("0 9 * * *");
    await expect(tid(page, "schedule-inputs-1")).toHaveText('{"day":"today"}');
    await expect(tid(page, "schedule-state-1")).toHaveText("enabled");
    // "Next run" is a real time from the server's own parser: the next 09:00, today or tomorrow.
    await expect(tid(page, "schedule-next-1")).toHaveText(/^\d{4}-\d{2}-\d{2}T09:00$/);
    const next = (await tid(page, "schedule-next-1").textContent())!;
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now() - 60_000);

    await tid(page, "schedule-workflow").selectOption("weekly");
    await tid(page, "schedule-cron").fill("0 18 * * 1-5");
    await tid(page, "schedule-add").click();
    await expect(tid(page, "schedule-row-2")).toContainText("weekly");
    await expect(tid(page, "schedule-description-2")).toHaveText("every weekday at 18:00");
    // What was typed is cleared after it is sent.
    await expect(tid(page, "schedule-cron")).toHaveValue("");

    // It survives a refresh, because it is a schedule and not page state.
    await page.reload();
    await expect(tid(page, "schedule-row-1")).toContainText("daily");
    await expect(tid(page, "schedule-row-2")).toContainText("weekly");

    // Disable from the row: the server agrees, the row says so and has no next run.
    await tid(page, "schedule-toggle-2").click();
    await expect(tid(page, "schedule-state-2")).toHaveText("disabled");
    await expect(tid(page, "schedule-next-2")).toHaveText("—");
    expect((await srv.api("GET", "/api/schedules")).body.find((s: any) => s.id === 2).enabled).toBe(false);
    // And back on again.
    await tid(page, "schedule-toggle-2").click();
    await expect(tid(page, "schedule-state-2")).toHaveText("enabled");
    await expect(tid(page, "schedule-next-2")).toHaveText(/^\d{4}-\d{2}-\d{2}T18:00$/);

    // An expression that cannot work is refused at the field, and nothing is created.
    await tid(page, "schedule-cron").fill("61 * * * *");
    await tid(page, "schedule-add").click();
    await expect(tid(page, "schedule-error")).toContainText("invalid cron expression");
    expect((await srv.api("GET", "/api/schedules")).body.length).toBe(2);

    // Remove asks first, then removes.
    await tid(page, "schedule-remove-1").click();
    await expect(tid(page, "confirm-schedule-remove")).toContainText("0 9 * * *");
    await tid(page, "confirm-schedule-remove-keep").click();
    await expect(tid(page, "schedule-row-1")).toBeVisible();
    await tid(page, "schedule-remove-1").click();
    await tid(page, "confirm-schedule-remove-yes").click();
    await expect(tid(page, "schedule-row-1")).toHaveCount(0);
    expect((await srv.api("GET", "/api/schedules")).body.map((s: any) => s.id)).toEqual([2]);

    // Every list page is paged: 30 more schedules, 25 to a page, the total in the header.
    for (let i = 0; i < 30; i++) {
      const r = await srv.api("POST", "/api/schedules", { workflow: "daily", cron: "30 8 * * *" });
      expect(r.status).toBe(201);
    }
    await page.reload();
    await expect(tid(page, "schedule-pager-range")).toHaveText("1–25 of 31");
    await expect(tid(page, "schedule-pager-page")).toHaveText("Page 1 of 2");
    await tid(page, "schedule-pager-next").click();
    await expect(tid(page, "schedule-pager-page")).toHaveText("Page 2 of 2");
    await expect(tid(page, "schedule-pager-range")).toHaveText("26–31 of 31");
    // The page size is a choice about the page, kept across a refresh.
    await tid(page, "schedule-pager-size").selectOption("50");
    await expect(tid(page, "schedule-pager-range")).toHaveText("1–31 of 31");
    await page.reload();
    await expect(tid(page, "schedule-pager-range")).toHaveText("1–31 of 31");
  } finally {
    await srv.stop();
  }
});

/**
 * Phase 15, task 15.9: the designer's canvas is chief's own chrome. React Flow draws a small
 * "React Flow" attribution link in the corner of every canvas unless it is told not to; the designer
 * showed it while a run's diagram already hid it. The credit comes from the notices every build
 * generates (task 15.18), so this case checks the badge is gone from both canvases; that the generated
 * notices name the library is checked in E15.18-1, where the build is what is inspected.
 */
test("E15.9-1 the workflow canvases are chief's own", async ({ chief, page }) => {
  chief.importWorkflow("name: probe\nnodes:\n  - { id: a, type: agent, prompt: 'x' }\n");
  chief.run(["run", "probe"]);
  const srv = await chief.serve();
  try {
    // The designer: the canvas is there, and the badge is not.
    await page.goto(`${srv.url}/#/designer/probe`);
    await expect(tid(page, "canvas")).toBeVisible();
    await expect(page.locator(".react-flow")).toBeVisible();
    expect(await page.locator(".react-flow__attribution").count()).toBe(0);
    expect(await tid(page, "canvas").innerText()).not.toContain("React Flow");
    // A run's diagram, the same canvas read-only: also without it.
    await page.goto(`${srv.url}/#/runs/1`);
    await expect(tid(page, "run-diagram-canvas")).toBeVisible();
    expect(await page.locator(".react-flow__attribution").count()).toBe(0);
  } finally {
    await srv.stop();
  }
});

/**
 * Phase 15, task 15.11: a mixed workflow is readable from the canvas. A step that chose its own agent
 * CLI says so on the node; one that follows the workflow does not, so the badge means something.
 */
test("E15.11-2 a step that chose its own agent CLI says so on the canvas", async ({ chief, page }) => {
  chief.importWorkflow([
    "name: mixed",
    "agent: claude-code",
    "nodes:",
    "  - { id: personal, type: agent, agent: antigravity, prompt: 'Read my calendar' }",
    "  - { id: work, type: agent, prompt: 'Do the work' }",
    "edges:",
    "  - { from: personal, to: work }",
    "",
  ].join("\n"));
  const srv = await chief.serve();
  try {
    await page.goto(`${srv.url}/#/designer/mixed`);
    await expect(tid(page, "canvas")).toBeVisible();
    // The personal step carries its CLI; the work step, which follows the workflow, carries nothing.
    await expect(tid(page, "flow-agent-personal")).toHaveText("antigravity");
    expect(await tid(page, "flow-agent-work").count()).toBe(0);
    // The badge names the step's own choice, not the workflow's, and says what it means on hover.
    expect(await tid(page, "flow-agent-personal").getAttribute("title")).toContain("antigravity");
    // The step's panel offers the same choice, and it is the one the badge shows.
    await page.locator('[data-testid="flow-node-personal"]').click();
    await expect(tid(page, "node-agent")).toHaveValue("antigravity");
    // Taking it back to the workflow's default removes the badge.
    await tid(page, "node-agent").selectOption("");
    await expect(tid(page, "flow-agent-personal")).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await srv.stop();
  }
});

/**
 * Phase 15, task 15.12: every CLI's own text says that CLI's own thing. The node panel used to tell
 * every agent to run `claude mcp`, whichever CLI the step was on; it now names the step's CLI and where
 * that CLI keeps its servers. (The path fields' tooltips are checked in E9.11-1.)
 */
test("E15.12-1 a step with no servers is told where its own CLI keeps them", async ({ chief, page }) => {
  chief.importWorkflow([
    "name: hints",
    "nodes:",
    "  - { id: personal, type: agent, agent: antigravity, mcp: [], prompt: 'Read my calendar' }",
    "  - { id: work, type: agent, agent: claude-code, mcp: [], prompt: 'Do the work' }",
    "edges:",
    "  - { from: personal, to: work }",
    "",
  ].join("\n"));
  const srv = await chief.serve();
  try {
    await page.goto(`${srv.url}/#/designer/hints`);
    await expect(tid(page, "canvas")).toBeVisible();
    await page.locator('[data-testid="flow-node-personal"]').click();
    const personal = tid(page, "node-mcp-none");
    await expect(personal).toContainText("antigravity");
    await expect(personal).toContainText("~/.gemini/config/mcp_config.json");
    await expect(personal).not.toContainText("claude mcp");

    await page.locator('[data-testid="flow-node-work"]').click();
    const work = tid(page, "node-mcp-none");
    await expect(work).toContainText("claude-code");
    await expect(work).toContainText("claude mcp");
    await expect(work).not.toContainText("mcp_config.json");
  } finally {
    await srv.stop();
  }
});

/**
 * Phase 15, task 15.14: the agent CLIs are found, not typed, and each has a switch.
 *
 * Settings asks `doctor`, and detection writes what it found into the CLI's path setting, so a card
 * shows "CLI detected · 2.1.311" and the path field is already filled in. A CLI nobody found stays
 * switched off and its switch cannot be moved until it is installed (or its path typed).
 */
test("E15.14-1 the agent CLIs are found, and each has a switch", async ({ chief, page }) => {
  const detected = chief.env.CHIEF_CLAUDE_BIN; // the fake CLI the harness points the adapter at
  const srv = await chief.serve();
  const settings = () => srv.api("GET", "/api/settings").then((r) => r.body);
  try {
    await page.goto(`${srv.url}/#/settings`);
    await expect(tid(page, "providers")).toBeVisible();
    // Each CLI is a card: its name, whether it was found (with its version), and a switch.
    await expect(tid(page, "provider-claude-code")).toBeVisible();
    await expect.poll(() => tid(page, "provider-status-claude-code").innerText()).toContain("CLI detected");
    expect(await tid(page, "provider-status-claude-code").innerText()).toMatch(/2\.\d+\.\d+/);
    await expect(tid(page, "provider-status-codex")).toHaveText("CLI not detected");

    // The path is found and shown, and the card says so. It is NOT copied into the settings when it came
    // from `CHIEF_CLAUDE_BIN`: a value the process was given belongs to that process (task 15.19).
    await expect(tid(page, "setting-claude-code-path")).toHaveValue(detected);
    await expect(tid(page, "provider-path-hint-claude-code")).toContainText("Found on your machine");
    expect((await settings())["claude-code.path"]).toBeUndefined();

    // A CLI that was found is switched on; one that was not is off, and cannot be switched on.
    await expect(tid(page, "provider-switch-claude-code")).toHaveAttribute("aria-checked", "true");
    await expect(tid(page, "provider-switch-codex")).toHaveAttribute("aria-checked", "false");
    expect(await tid(page, "provider-switch-codex").isDisabled()).toBe(true);
    expect((await srv.api("GET", "/api/meta")).body.usable_adapters).toEqual(["claude-code"]);

    // A card with nothing found says what to do, and its field is the only one left blank.
    await tid(page, "provider-codex").click();
    expect(await tid(page, "setting-codex-path").inputValue()).toBe("");
    await expect(tid(page, "provider-path-hint-codex")).toContainText("could not find this CLI");

    // The default CLI cannot be switched off silently: chief would have no default at all.
    await tid(page, "provider-switch-claude-code").click();
    await expect(tid(page, "providers-error")).toContainText("is the default agent CLI");
    await expect(tid(page, "provider-switch-claude-code")).toHaveAttribute("aria-checked", "true");
  } finally {
    await srv.stop();
  }
});

/**
 * Phase 15, task 15.14: a switched-off CLI is offered nowhere. Two CLIs are present so the default can
 * move off the one being switched off; the engine refuses a workflow that still names it, with a
 * message that says why instead of letting the run start a CLI the person said not to use.
 */
test("E15.14-2 a switched-off CLI is offered nowhere, and can be switched back on", async ({ chief }) => {
  chief.importWorkflow("name: probe\nnodes:\n  - { id: a, type: agent, agent: antigravity, prompt: 'x' }\n");
  const srv = await chief.serve({ env: { CHIEF_ANTIGRAVITY_BIN: FAKE_ANTIGRAVITY } });
  try {
    const meta = () => srv.api("GET", "/api/meta").then((r) => r.body);
    // Both are found, so both can run; every CLI chief knows is offered in the pickers.
    const doctor = await srv.api("GET", "/api/doctor");
    expect(doctor.body.providers.filter((p: any) => p.found).map((p: any) => p.name)).toEqual(["claude-code", "antigravity"]);
    expect((await meta()).usable_adapters).toEqual(["claude-code", "antigravity"]);

    // A person switches Antigravity off (the default moves first, or chief would have none).
    await srv.api("PUT", "/api/settings", { "default-adapter": "claude-code" });
    await srv.api("PUT", "/api/settings", { "antigravity.enabled": false, "antigravity.chosen": true });
    expect((await meta()).adapters).not.toContain("antigravity");
    expect((await meta()).usable_adapters).toEqual(["claude-code"]);
    expect((await srv.api("GET", "/api/doctor")).body.providers.find((p: any) => p.name === "antigravity")).toMatchObject({ found: true, enabled: false, chosen: true });

    // A run that still names it is refused, and says why.
    const started = chief.run(["run", "probe", "--json"]);
    expect(started.code).not.toBe(0);
    expect(`${started.stdout}${started.stderr}`).toContain("antigravity");
    expect(`${started.stdout}${started.stderr}`).toContain("is turned off in Settings (Providers)");

    // Detection does not undo the person's choice, even though the CLI is right there.
    await srv.api("GET", "/api/doctor");
    expect((await meta()).adapters).not.toContain("antigravity");

    // Switching it back on restores it.
    await srv.api("PUT", "/api/settings", { "antigravity.enabled": true });
    expect((await meta()).adapters).toContain("antigravity");
    expect((await meta()).usable_adapters).toEqual(["claude-code", "antigravity"]);
    // The CLI run needs the same fake the server was given: this case is about the switch, not about
    // whether the program is on PATH.
    expect(chief.run(["run", "probe", "--json"], { env: { CHIEF_ANTIGRAVITY_BIN: FAKE_ANTIGRAVITY } }).code).toBe(0);
  } finally {
    await srv.stop();
  }
});

/**
 * Phase 15, task 15.15: a person who installs chief and has no agent CLI finds out at once, not at the
 * first refused run. The app counts it on the bell, says it in a bar with a way to Settings, and the
 * Start run button is disabled with the reason — the rest of the app still works.
 */
test("E15.15-1 with no agent CLI the app says so, counts it, and cannot start a run", async ({ chief, page }) => {
  // Nothing is installed: every adapter is pointed at a program that does not exist.
  chief.importWorkflow("name: probe\nnodes:\n  - { id: a, type: agent, prompt: 'x' }\n");
  const srv = await chief.serve({ env: { CHIEF_CLAUDE_BIN: "/nonexistent/claude", CHIEF_ANTIGRAVITY_BIN: "/nonexistent/agy", CHIEF_CODEX_BIN: "/nonexistent/codex", CHIEF_CURSOR_BIN: "/nonexistent/cursor-agent", CHIEF_OPENCODE_BIN: "/nonexistent/opencode" } });
  try {
    // The server finds none of them (detection runs at startup), so it offers none.
    await expect.poll(async () => (await srv.api("GET", "/api/meta")).body.usable_adapters).toEqual([]);
    await page.goto(`${srv.url}/#/runs`);
    // A bar that says it, with the way to fix it.
    const bar = tid(page, "no-agent-cli");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("No agent CLI is set up");
    await expect(bar).toContainText("cannot run a workflow");
    await expect(bar).toContainText("You can still draw a workflow and read its runs");
    // Counted on the bell, with an entry that leads to Settings.
    await expect(tid(page, "gates-badge")).toHaveAttribute("data-count", "1");
    await expect(tid(page, "gates-badge")).toHaveAttribute("title", "No agent CLI configured");
    await tid(page, "gates-badge").click();
    await expect(tid(page, "notification-no-agent")).toContainText("No agent CLI");
    await expect(tid(page, "notification-no-agent")).toContainText("Runs cannot start");
    await tid(page, "notification-no-agent").click();
    await expect(page).toHaveURL(/#\/settings$/);
    // The run cannot start, and the button says why before it is pressed.
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "new-run-start")).toBeDisabled();
    await expect(tid(page, "new-run-no-agent")).toContainText("No agent CLI is installed");
    // Settings shows all five as not detected, each with its switch off and disabled.
    await page.goto(`${srv.url}/#/settings`);
    await expect(tid(page, "providers")).toBeVisible();
    for (const a of ["claude-code", "codex", "cursor", "antigravity", "opencode"]) {
      await expect(tid(page, `provider-status-${a}`)).toHaveText("CLI not detected");
      await expect(tid(page, `provider-switch-${a}`)).toHaveAttribute("aria-checked", "false");
      expect(await tid(page, `provider-switch-${a}`).isDisabled()).toBe(true);
    }
    // The rest of the app works: a workflow can be drawn and its runs read.
    await page.goto(`${srv.url}/#/designer/probe`);
    await expect(tid(page, "canvas")).toBeVisible();
    await expect(page.locator('[data-testid="flow-node-a"]')).toBeVisible();
    // A narrow window still says it, and does not scroll sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "no-agent-cli")).toBeVisible();
    await expect(tid(page, "gates-badge-bar")).toHaveAttribute("data-count", "1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await srv.stop();
  }
});

/**
 * Phase 15, task 15.15 (second state): CLIs are installed but every one is switched off. The warning
 * must still appear — a run cannot start either way — but it must not say "not set up", which would
 * make an installed CLI look missing. It names what was found and says the fix is the switch.
 */
test("E15.15-2 with every agent CLI switched off the warning names them and says it is not an install problem", async ({ chief, page }) => {
  // A workflow to start, so the Start run button's enabled state means the CLI and nothing else.
  chief.importWorkflow("name: probe\nnodes:\n  - { id: a, type: agent, prompt: 'x' }\n");
  const srv = await chief.serve({ env: { CHIEF_ANTIGRAVITY_BIN: FAKE_ANTIGRAVITY } });
  const meta = () => srv.api("GET", "/api/meta").then((r) => r.body);
  try {
    // Both are found, so both are on: the ordinary state, with no warning at all.
    await expect.poll(async () => (await meta()).found_providers).toEqual(["claude-code", "antigravity"]);
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "new-run")).toBeVisible();
    expect(await tid(page, "no-agent-cli").count()).toBe(0);

    // A person switches both off (the default moves first, or chief would have none).
    await srv.api("PUT", "/api/settings", { "default-adapter": "antigravity" });
    await srv.api("PUT", "/api/settings", { "claude-code.enabled": false, "claude-code.chosen": true, "antigravity.enabled": false, "antigravity.chosen": true });
    // Nothing is usable, but both were found: the two facts that word the warning.
    expect((await meta()).usable_adapters).toEqual([]);
    expect((await meta()).found_providers).toEqual(["claude-code", "antigravity"]);

    // The bar says "switched off", names them, and says it is not an installation problem.
    await page.reload();
    const bar = tid(page, "no-agent-cli");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("data-found", "2");
    await expect(bar).toContainText("Every agent CLI is switched off");
    await expect(bar).toContainText("Claude Code and Antigravity were found");
    await expect(bar).toContainText("not an installation problem");
    await expect(bar).not.toContainText("No agent CLI is set up");
    // Counted on the bell, whose entry says the same thing and leads to the switches.
    await expect(tid(page, "gates-badge")).toHaveAttribute("data-count", "1");
    await expect(tid(page, "gates-badge")).toHaveAttribute("title", "Every agent CLI is switched off");
    await tid(page, "gates-badge").click();
    await expect(tid(page, "notification-no-agent")).toContainText("Every agent CLI is off");
    await expect(tid(page, "notification-no-agent")).toContainText("Claude Code and Antigravity were found");
    await tid(page, "notification-no-agent").click();
    await expect(page).toHaveURL(/#\/settings$/);
    // The run button says why too, and it is not the "not installed" wording.
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "new-run-start")).toBeDisabled();
    await expect(tid(page, "new-run-no-agent")).toContainText("Every agent CLI is switched off");
    await expect(tid(page, "new-run-no-agent")).toContainText("Claude Code and Antigravity were found");

    // Switching one back on clears the warning without a reload of the app.
    await srv.api("PUT", "/api/settings", { "claude-code.enabled": true });
    await page.reload();
    await expect(tid(page, "no-agent-cli")).toHaveCount(0);
    await expect(tid(page, "new-run-start")).toBeEnabled();
  } finally {
    await srv.stop();
  }
});

/**
 * Task 15.33: the token numbers were on the run page and the run list with no word saying what they
 * are. They now read as tokens, the list has a Tokens column, and the run list pages 10 at a time.
 */
const SPENDY_WF = `name: spendy\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ tokens: { in: 1164981, out: 54439 } })}' }\n`;

test("E15.33-1 the run page says the totals are tokens, on one line at 375 px", async ({ chief, page }) => {
  expect(chief.importWorkflow(SPENDY_WF).code).toBe(0);
  const ran = chief.run(["run", "spendy"]);
  expect(ran.code, ran.stdout + ran.stderr).toBe(0);
  const srv = await chief.serve();
  try {
    await page.goto(`${srv.url}/#/runs`);
    await tid(page, "run-row-1").click();
    // A person can tell these are token counts, and the thousands are separated.
    await expect(tid(page, "run-totals")).toHaveText("1,164,981 tokens in · 54,439 tokens out");
    // One line, and the header does not push the run page sideways on a phone.
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(tid(page, "run-status")).toHaveText("completed");
    expect((await tid(page, "run-totals").boundingBox())!.height).toBeLessThan(30);
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('[data-testid="page-runs"]') as HTMLElement;
      return { doc: document.documentElement.scrollWidth, main: main.scrollWidth - main.clientWidth };
    });
    expect(overflow.doc).toBeLessThanOrEqual(375);
    expect(overflow.main).toBeLessThanOrEqual(0);
  } finally {
    await srv.stop();
  }
});

test("E15.33-2 the run list shows each run's input and output tokens, labelled", async ({ chief, page }) => {
  expect(chief.importWorkflow(SPENDY_WF).code).toBe(0);
  expect(chief.importWorkflow("name: gated\nnodes:\n  - { id: g, type: gate, kind: approve, value: ship it }\n").code).toBe(0);
  expect(chief.run(["run", "spendy"]).code).toBe(0);
  expect(chief.run(["run", "gated"]).code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.goto(`${srv.url}/#/runs`);
    // The column header is the label; each row carries the same compact form as the run page.
    await expect(tid(page, "runs-table").locator("thead")).toContainText("Tokens");
    await expect(tid(page, "run-tokens-1")).toHaveText("1,164,981 in · 54,439 out");
    await expect(tid(page, "run-tokens-2")).toHaveText("0 in · 0 out");
    // Adding the column did not bring the hidden cost figures back.
    await expect(tid(page, "runs-table")).not.toContainText("Cost");
    await expect(tid(page, "runs-table")).not.toContainText("$");
    // The table scrolls in its own box: the page does not scroll sideways at 375 px.
    await page.setViewportSize({ width: 375, height: 800 });
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('[data-testid="page-runs"]') as HTMLElement;
      return { doc: document.documentElement.scrollWidth, main: main.scrollWidth - main.clientWidth };
    });
    expect(overflow.doc).toBeLessThanOrEqual(375);
    expect(overflow.main).toBeLessThanOrEqual(0);
  } finally {
    await srv.stop();
  }
});

test("E15.33-3 the run list pages 10 runs at a time by default", async ({ chief, page }) => {
  chief.importWorkflow("name: many\nnodes:\n  - { id: g, type: gate, kind: approve, value: ok }\n");
  const srv = await chief.serve();
  try {
    for (let i = 0; i < 12; i++) expect((await srv.api("POST", "/api/runs", { workflow: "many" })).status).toBe(201);
    await page.goto(`${srv.url}/#/runs`);
    const rows = page.locator('[data-testid^="run-row-"]');
    await expect(tid(page, "runs-pager-range")).toHaveText("1–10 of 12");
    await expect(tid(page, "runs-pager-page")).toHaveText("Page 1 of 2");
    await expect(rows).toHaveCount(10);
    // 10 is the default and a choice; the other sizes are still offered.
    await expect(tid(page, "runs-pager-size")).toHaveValue("10");
    await expect(tid(page, "runs-pager-size").locator("option")).toHaveText(["10", "25", "50", "100"]);
    await tid(page, "runs-pager-next").click();
    await expect(tid(page, "runs-pager-range")).toHaveText("11–12 of 12");
    await expect(rows).toHaveCount(2);
    // Choosing a bigger page is still possible, and it starts again at page 1.
    await tid(page, "runs-pager-size").selectOption("25");
    await expect(tid(page, "runs-pager-range")).toHaveText("1–12 of 12");
    await expect(tid(page, "runs-pager-page")).toHaveText("Page 1 of 1");
  } finally {
    await srv.stop();
  }
});

import type { Page } from "@playwright/test";
import { expect, fake, test } from "../helpers";

const tid = (page: Page, id: string) => page.getByTestId(id);

/**
 * **Input data**: the input values a run of one workflow is given, prepared over as many days as the data takes and
 * used when a run is started (dev plan 15.122), and the side panel that edits them (15.125).
 *
 * The name has moved twice at the user's asking — "case", then "collection", and now *"the word Collections is
 * definitely confusing, just rename it to workflow input data set or something close"* — and the panel with it: a card
 * with a Create button broke the repository's own rule that **there are no Save buttons**.
 */

/** One required field, one with a default: enough to show a set that is not ready. */
const REVIEW = `
name: perf-review
inputs: { hours: 24 }
input-fields:
  - { path: engineer, label: Engineer, type: text, required: true }
  - { path: hours, label: Hours back, type: number }
nodes:
  - { id: collect, type: agent, mcp: [], prompt: 'Review {{inputs.engineer}} over {{inputs.hours}}h ${fake({ output: { ok: true } })}' }
`;

test("E15.122-1 a set is stored incomplete, started when it is ready, and a run keeps its own copy", async ({ chief }) => {
  expect(chief.importWorkflow(REVIEW).code).toBe(0);
  expect(chief.importWorkflow("name: other\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'hi' }\n").code).toBe(0);
  // Every field has a default and none is required: the shape that marked an empty set ready (2026-11-27).
  expect(chief.importWorkflow(`
name: yearend
inputs: { engineer: Lan, notes: "paste the notes" }
nodes:
  - { id: collect, type: agent, mcp: [], prompt: 'Review {{inputs.engineer}} — {{inputs.notes}} ${fake({ output: { ok: true } })}' }
`).code).toBe(0);
  const s = await chief.serve();
  try {
    // Stored **incomplete**, and that is not an error: a set is prepared over days.
    const made = await s.api("POST", "/api/input-sets", { workflow: "perf-review", name: "Ana · 2026 review", values: {} });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // `filled` counts what **this set** holds: empty, so 0 of 2 — the workflow's own default is not "prepared".
    expect(made.body).toMatchObject({ workflow: "perf-review", name: "Ana · 2026 review", ready: false, fields: 2, filled: 0 });
    expect(made.body.missingRequired).toEqual([{ path: "engineer", label: "Engineer" }]);
    const id = made.body.id;

    // It belongs to one workflow, and two of one workflow cannot share a name.
    const nowhere = await s.api("POST", "/api/input-sets", { workflow: "nope", name: "x" });
    expect(nowhere.status).toBe(404);
    expect(nowhere.body.error).toContain("nope");
    expect((await s.api("POST", "/api/input-sets", { workflow: "perf-review", name: "Ana · 2026 review" })).status).toBe(400);
    // No name at all is **not** an error: the server names it after the workflow and the day, uniquely (15.125).
    const unnamed = await s.api("POST", "/api/input-sets", { workflow: "perf-review", name: "  " });
    expect(unnamed.status).toBe(201);
    expect(unnamed.body.name).toContain("perf-review");
    await s.api("DELETE", `/api/input-sets/${unnamed.body.id}`);

    const list = await s.api("GET", "/api/input-sets");
    expect(list.body).toHaveLength(1);
    expect(chief.calls()).toHaveLength(0);

    // One field answered is not ready: `hours` still has only the workflow's default, and a default is not this set's value.
    const half = await s.api("PATCH", `/api/input-sets/${id}`, { values: { engineer: "Ana" } });
    expect(half.body).toMatchObject({ ready: false, filled: 1, fields: 2, missing: ["hours"], missingRequired: [] });
    const refused = await s.api("POST", "/api/runs", { workflow: "perf-review", input_set: id });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("Hours back");

    // Both fields answered: ready, and the start uses the set, not the workflow's 24.
    const filled = await s.api("PATCH", `/api/input-sets/${id}`, { values: { engineer: "Ana", hours: 24 } });
    expect(filled.body).toMatchObject({ ready: true, filled: 2, fields: 2 });

    // Starting from it: its values are the run's, and the run says which set it came from.
    const run = await s.api("POST", "/api/runs", { workflow: "perf-review", input_set: id });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.run.input_set_id).toBe(id);
    expect(run.body.run.input_set_name).toBe("Ana · 2026 review");
    expect(run.body.run.inputs).toEqual({ engineer: "Ana", hours: 24 });
    await chief.until(async () => (await s.api("GET", `/api/runs/${run.body.run.id}`)).body.run.status === "completed");
    expect(chief.calls()[0].prompt).toContain("Review Ana over 24h");

    // Changed and deleted afterwards, the run is untouched: the values were copied.
    await s.api("PATCH", `/api/input-sets/${id}`, { name: "Ana · 2027 review", values: {} });
    await s.api("DELETE", `/api/input-sets/${id}`);
    const after = (await s.api("GET", `/api/runs/${run.body.run.id}`)).body.run;
    expect(after.inputs).toEqual({ engineer: "Ana", hours: 24 });
    expect(after.input_set_name).toBe("Ana · 2026 review");
    expect((await s.api("GET", "/api/input-sets")).body).toEqual([]);

    // One of another workflow is refused rather than quietly started with the wrong values.
    const other = await s.api("POST", "/api/input-sets", { workflow: "other", name: "a set", values: {} });
    const wrong = await s.api("POST", "/api/runs", { workflow: "perf-review", input_set: other.body.id });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain("other");

    // Reported 2026-11-27: a set with nothing filled was `ready`, because every field had a default on the workflow
    // (another person's review text). The default does not count, and the start is refused.
    const empty = await s.api("POST", "/api/input-sets", { workflow: "yearend", name: "Kristi", values: {} });
    expect(empty.status).toBe(201);
    expect(empty.body).toMatchObject({ ready: false, filled: 0, fields: 2, missingRequired: [] });
    expect(empty.body.missing).toEqual(["engineer", "notes"]);
    const blocked = await s.api("POST", "/api/runs", { workflow: "yearend", input_set: empty.body.id });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toContain("engineer");
    const hers = await s.api("PATCH", `/api/input-sets/${empty.body.id}`, { values: { engineer: "Kristi", notes: "her notes" } });
    expect(hers.body.ready).toBe(true);
    const kristi = await s.api("POST", "/api/runs", { workflow: "yearend", input_set: empty.body.id });
    expect(kristi.status, JSON.stringify(kristi.body)).toBe(201);
    await chief.until(async () => (await s.api("GET", `/api/runs/${kristi.body.run.id}`)).body.run.status === "completed");
    const calls = chief.calls();
    const prompt = calls[calls.length - 1].prompt;
    expect(prompt).toContain("Kristi");
    expect(prompt).toContain("her notes");
    expect(prompt).not.toContain("Lan");
  } finally { await s.stop(); }
});

test("E15.122-2 the side panel saves as you type: no Save button, and the list and count follow", async ({ chief, page }) => {
  // Asked 2026-11-25: *"why do we need the `Save` button? i thought all changes are automatically saved"*, and before
  // that: *"i had to manually refresh the page to see the listing and counter updated"*.
  expect(chief.importWorkflow(REVIEW).code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "input-sets-empty")).toBeVisible();
    await expect(tid(page, "workflow-panel-perf-review")).toContainText("0 input data sets");

    // A **side panel**, like the designer's for a new workflow.
    await tid(page, "new-run-new").click();
    const panel = tid(page, "input-set-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel).toHaveAttribute("aria-modal", "true");
    const box = (await panel.boundingBox())!, win = page.viewportSize()!;
    await expect(panel).toHaveClass(/slide-in-right/);
    expect(Math.round(box.x + box.width), "it is against the right edge").toBeGreaterThanOrEqual(win.width - 2);
    expect(Math.round(box.height), "and as tall as the window").toBeGreaterThanOrEqual(win.height - 2);
    await expect(tid(page, "input-set-backdrop")).toBeVisible();

    // **A new form is not a set yet.** Opening it stores nothing (asked 2026-11-25 to *"disable the auto create data set
    // feature"*), typing stores nothing, and the one action is **Save data set** — not Start run.
    await expect(tid(page, "input-set-save")).toBeVisible();
    await expect(tid(page, "input-set-start")).toHaveCount(0);
    await expect(tid(page, "input-set-state")).toContainText("Not saved yet");
    await expect(tid(page, "input-set-row-1")).toHaveCount(0);
    expect((await srv.api("GET", "/api/input-sets")).body).toEqual([]);
    await expect(tid(page, "workflow-panel-perf-review")).toContainText("0 input data sets");
    // The fields are **empty**.
    await expect(tid(page, "new-run-inputs-engineer-input")).toHaveValue("");
    await expect(tid(page, "new-run-inputs-hours-input")).toHaveValue("");
    // **No placeholder holds a value** (asked 2026-11-25: *"DO NOT use my previous data set values as the placeholder's
    // content for the form"*): not the fields, not the JSON box. The only example left is the name field's format.
    const hints = await page.evaluate(() => [...document.querySelectorAll('input[placeholder], textarea[placeholder]')]
      .map((e) => `${e.getAttribute("data-testid")}=${e.getAttribute("placeholder")}`));
    expect(hints.filter((h) => !h.startsWith("input-set-name=")), JSON.stringify(hints)).toEqual(["new-run-inputs={ }"]);
    expect(JSON.parse(await tid(page, "new-run-inputs").inputValue())).toEqual({});

    // Typed into, still not stored: a name and a value are kept as a draft until the Save is pressed.
    await tid(page, "input-set-name").fill("Ana · 2026 review");
    await tid(page, "new-run-inputs-engineer-input").fill("Ana");
    await page.waitForTimeout(900);
    expect((await srv.api("GET", "/api/input-sets")).body, "nothing is written before Save").toEqual([]);

    // **Save data set** creates it, and the panel becomes that set: its action is Start run from then on.
    await tid(page, "input-set-save").click();
    await expect(tid(page, "input-set-save")).toHaveCount(0);
    await expect(tid(page, "input-set-start")).toBeVisible();
    await expect(tid(page, "input-set-row-1")).toBeVisible();
    await expect(tid(page, "workflow-panel-perf-review")).toContainText("1 input data set");
    await expect(tid(page, "input-set-filled-1")).toHaveText("1 of 2 fields");
    await expect(tid(page, "input-set-ready-1")).toContainText("needs");
    await expect(tid(page, "input-set-start")).toBeDisabled();
    expect((await srv.api("GET", "/api/input-sets/1")).body.values).toMatchObject({ engineer: "Ana" });
    // The panel stays open: that is where the person is working.
    await expect(panel).toBeVisible();

    // An **existing** set saves its edits by itself: there is no Save on it, which is the rule this app has everywhere.
    await tid(page, "new-run-inputs-hours-input").fill("48");
    await expect.poll(async () => (await srv.api("GET", "/api/input-sets/1")).body.values, { timeout: 5000 }).toMatchObject({ hours: 48 });
    await expect(tid(page, "input-set-ready-1")).toContainText("ready");
    await expect(tid(page, "input-set-start")).toBeEnabled();

    // Start run is the one action, and the run page says which set it was prepared as.
    await tid(page, "input-set-start").click();
    await expect(tid(page, "run-status")).toHaveText("completed", { timeout: 30_000 });
    await expect(tid(page, "run-input-set")).toContainText("prepared as “Ana · 2026 review”");
    expect(chief.calls()[0].prompt).toContain("Review Ana over 48h");

    // Escape closes the panel; what was typed is already stored, so reopening it shows the same thing.
    await page.goto(`${srv.url}/#/runs`);
    await tid(page, "runs-tab-input-sets").click();
    await tid(page, "input-set-row-1").click();
    await expect(tid(page, "input-set-panel")).toBeVisible();
    await expect(tid(page, "input-set-name")).toHaveValue("Ana · 2026 review");
    await page.keyboard.press("Escape");
    await expect(tid(page, "input-set-panel")).toHaveCount(0);
  } finally { await srv.stop(); }
});

test("E15.122-3 a set keeps its own copy for a run, and removing it leaves that run alone", async ({ chief, page }) => {
  expect(chief.importWorkflow(REVIEW).code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    expect((await srv.api("POST", "/api/input-sets", { workflow: "perf-review", name: "Ana", values: { engineer: "Ana", hours: 24 } })).status).toBe(201);

    // A run started from it **through the API**, so this case is about the copy and not about the panel's own start.
    const started = await srv.api("POST", "/api/runs", { workflow: "perf-review", input_set: 1 });
    expect(started.status).toBe(201);
    await chief.until(async () => (await srv.api("GET", "/api/runs/1")).body.run.status === "completed");

    // The row opens the panel, and a value changed there is the set's — the run keeps what it started with.
    await page.goto(`${srv.url}/#/runs`);
    await tid(page, "input-set-row-1").click();
    await expect(tid(page, "input-set-name")).toHaveValue("Ana");
    await tid(page, "new-run-inputs-engineer-input").fill("Bo");
    await expect.poll(async () => (await srv.api("GET", "/api/input-sets/1")).body.values).toMatchObject({ engineer: "Bo" });
    expect((await srv.api("GET", "/api/runs/1")).body.run.inputs, "the run kept what it started with").toMatchObject({ engineer: "Ana" });

    // The bin removes it, and the workflow's count follows. The panel is a modal — the designer's is too — so the list
    // behind it is dimmed and not clickable until it is closed.
    await page.keyboard.press("Escape");
    await expect(tid(page, "input-set-panel")).toHaveCount(0);
    await tid(page, "input-set-remove-1").click();
    await expect(tid(page, "input-sets-empty")).toBeVisible();
    await expect(tid(page, "workflow-panel-perf-review")).toContainText("0 input data sets");
    expect((await srv.api("GET", "/api/input-sets")).body).toEqual([]);

    // 375 px: the column is its strip, and nothing scrolls sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    await expect(tid(page, "workflows-panel")).toBeHidden();
    await expect(tid(page, "workflows-panel-collapsed")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "the page does not scroll sideways at 375 px").toBeLessThanOrEqual(0);
  } finally { await srv.stop(); }
});

test("E15.124-1 the Runs page opens on its input data, with the workflow column beside it", async ({ chief, page }) => {
  // Asked 2026-11-24: a column of workflows to see/manage/create from, and the input data as the page's **default**
  // view, with past runs behind the second tab.
  expect(chief.importWorkflow(REVIEW).code).toBe(0);
  expect(chief.importWorkflow("name: other\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'hi' }\n").code).toBe(0);
  const LONG = "em-daily-operations-and-the-weekly-brief";
  expect(chief.importWorkflow(`name: ${LONG}\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'hi' }\n`).code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${srv.url}/#/runs`);

    // Two tabs, the input data first and chosen; neither the word "case" nor "collection" is shown.
    await expect(tid(page, "runs-tab-input-sets")).toHaveAttribute("aria-selected", "true");
    await expect(tid(page, "runs-tab-runs")).toHaveAttribute("aria-selected", "false");
    await expect(tid(page, "runs-tab-input-sets")).toHaveText("Input data");
    await expect(page.locator("body")).not.toContainText(/\bcase\b/i);
    await expect(page.locator("body")).not.toContainText(/\bcollections?\b/i);

    // The workflow column: every workflow, its set count, and the ways to manage one.
    const panel = tid(page, "workflows-panel");
    await expect(panel).toBeVisible();
    await expect(tid(page, "workflow-panel-all")).toBeVisible();
    await expect(tid(page, "workflow-panel-perf-review")).toContainText("perf-review");
    await expect(tid(page, "workflow-panel-perf-review")).toContainText("0 input data sets");
    // A long name is shown in full: the count sits under it, and the name wraps instead of ending in an ellipsis
    // (reported 2026-11-27: *"Unable to view the full name of the workflow"*).
    const longName = await tid(page, `workflow-panel-${LONG}`).locator("[data-workflow-name]").evaluate((el) => {
      const s = getComputedStyle(el);
      return { text: el.textContent, clipped: el.scrollWidth - el.clientWidth, ellipsis: s.textOverflow };
    });
    expect(longName.text).toBe(LONG);
    expect(longName.ellipsis, "the name is not cut off").not.toBe("ellipsis");
    expect(longName.clipped, "the name fits the card").toBeLessThanOrEqual(1);
    await expect(tid(page, "workflow-panel-new")).toHaveAttribute("href", "#/designer");
    await expect(tid(page, "workflow-panel-manage")).toHaveCount(0);

    // Choosing one filters both lists and offers to open it in the designer.
    await tid(page, "workflow-panel-perf-review").click();
    await expect(tid(page, "workflow-panel-perf-review")).toHaveAttribute("data-selected", "true");
    await expect(tid(page, "workflow-panel-manage")).toHaveAttribute("href", "#/designer/perf-review");
    await tid(page, "runs-tab-runs").click();
    await expect(tid(page, "runs-pane-runs")).toContainText("Runs of perf-review");

    // It collapses, and the page keeps the whole width when it does.
    const wide = (await tid(page, "page-column").boundingBox())!;
    await tid(page, "workflows-panel-close").click();
    await expect(tid(page, "workflows-panel")).toHaveCount(0);
    await expect(tid(page, "workflows-panel-collapsed")).toBeVisible();
    const wider = (await tid(page, "page-column").boundingBox())!;
    expect(wider.width).toBeGreaterThan(wide.width);
    await tid(page, "workflows-panel-open").click();
    await expect(tid(page, "workflows-panel")).toBeVisible();
  } finally { await srv.stop(); }
});


test("E15.125-2 a new panel starts clean: no previous set's data, and nothing stale after a close", async ({ chief, page }) => {
  // Reported 2026-11-25: *"why when i create a new data set, i still see the previous data already filled the form for
  // new data set creation?"*. Three things were feeding it: a draft key shared by every workflow, a draft left behind
  // when the panel was closed within the save debounce, and the template itself being written to that draft — so a
  // reopened blank panel counted the template as an edit.
  expect(chief.importWorkflow(REVIEW).code).toBe(0);
  expect(chief.importWorkflow("name: other\ninputs: { ticket: T-1 }\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'x {{inputs.ticket}}' }\n").code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${srv.url}/#/runs`);
    // Scoped to one workflow, so the fields are known: the panel takes the workflow the column has chosen.
    await tid(page, "workflow-panel-perf-review").click();

    // 1. Each press of New opens a panel of its own, **empty and unsaved**: three presses store nothing, and no panel
    //    carries the last one's typing.
    for (let i = 1; i <= 3; i++) {
      await tid(page, "new-run-new").click();
      await expect(tid(page, "input-set-panel")).toBeVisible();
      // The fields come with the workflow, so the form is waited for rather than the panel alone — and it is the
      // **JSON** that says the values are empty, whatever fields this workflow happens to ask for.
      await expect(tid(page, "new-run-inputs-form")).toHaveAttribute("data-fields", /[1-9]/);
      expect(JSON.parse(await tid(page, "new-run-inputs").inputValue()), "a new set holds nothing").toEqual({});
      await expect(tid(page, "input-set-name")).toHaveValue("");
      await expect(tid(page, "input-set-state")).toContainText("Not saved yet");
      await page.keyboard.press("Escape");
      await expect(tid(page, "input-set-panel")).toHaveCount(0);
    }
    expect((await srv.api("GET", "/api/input-sets")).body, "opening a new form stores nothing").toEqual([]);

    // 2. Type into a new form, then close it: nothing is stored in the DB, and reopening keeps the draft until saved
    //    or cleared (15.129).
    await tid(page, "new-run-new").click();
    await tid(page, "new-run-inputs-engineer-input").fill("Half-typed");
    await page.keyboard.press("Escape");
    await expect(tid(page, "input-set-panel")).toHaveCount(0);
    expect((await srv.api("GET", "/api/input-sets")).body).toEqual([]);
    await tid(page, "new-run-new").click();
    await expect(tid(page, "new-run-inputs-engineer-input")).toHaveValue("Half-typed");
    await tid(page, "input-set-clear").click();
    await expect(tid(page, "new-run-inputs-engineer-input")).toHaveValue("");
    await expect(tid(page, "input-set-name")).toHaveValue("");
    await page.keyboard.press("Escape");

    // 3. A panel opened for one workflow never carries another's data: it asks **its own** workflow's fields, starts
    //    empty, and is named for that workflow.
    await tid(page, "workflow-panel-perf-review").click();
    await tid(page, "new-run-new").click();
    await tid(page, "new-run-inputs-engineer-input").fill("only for perf-review");
    await page.waitForTimeout(900);
    await page.keyboard.press("Escape");
    await tid(page, "workflow-panel-other").click();
    // The column's choice is what the new panel is for, so it is waited for rather than assumed.
    await expect(tid(page, "workflow-panel-other")).toHaveAttribute("data-selected", "true");
    await tid(page, "new-run-new").click();
    await expect(tid(page, "input-set-workflow")).toHaveValue("other");
    await expect(tid(page, "new-run-inputs-field-ticket")).toBeVisible();
    await expect(tid(page, "new-run-inputs-field-engineer")).toHaveCount(0);
    await expect(tid(page, "input-set-name"), "an unsaved form has no name yet").toHaveValue("");
    expect(JSON.parse(await tid(page, "new-run-inputs").inputValue()), "empty, not the other workflow's values").toEqual({});
    await expect(tid(page, "new-run-inputs-ticket-input")).toHaveValue("");

    // 4. A panel that was left open arrives back after a refresh with the typing **it** had: the draft rule, and Clear
    //    wipes it cleanly so the next open starts empty.
    await tid(page, "new-run-inputs-ticket-input").fill("typing-then-refresh");
    await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);
    await page.reload();
    await tid(page, "workflow-panel-other").click();
    await tid(page, "new-run-new").click();
    await expect(tid(page, "new-run-inputs-ticket-input")).toHaveValue("typing-then-refresh");
    await tid(page, "input-set-clear").click();
    await page.keyboard.press("Escape");
    await tid(page, "new-run-new").click();
    await expect(tid(page, "new-run-inputs-ticket-input")).toHaveValue("");
  } finally { await srv.stop(); }
});

test("E15.126-1 right side-panels are horizontally resizable on every page and keep their width", async ({ chief, page }) => {
  expect(chief.importWorkflow(REVIEW).code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${srv.url}/#/runs`);

    const panelWidth = async (id: string) => Math.round((await tid(page, id).boundingBox())!.width);
    /** Wait for `slide-in-right` to settle at the right edge before measuring or dragging the handle. */
    const settled = async (id: string) => {
      const vw = page.viewportSize()!.width;
      await expect.poll(async () => {
        const b = await tid(page, id).boundingBox();
        return b ? Math.round(b.x + b.width) : 0;
      }).toBe(vw);
    };
    const drag = async (handleId: string, draftKey: string, dx: number) => {
      let writes = 0;
      const encoded = encodeURIComponent(draftKey);
      const count = (r: any) => { if (r.url().includes(`/api/drafts/${encoded}`) && r.method() !== "GET") writes++; };
      page.on("request", count);
      const b = (await tid(page, handleId).boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + 200);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + b.width / 2 + (dx * i) / 10, b.y + 200);
      await page.mouse.up();
      await page.waitForTimeout(150);
      page.off("request", count);
      return writes;
    };

    // 1. Input data set panel (create) on Runs: drag, clamp, arrow keys, double-click reset, persistence.
    await tid(page, "new-run-new").click();
    await expect(tid(page, "input-set-panel")).toBeVisible();
    await settled("input-set-panel");
    const setHandle = tid(page, "input-set-panel-resize");
    await expect(setHandle).toBeVisible();
    await expect(setHandle).toHaveAttribute("role", "separator");
    await expect(setHandle).toHaveAttribute("aria-orientation", "vertical");
    expect(await panelWidth("input-set-panel")).toBe(448);

    expect(await drag("input-set-panel-resize", "ui:input-set-panel-width", -200)).toBe(1);
    expect(await panelWidth("input-set-panel")).toBe(648);
    await expect(setHandle).toHaveAttribute("aria-valuenow", "648");

    // Clamps at max (85% of 1280 = 1088) and min (360).
    await drag("input-set-panel-resize", "ui:input-set-panel-width", -2000);
    expect(await panelWidth("input-set-panel")).toBe(1088);
    await drag("input-set-panel-resize", "ui:input-set-panel-width", 2000);
    expect(await panelWidth("input-set-panel")).toBe(360);

    // Arrow keys and double-click reset.
    await setHandle.focus();
    await page.keyboard.press("ArrowLeft");
    expect(await panelWidth("input-set-panel")).toBe(376);
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await panelWidth("input-set-panel")).toBe(440);
    await page.keyboard.press("ArrowRight");
    expect(await panelWidth("input-set-panel")).toBe(424);
    await setHandle.dblclick();
    expect(await panelWidth("input-set-panel")).toBe(448);

    // Persists across reload and applies to editing an existing set too.
    await drag("input-set-panel-resize", "ui:input-set-panel-width", -152);
    expect(await panelWidth("input-set-panel")).toBe(600);
    await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);

    const created = await srv.api("POST", "/api/input-sets", { workflow: "perf-review", name: "Ana", values: { engineer: "Ana", hours: 10 } });
    expect(created.status).toBe(201);
    await page.reload();
    await tid(page, `input-set-row-${created.body.id}`).click();
    await expect(tid(page, "input-set-panel")).toBeVisible();
    expect(await panelWidth("input-set-panel")).toBe(600);

    // Narrow viewport (375 px): fits with no horizontal scroll.
    await page.setViewportSize({ width: 375, height: 800 });
    expect(await panelWidth("input-set-panel")).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.keyboard.press("Escape");

    // 2. New workflow panel on Designer.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${srv.url}/#/designer`);
    await tid(page, "btn-new").click();
    await expect(tid(page, "new-wf-panel")).toBeVisible();
    await settled("new-wf-panel");
    const wfHandle = tid(page, "new-wf-panel-resize");
    await expect(wfHandle).toBeVisible();
    await expect(wfHandle).toHaveAttribute("role", "separator");
    expect(await panelWidth("new-wf-panel")).toBe(448);
    expect(await drag("new-wf-panel-resize", "ui:new-wf-panel-width", -180)).toBe(1);
    expect(await panelWidth("new-wf-panel")).toBe(628);
    await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);
    await page.reload();
    await tid(page, "btn-new").click();
    expect(await panelWidth("new-wf-panel")).toBe(628);
    await wfHandle.dblclick();
    expect(await panelWidth("new-wf-panel")).toBe(448);

    // 3. Run panel on Runs: same handle, arrow keys, and double-click reset.
    const started = await srv.api("POST", "/api/runs", { workflow: "perf-review", input_set: created.body.id });
    expect(started.status).toBe(201);
    await page.goto(`${srv.url}/#/runs/${started.body.run.id}`);
    await expect(tid(page, "run-panel")).toBeVisible();
    const runHandle = tid(page, "run-panel-resize");
    await expect(runHandle).toBeVisible();
    await expect(runHandle).toHaveAttribute("role", "separator");
    const runW0 = await panelWidth("run-panel");
    await runHandle.focus();
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await panelWidth("run-panel")).toBe(runW0 + 64);
    await runHandle.dblclick();
    expect(await panelWidth("run-panel")).toBe(runW0);
  } finally { await srv.stop(); }
});

test("E15.127-1 first launch seeds the starter workflow and sample input data set once", async ({ chief, page }) => {
  // 1. Fresh home with seeding enabled: seeds `trip-planner` and its ready sample input data set.
  let srv = await chief.serve({ env: { CHIEF_NO_SEED: "" } });
  try {
    const wfs = (await srv.api("GET", "/api/workflows")).body;
    expect(wfs.map((w: any) => w.name)).toEqual(["trip-planner"]);

    const wf = (await srv.api("GET", "/api/workflows/trip-planner")).body;
    expect(wf.definition.nodes.map((n: any) => `${n.id}:${n.type}`)).toEqual(["brainstorm:agent", "choose:gate", "itinerary:agent"]);
    expect(wf.definition.nodes[1].kind).toBe("ask");
    expect(wf.definition.nodes[0].mcp).toEqual([]);
    expect(wf.definition.nodes[2].mcp).toEqual([]);
    expect(wf.definition["input-fields"].map((f: any) => f.path)).toEqual(["destination", "days", "vibe"]);

    const sets = (await srv.api("GET", "/api/input-sets")).body;
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({
      workflow: "trip-planner",
      name: "Kyoto · 3 days (sample)",
      ready: true,
      values: { destination: "Kyoto, Japan", days: 3, vibe: "food-and-culture" },
    });

    // Runs page shows the workflow card and the ready sample input data set with a Start button.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "workflow-panel-trip-planner")).toBeVisible();
    await expect(tid(page, `input-set-name-${sets[0].id}`)).toHaveText("Kyoto · 3 days (sample)");
    await expect(tid(page, `input-set-ready-${sets[0].id}`)).toContainText("ready");
    await expect(tid(page, `input-set-start-${sets[0].id}`)).toBeVisible();

    // Designer opens the seeded 3-node graph cleanly.
    await page.goto(`${srv.url}/#/designer/trip-planner`);
    await expect(tid(page, "flow-node-brainstorm")).toBeVisible();
    await expect(tid(page, "flow-node-choose")).toBeVisible();
    await expect(tid(page, "flow-node-itinerary")).toBeVisible();

    // 2. Deleting the sample workflow and restarting does NOT re-seed it.
    expect((await srv.api("DELETE", "/api/workflows/trip-planner")).status).toBe(200);
    expect((await srv.api("GET", "/api/workflows")).body).toEqual([]);
  } finally { await srv.stop(); }

  srv = await chief.serve({ env: { CHIEF_NO_SEED: "" } });
  try {
    expect((await srv.api("GET", "/api/workflows")).body).toEqual([]);
  } finally { await srv.stop(); }
});

test("E15.129-1 new input data set form keeps its draft across closes until saved or cleared", async ({ chief, page }) => {
  expect(chief.importWorkflow(REVIEW).code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${srv.url}/#/runs`);

    // Open New input data set: starts empty, Clear is disabled.
    await tid(page, "new-run-new").click();
    await expect(tid(page, "input-set-panel")).toBeVisible();
    await expect(tid(page, "input-set-clear")).toBeVisible();
    await expect(tid(page, "input-set-clear")).toBeDisabled();

    // Fill name and form values; Clear becomes enabled, nothing is stored in DB yet.
    await tid(page, "input-set-name").fill("Draft review");
    await tid(page, "new-run-inputs-engineer-input").fill("Ada");
    await tid(page, "new-run-inputs-hours-input").fill("12");
    await expect(tid(page, "input-set-clear")).toBeEnabled();
    await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);

    // 1. Close via Escape, ×, and backdrop: every reopen restores name + form + JSON, and DB stays empty.
    await page.keyboard.press("Escape");
    await expect(tid(page, "input-set-panel")).toHaveCount(0);
    expect((await srv.api("GET", "/api/input-sets")).body).toEqual([]);

    await tid(page, "new-run-new").click();
    await expect(tid(page, "input-set-name")).toHaveValue("Draft review");
    await expect(tid(page, "new-run-inputs-engineer-input")).toHaveValue("Ada");
    await expect(tid(page, "new-run-inputs-hours-input")).toHaveValue("12");
    expect(JSON.parse(await tid(page, "new-run-inputs").inputValue())).toEqual({ engineer: "Ada", hours: 12 });

    await tid(page, "input-set-close").click();
    await expect(tid(page, "input-set-panel")).toHaveCount(0);
    await tid(page, "new-run-new").click();
    await expect(tid(page, "input-set-name")).toHaveValue("Draft review");
    await expect(tid(page, "new-run-inputs-engineer-input")).toHaveValue("Ada");

    await tid(page, "input-set-backdrop").click({ position: { x: 20, y: 20 } });
    await expect(tid(page, "input-set-panel")).toHaveCount(0);
    await page.reload();
    await tid(page, "new-run-new").click();
    await expect(tid(page, "input-set-name")).toHaveValue("Draft review");
    await expect(tid(page, "new-run-inputs-engineer-input")).toHaveValue("Ada");
    await expect(tid(page, "new-run-inputs-hours-input")).toHaveValue("12");

    // 2. Clear wipes name, form fields, JSON, and draft; stays empty after close & reopen.
    await tid(page, "input-set-clear").click();
    await expect(tid(page, "input-set-name")).toHaveValue("");
    await expect(tid(page, "new-run-inputs-engineer-input")).toHaveValue("");
    await expect(tid(page, "new-run-inputs-hours-input")).toHaveValue("");
    expect(JSON.parse(await tid(page, "new-run-inputs").inputValue())).toEqual({});
    await expect(tid(page, "input-set-clear")).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);
    await page.keyboard.press("Escape");
    await tid(page, "new-run-new").click();
    await expect(tid(page, "input-set-name")).toHaveValue("");
    await expect(tid(page, "new-run-inputs-engineer-input")).toHaveValue("");

    // 3. Save data set creates the DB record and clears the new-form draft so the next New panel opens clean.
    await tid(page, "input-set-name").fill("Saved review");
    await tid(page, "new-run-inputs-engineer-input").fill("Grace");
    await tid(page, "input-set-save").click();
    await expect(tid(page, "input-set-start")).toBeVisible();
    await expect(tid(page, "input-set-clear")).toHaveCount(0);
    expect((await srv.api("GET", "/api/input-sets")).body).toHaveLength(1);

    await page.keyboard.press("Escape");
    await tid(page, "new-run-new").click();
    await expect(tid(page, "input-set-name")).toHaveValue("");
    await expect(tid(page, "new-run-inputs-engineer-input")).toHaveValue("");
    expect(JSON.parse(await tid(page, "new-run-inputs").inputValue())).toEqual({});
  } finally { await srv.stop(); }
});

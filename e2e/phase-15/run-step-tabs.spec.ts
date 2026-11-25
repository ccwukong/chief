import type { Page } from "@playwright/test";
import { expect, fake, showStep, test, gotoRuns } from "../helpers";

/**
 * Task 15.93: the steps of a run are tabs.
 *
 * They were one list, with every step's input and output preview stacked in a column. Three steps already made the card
 * 589 px before anything was expanded, and a ten-step workflow would be a page of scrolling to compare two outputs (asked
 * 2026-11-22: *"can we use tabs to show all the building blocks of this workflow?"*).
 *
 * The risk in that change is a step's *question* becoming hidden behind a tab, so this case is as much about that as about
 * the layout: the strip shows every step and its status, the step that is asking is the one selected, and a question in
 * another step is reachable from a line that says so.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);
// The steps only: "Not started" is a tab too (`node-tab-pending`), and it names no step, so it is not part of the strip
// these assertions read.
const tabs = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[data-testid^="node-tab-"][data-node-id]')].map((t) => ({
  node: t.getAttribute("data-node-id"), status: t.getAttribute("data-status"), active: t.getAttribute("data-state") === "active",
})));
const rowsInView = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[data-testid^="node-run-"]')].map((r) => r.getAttribute("data-node-id")));
const activeStep = async (page: Page) => (await tabs(page)).find((t) => t.active)?.node;
/** The attempt id of a step's row, which is only in the DOM while its tab is selected. */
const rowId = async (page: Page, node: string) => {
  await showStep(page, node);
  return (await page.locator(`[data-testid^="node-run-"][data-node-id="${node}"]`).getAttribute("data-testid"))!.replace("node-run-", "");
};

test("E15.93-1 a run's steps are tabs, the step asking is the one selected, and no question hides behind a tab", async ({ chief, page }) => {
  // `collect` runs, `ask` waits at a gate, `write` has not started: the three states the strip has to show at once.
  chief.importWorkflow(`name: three\nnodes:\n  - { id: collect, type: agent, prompt: 'collect the evidence ${fake({ output: { ok: 1 } })}' }\n  - { id: ask, type: gate, kind: approve, value: ship }\n  - { id: write, type: agent, prompt: 'write it up' }\nedges: [collect -> ask, ask -> write]\n`);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    const run = await srv.api("POST", "/api/runs", { workflow: "three", inputs: {} });
    const id = run.body.run.id;
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run?.status, { timeout: 30_000 }).toBe("waiting_gate");
    await page.goto(`${srv.url}/#/runs/${id}`);
    await expect(tid(page, "node-tabs")).toBeVisible();

    // The strip is the index: every step that has an attempt, in the workflow's order, with its status.
    const strip = await tabs(page);
    expect(strip.map((t) => t.node)).toEqual(["collect", "ask"]);
    expect(strip.map((t) => t.status)).toEqual(["completed", "waiting_gate"]);
    await expect(tid(page, "node-tab-pending")).toContainText("Not started");
    await expect(tid(page, "nodes-count")).toContainText("2 steps");

    // The step that is asking is in view without anything being clicked, and it says why.
    expect(await activeStep(page)).toBe("ask");
    await expect(tid(page, "node-asking-ask")).toBeVisible();
    expect(await rowsInView(page), "only the selected step's row is in the DOM").toEqual(["ask"]);

    // One step at a time: opening a step's details then selecting another swaps the panel, and the details go with their step.
    await tid(page, `node-run-${await rowId(page, "ask")}`).click();
    await expect(tid(page, "node-details")).toHaveAttribute("data-for", "ask");
    await showStep(page, "collect");
    expect(await rowsInView(page)).toEqual(["collect"]);
    await expect(tid(page, "node-details"), "the opened details went with its step").toHaveCount(0);

    // A question in a step you are not looking at is never hidden: the line says so and takes you there.
    await expect(tid(page, "waiting-elsewhere")).toContainText("Waiting for your answer in: ask");
    await tid(page, "waiting-go-ask").click();
    expect(await activeStep(page), "the link selects the step that is asking").toBe("ask");
    await expect(page.locator('[data-reason="node"]'), "and its form is in that step's panel").toBeVisible();

    // The notice above the steps reaches the form too, from whichever tab is in view.
    await showStep(page, "collect");
    await tid(page, "gate-notice-go").click();
    expect(await activeStep(page)).toBe("ask");
    await expect(page.locator('[data-reason="node"]')).toBeInViewport();

    // "Not started" is a tab of its own, and it names the step that has not run.
    await tid(page, "node-tab-pending").click();
    await expect(tid(page, "not-started")).toContainText("write");

    // Answered: the step's status changes in its own tab and the strip stops saying it is asking.
    await showStep(page, "ask");
    await tid(page, "gate-approve").click();
    await expect(tid(page, "run-status")).toHaveText("completed", { timeout: 30_000 });
    await expect(tid(page, "node-asking-ask")).toHaveCount(0);
    await expect(tid(page, "node-tab-ask")).toHaveAttribute("data-status", "completed");

    // The strip wraps rather than scrolling sideways, and the card never scrolls horizontally (AGENTS.md).
    const n = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="node-tabs"]')!;
      const card = document.querySelector('[data-testid="timeline"]')!;
      return { stripSideways: strip.scrollWidth > strip.clientWidth + 1, cardSideways: card.scrollWidth > card.clientWidth + 1 };
    });
    expect(n.stripSideways, "the step strip does not scroll sideways").toBe(false);
    expect(n.cardSideways, "and neither does the card").toBe(false);
  } finally {
    await srv.stop();
  }
});

test("E15.93-2 the step tabs fit the run's narrow panel, and work there as they do on the page", async ({ chief, page }) => {
  chief.importWorkflow(`name: two\nnodes:\n  - { id: one, type: agent, prompt: 'first ${fake({ output: { ok: 1 } })}' }\n  - { id: two, type: agent, prompt: 'second ${fake({ output: { ok: 2 } })}' }\nedges: [one -> two]\n`);
  const srv = await chief.serve();
  try {
    const run = await srv.api("POST", "/api/runs", { workflow: "two", inputs: {} });
    const id = run.body.run.id;
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run?.status, { timeout: 30_000 }).toBe("completed");
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoRuns(page, srv.url);
    await expect(tid(page, "sidenav")).toBeVisible();
    await page.locator(`[data-testid="run-row-${id}"]`).click();
    await expect(tid(page, "node-tabs")).toBeVisible();
    // The panel is ~850 px on this window: the strip has to fit inside it, with no scrollbar of its own.
    const inside = await page.evaluate(() => {
      const strip = document.querySelector('[data-testid="node-tabs"]')!;
      const panel = document.querySelector('[data-testid="run-panel"]')!;
      return {
        stripRight: Math.round(strip.getBoundingClientRect().right),
        panelRight: Math.round(panel.getBoundingClientRect().right),
        sideways: strip.scrollWidth > strip.clientWidth + 1,
      };
    });
    expect(inside.sideways, "the strip fits the panel").toBe(false);
    expect(inside.stripRight).toBeLessThanOrEqual(inside.panelRight + 1);
    // And selecting a step in the panel works as it does on the page.
    await showStep(page, "two");
    expect(await rowsInView(page)).toEqual(["two"]);
  } finally {
    await srv.stop();
  }
});

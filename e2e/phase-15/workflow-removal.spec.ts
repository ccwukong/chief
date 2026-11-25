import { expect, test } from "../helpers";
import type { Page } from "@playwright/test";

/**
 * Task 15.2: getting a workflow out of the way.
 *
 * Two answers, for two situations. **Delete** for one that has never run: there is no record to keep, and nothing is
 * lost. **Archive** for one that has: a run is the record of what happened and points at the workflow, so deleting is
 * refused — and refusing with no way out is what left finished workflows in every picker. Archiving hides it from every
 * list, stops its schedules firing and keeps everything; the designer's picker has an **Archived** group, which is the
 * way back.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

/** The panel is closed on a wide window until it is asked for, and the workflow's actions live in it. */
async function openWorkflowTab(page: Page) {
  if (!(await tid(page, "wf-settings").isVisible().catch(() => false))) await tid(page, "panel-toggle").click();
  await expect(tid(page, "wf-settings")).toBeVisible();
}

test("E15.2-1 a workflow with no runs is deleted, with a confirmation that names it", async ({ chief, page }) => {
  chief.importWorkflow("name: throwaway\nnodes:\n  - { id: a, type: gate, kind: approve, value: ok }\n");
  chief.importWorkflow("name: keeper\nnodes:\n  - { id: a, type: gate, kind: approve, value: ok }\n");
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1360, height: 950 });
    await page.goto(`${srv.url}/#/designer/throwaway`);
    await openWorkflowTab(page);

    // Nothing has run from it, so Delete is offered, and the note says why that is safe.
    await expect(tid(page, "wf-delete")).toBeEnabled();
    // No heading and no note: the label says what the button does and the bin is the removal it can actually perform.
    await expect(tid(page, "wf-delete-note")).toHaveCount(0);
    await expect(tid(page, "wf-danger")).not.toContainText("When this workflow is finished");
    await tid(page, "wf-delete").click();
    // The confirmation names the workflow: a record can go for good, and that is worth one question.
    await expect(tid(page, "delete-modal")).toContainText('Delete "throwaway"?');
    await tid(page, "delete-yes").click();

    // Gone from the server, and the page is not left standing on a workflow that no longer exists: deleting the open one
    // lands on the runs list (the designer has nothing to show), where it is not offered either.
    await expect.poll(async () => (await srv.api("GET", "/api/workflows")).body.map((w: any) => w.name)).toEqual(["keeper"]);
    // The workflow panel is the list a workflow is chosen from now (15.125): one remains.
    await expect(page.locator('[data-testid^="workflow-panel-"]:not([data-testid="workflow-panel-all"]):not([data-testid="workflow-panel-manage"]):not([data-testid="workflow-panel-new"])')).toHaveCount(1);
    await expect(tid(page, "workflow-panel-keeper")).toBeVisible();
    // Nor in the designer's picker, which is where a workflow is chosen at all.
    await page.goto(`${srv.url}/#/designer`);
    await expect(page.locator('[data-testid="wf-picker"] > option')).toHaveCount(2); // the placeholder and keeper
    await expect(page.locator('[data-testid="wf-picker"] > option').nth(1)).toHaveText("keeper");
  } finally {
    await srv.stop();
  }

  // "Keep it" closes the question and changes nothing.
  const second = await chief.serve();
  try {
    await page.goto(`${second.url}/#/designer/keeper`);
    await openWorkflowTab(page);
    await tid(page, "wf-delete").click();
    await tid(page, "delete-no").click();
    await expect(tid(page, "delete-modal")).toHaveCount(0);
    expect((await second.api("GET", "/api/workflows")).body.map((w: any) => w.name)).toEqual(["keeper"]);
  } finally {
    await second.stop();
  }
});

test("E15.2-2 a workflow that has runs is archived instead: every list forgets it, and nothing is lost", async ({ chief, page }) => {
  chief.importWorkflow("name: finished\nnodes:\n  - { id: a, type: gate, kind: approve, value: ship it }\n");
  chief.importWorkflow("name: current\nnodes:\n  - { id: a, type: gate, kind: approve, value: ok }\n");
  const srv = await chief.serve();
  try {
    // A real run and a schedule, so there is history to protect and something that must stop firing.
    const run = await srv.api("POST", "/api/runs", { workflow: "finished" });
    expect(run.status).toBe(201);
    const runId = run.body.run.id;
    expect((await srv.api("POST", "/api/schedules", { workflow: "finished", cron: "0 9 * * *" })).status).toBe(201);

    // Delete is refused by the server, and the refusal says what to do instead rather than only saying no.
    const refused = await srv.api("DELETE", "/api/workflows/finished");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Archive it instead");
    expect((await srv.api("GET", "/api/workflows")).body.map((w: any) => w.name).sort()).toEqual(["current", "finished"]);

    await page.setViewportSize({ width: 1360, height: 950 });
    await page.goto(`${srv.url}/#/designer/finished`);
    await openWorkflowTab(page);
    // In the UI the button is there but not offered, with the reason beside it — a disabled control never has to be guessed at.
    await expect(tid(page, "wf-delete")).toBeDisabled();
    await expect(tid(page, "wf-delete")).toHaveAttribute("title", /1 run is kept in full/);
    await expect(tid(page, "wf-archive")).toHaveText("Archive workflow");
    await expect(tid(page, "wf-archive-note")).toHaveCount(0);

    // Archive it. The panel says what happened, the bar carries an always-visible marker (the panel may be closed),
    // and Run is no longer offered: it is out of service.
    await tid(page, "wf-archive").click();
    await expect(tid(page, "designer-note")).toContainText("is archived");
    await expect(tid(page, "archived-chip")).toBeVisible();
    await expect(tid(page, "btn-run")).toBeDisabled();
    await expect(tid(page, "wf-archive")).toHaveText("Unarchive workflow");

    // Every list forgets it…
    await expect.poll(async () => (await srv.api("GET", "/api/workflows")).body.map((w: any) => w.name)).toEqual(["current"]);
    const live = await srv.api("GET", "/api/workflows");
    const gone = await srv.api("GET", "/api/workflows?archived=1");
    expect(live.body.find((w: any) => w.name === "finished")).toBeUndefined();
    expect(gone.body.map((w: any) => w.name)).toEqual(["finished"]);
    expect(gone.body[0].runs, "the archived row still knows its runs").toBe(1);
    // …the picker keeps a group for it, which is the only way back…
    await expect(page.locator('[data-testid="wf-picker"] optgroup[label="Archived"] option')).toHaveText("finished");
    await expect(page.locator('[data-testid="wf-picker"] > option')).toHaveCount(1);
    // …and it cannot be started, however it is asked.
    const start = await srv.api("POST", "/api/runs", { workflow: "finished" });
    expect(start.status).toBe(400);
    expect(start.body.error).toContain("archived");

    // A schedule of an archived workflow keeps its own on/off, stops firing, and says why it is quiet.
    await page.goto(`${srv.url}/#/schedules`);
    // The schedules list is paged, so the endpoint returns the rows themselves and the total in `X-Total-Count`.
    const schedule = (await srv.api("GET", "/api/schedules")).body[0];
    expect(schedule.enabled, "its own switch is untouched, so unarchiving needs no question").toBe(true);
    expect(schedule.workflow_archived).toBe(true);
    expect(schedule.next_run_at, "a time that will never come is not promised").toBeNull();
    await expect(tid(page, `schedule-archived-${schedule.id}`)).toContainText("workflow archived");

    // The run is untouched: readable, with its workflow's name, and its record still replayable.
    const detail = await srv.api("GET", `/api/runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.run.workflow_name ?? detail.body.run.workflow).toBe("finished");

    // Back in service: offered again, runnable again, and the schedule has a next firing again.
    await page.goto(`${srv.url}/#/designer/finished`);
    await openWorkflowTab(page);
    await tid(page, "wf-archive").click();
    await expect(tid(page, "archived-chip")).toHaveCount(0);
    await expect(tid(page, "btn-run")).toBeEnabled();
    await expect.poll(async () => (await srv.api("GET", "/api/workflows")).body.map((w: any) => w.name).sort()).toEqual(["current", "finished"]);
    await expect.poll(async () => (await srv.api("GET", "/api/schedules")).body[0].next_run_at).not.toBeNull();
  } finally {
    await srv.stop();
  }
});

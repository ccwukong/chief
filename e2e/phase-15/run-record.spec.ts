import { expect, test } from "../helpers";

/**
 * Task 15.99: one record on a run's page, not two.
 *
 * The page carried a **Replay** panel and an **Event log** panel side by side, and they were the same facts twice: chief
 * appends every event it records to `run__messages` as a `system` row (`addEvent` in `store.ts`), so the event log's rows
 * were already in the replay, less readable — raw JSON cut at 300 characters, no stepping, no step filter.
 *
 * Asked 2026-11-22: *"do we need to show both event replay and event logs? isn't event logs part of event replay's data?"*
 * It is. The panel is gone; what it showed lives in the record, and the record says the payload on the row instead of
 * hiding it behind a Details fold.
 *
 * `run__events` itself stays: it is the engine's own sequence, it is what the live stream reads, and it is what tells the
 * page a run has moved.
 */
test("E15.99-1 a run's page has one record: chief's own events are in the replay, with what they reported", async ({ chief, page }) => {
  chief.importWorkflow("name: one-record\nnodes:\n  - { id: echo, type: agent, prompt: 'say hi' }\n");
  chief.run(["run", "one-record"]);
  const srv = await chief.serve();
  try {
    await page.goto(`${srv.url}/#/runs/1`);
    await expect(page.getByTestId("replay")).toBeVisible();

    // The second panel is gone, and nothing else claims to be the run's log.
    await expect(page.getByTestId("event-log")).toHaveCount(0);
    await expect(page.locator('[data-testid="event-row"]')).toHaveCount(0);

    // Chief's own entries are in the replay, as `system` rows `kind`ed by the event's name — the transitions the event log
    // listed, in the same order as everything else that happened.
    const kinds = await page.locator('[data-testid^="replay-row-"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind));
    expect(kinds).toEqual(expect.arrayContaining(["run_input", "run_started", "node_running", "node_completed", "run_completed"]));
    expect(kinds.indexOf("run_input")).toBeLessThan(kinds.indexOf("run_completed"));

    // A row says what the event reported, rather than "(no content)" with the facts folded away: `node_completed` carries
    // the attempt and the phase.
    await page.locator('[data-testid^="replay-row-"][data-kind="node_completed"]').first().click();
    await expect(page.getByTestId("replay-kind")).toHaveText("node_completed");
    await expect(page.getByTestId("replay-content")).toContainText("attempt 1");
    await expect(page.getByTestId("replay-content")).toContainText("phase forward");

    // A transition with nothing in it says nothing, rather than filling a box with "nothing reported".
    await page.locator('[data-testid^="replay-row-"][data-kind="run_completed"]').first().click();
    await expect(page.getByTestId("replay-kind")).toHaveText("run_completed");
    await expect(page.getByTestId("replay-content")).toHaveCount(0);
  } finally {
    await srv.stop();
  }
});

import { expect, test } from "../helpers";
import type { Page } from "@playwright/test";

/**
 * Task 15.105: a schedule can be edited where it is listed, and it has a number you can say.
 *
 * Asked 2026-11-22, with a row selected: *"it doesn't have any edit feature for me to edit the schedule's WHEN and INPUT"*,
 * and *"each schedule should have a unique ID, so when i ask chief bot to manipulate a schedule, i can just quote the ID
 * instead of describing which schedule i wanna modify."*
 *
 * The `when` and the `inputs` are fields in the row now — there is no Save button, as everywhere in chief: the value is
 * written when the field is left, Enter does the same, and Escape puts back what the server has. A value the server
 * refuses is **not** kept, and the reason is said under the field it belongs to. The id was in the bot's own prompt long
 * before it was on the page; it is now `#3` under the workflow's name, which is what a person quotes.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

test("E15.105-1 WHEN and INPUTS are editable in place, and a refused value is not kept", async ({ chief, page }) => {
  // `team` has no default, so a schedule that does not supply it writes a run that would be refused for a missing input —
  // which is the check the Schedules form and the bot both go through.
  chief.importWorkflow("name: em-daily-operation\nnodes:\n  - { id: a, type: agent, prompt: 'for {{inputs.team}}' }\n");
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    expect((await srv.api("POST", "/api/schedules", { workflow: "em-daily-operation", cron: "0 10 * * 1-5", inputs: { team: "payments" } })).status).toBe(201);
    await page.goto(`${srv.url}/#/schedules`);
    await expect(tid(page, "schedule-row-1")).toBeVisible();

    // The id is shown, under the workflow's name, and says what it is for.
    await expect(tid(page, "schedule-id-1")).toHaveText("#1");
    await expect(tid(page, "schedule-id-1")).toHaveAttribute("title", /quote it to chief bot/);
    await expect(tid(page, "schedule-row-1")).toHaveAttribute("data-schedule-id", "1");

    // The expression is a field holding what is stored, with the description the server derives beside it.
    const cron = tid(page, "schedule-cron-1");
    await expect(cron).toHaveValue("0 10 * * 1-5");
    await expect(tid(page, "schedule-description-1")).toHaveText("every weekday at 10:00");
    // Editing it writes the schedule — there is no Save button to press.
    await cron.fill("0 7 * * *");
    await cron.blur();
    await expect.poll(async () => (await srv.api("GET", "/api/schedules")).body[0].cron).toBe("0 7 * * *");
    await expect(tid(page, "schedule-description-1")).toHaveText("every day at 07:00");
    await expect(tid(page, "schedule-row-1"), "one row, not a new schedule").toBeVisible();
    expect((await srv.api("GET", "/api/schedules")).body.length).toBe(1);

    // Enter saves too, and Escape puts back what the server has.
    await cron.fill("30 6 * * *");
    await cron.press("Enter");
    await expect.poll(async () => (await srv.api("GET", "/api/schedules")).body[0].cron).toBe("30 6 * * *");
    await cron.fill("0 0 * * *");
    await cron.press("Escape");
    await expect(cron).toHaveValue("30 6 * * *");
    expect((await srv.api("GET", "/api/schedules")).body[0].cron, "Escape saved nothing").toBe("30 6 * * *");

    // Inputs are a field of JSON, written the same way.
    const inputs = tid(page, "schedule-inputs-1");
    await expect(inputs).toHaveValue('{"team":"payments"}');
    await inputs.fill('{"team":"platform"}');
    await inputs.blur();
    await expect.poll(async () => (await srv.api("GET", "/api/schedules")).body[0].inputs).toEqual({ team: "platform" });
    // The workflow needs `team`, so an input the run would be refused without cannot be saved away.
    await inputs.fill('{"other":"x"}');
    await inputs.blur();
    await expect(tid(page, "schedule-inputs-error-1")).toContainText(/team/i);
    await expect.poll(async () => (await srv.api("GET", "/api/schedules")).body[0].inputs, "the refused value is not kept").toEqual({ team: "platform" });
    await expect(inputs, "and the field shows what is stored").toHaveValue('{"team":"platform"}');

    // An expression that cannot work: refused by the server, with its reason under the field, and the stored one put back.
    await cron.fill("not a cron");
    await cron.blur();
    await expect(tid(page, "schedule-cron-error-1")).toBeVisible();
    await expect(cron).toHaveValue("30 6 * * *");
    expect((await srv.api("GET", "/api/schedules")).body[0].cron).toBe("30 6 * * *");

    // Invalid JSON never reaches the server, and says so.
    await inputs.fill('{"team":');
    await inputs.blur();
    await expect(tid(page, "schedule-inputs-error-1")).toContainText("Not valid JSON");
    await expect(inputs).toHaveValue('{"team":"platform"}');
  } finally {
    await srv.stop();
  }
});

test("E15.105-2 the page says chief bot can do this, and its button opens the panel", async ({ chief, page }) => {
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.goto(`${srv.url}/#/schedules`);
    // A person who has never seen chief bot learns two things from this line: that it can write a schedule, and that the
    // number on the row is how to name it.
    const hint = tid(page, "schedules-bot-hint");
    await expect(hint).toBeVisible();
    await expect(hint).toContainText("chief bot");
    await expect(hint).toContainText("adds, changes, pauses and removes");
    await expect(hint).toContainText("#3");
    await expect(tid(page, "assistant-panel")).toHaveCount(0);
    await tid(page, "schedules-ask-bot").click();
    await expect(tid(page, "assistant-panel")).toBeVisible();
    // And it is the panel, on the Schedules page, not a new page.
    await expect(tid(page, "assistant-context")).toBeVisible();
    await expect(page).toHaveURL(/#\/schedules$/);
  } finally {
    await srv.stop();
  }
});

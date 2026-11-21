import { expect, test } from "../helpers";
import type { Page } from "@playwright/test";

/**
 * Task 15.103: the schedule row's two actions are glyphs.
 *
 * Reported 2026-11-22 with both selected: *"can we have icon buttons instead?"* Every row ended in a bordered **Disable**
 * and a solid red **Remove**, so the loudest thing in a table of what is scheduled was the button that deletes a schedule.
 * The same complaint as the run list's bin (15.94–15.96), answered the same way: a drawn glyph in a 28 px ghost button,
 * slate at rest, `--destructive` on hover, and the weight in the confirmation that already names what goes and says it
 * cannot be undone.
 *
 * The one thing an icon must not lose is the **name**, since there is no text left: `aria-label` and `title` carry it, and
 * the toggle's changes with the state — "Disable" on a schedule that is already disabled is worse than no label at all.
 *
 * Pause and play, not a power symbol: the question a row answers is "is it firing", and its two states are opposites.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

const look = (page: Page, id: string) => tid(page, id).evaluate((el) => {
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    border: s.borderTopWidth, shadow: s.boxShadow,
    w: Math.round(r.width), h: Math.round(r.height),
    glyphs: el.querySelectorAll("svg").length, text: (el.textContent ?? "").trim(),
    label: el.getAttribute("aria-label") ?? "", fill: el.querySelector("svg")?.getAttribute("fill") ?? "",
  };
});

test("E15.103-1 a schedule's Disable and Remove are glyphs, named for a screen reader, and still work", async ({ chief, page }) => {
  chief.importWorkflow("name: daily\nnodes:\n  - { id: a, type: agent, prompt: 'x' }\n");
  chief.importWorkflow("name: weekly\nnodes:\n  - { id: a, type: agent, prompt: 'x' }\n");
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1360, height: 950 });
    expect((await srv.api("POST", "/api/schedules", { workflow: "daily", cron: "0 9 * * *" })).status).toBe(201);
    await page.goto(`${srv.url}/#/schedules`);
    await expect(tid(page, "schedule-row-1")).toBeVisible();

    // Two glyphs, 28 × 28, neither of them a box: the red fill moved to the hover and to the confirmation.
    const pause = await look(page, "schedule-toggle-1");
    expect(pause.text, "no word left in it").toBe("");
    expect(pause.glyphs, "a drawn glyph").toBe(1);
    expect([pause.w, pause.h], "the row's size, not the header's").toEqual([28, 28]);
    expect(pause.border, "no border").toBe("0px");
    expect(pause.shadow, "no shadow").toBe("none");
    expect(pause.fill, "pause is drawn as strokes, not a filled shape").toBe("none");

    const remove = await look(page, "schedule-remove-1");
    expect(remove.text).toBe("");
    expect(remove.glyphs).toBe(1);
    expect([remove.w, remove.h]).toEqual([28, 28]);
    expect(remove.border).toBe("0px");
    // Slate at rest; `--destructive` when the pointer is on it — the danger appears where the decision is made.
    const restColour = await tid(page, "schedule-remove-1").evaluate((el) => getComputedStyle(el).color);
    await tid(page, "schedule-remove-1").hover();
    await page.waitForTimeout(300);
    expect(await tid(page, "schedule-remove-1").evaluate((el) => getComputedStyle(el).color)).not.toBe(restColour);

    // The name is the label, and it names the schedule it acts on: a row's glyph has no column heading to lean on.
    expect(pause.label).toMatch(/^Disable the schedule for /);
    expect(remove.label).toMatch(/^Remove the schedule for /);
    await expect(tid(page, "schedule-toggle-1")).toHaveAttribute("title", /stop it firing/i);

    // Disabling still works, and the glyph says what the next click would do: play, filled, named "Enable".
    await tid(page, "schedule-toggle-1").click();
    await expect(tid(page, "schedule-state-1")).toHaveText("disabled");
    await expect(tid(page, "schedule-toggle-1")).toHaveAttribute("aria-label", /^Enable the schedule for /);
    const play = await look(page, "schedule-toggle-1");
    expect(play.glyphs).toBe(1);
    expect(play.fill, "play is a filled triangle").toBe("currentColor");
    await tid(page, "schedule-toggle-1").click();
    await expect(tid(page, "schedule-state-1")).toHaveText("enabled");
    await expect(tid(page, "schedule-toggle-1")).toHaveAttribute("aria-label", /^Disable the schedule for /);

    // Remove still asks first, and the question carries the weight the button gave up.
    await tid(page, "schedule-remove-1").click();
    await expect(tid(page, "confirm-schedule-remove")).toContainText("0 9 * * *");
    await expect(tid(page, "confirm-schedule-remove")).toContainText("cannot be undone");
    await tid(page, "confirm-schedule-remove-keep").click();
    await expect(tid(page, "schedule-row-1")).toBeVisible();
    expect((await srv.api("GET", "/api/schedules")).body.length).toBe(1);
  } finally {
    await srv.stop();
  }
});

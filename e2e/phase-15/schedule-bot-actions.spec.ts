import { expect, fake, test } from "../helpers";
import type { Page } from "@playwright/test";

/**
 * Task 15.106: chief bot writes schedules — create with JSON inputs, change and delete by `#id`.
 *
 * Asked 2026-11-22: *"if i'm new to chief, i wont be able to know that chief bot can help me create/edit/delete/disable a
 * schedule … using chief bot to create a schedule is a lot easier than creating it manually, the only challenging part is
 * to use chief bot to create the JSON INPUT (I don't know for sure, can you run an e2e test to see if it's possible?)"*
 *
 * What this case proves is **chief's side of it**, end to end and not by reading the code: a question in plain words goes
 * in, the reply's `chief-schedule` block comes out of the stream, is checked by the same operations the Schedules form uses,
 * is written, and is shown on the page with the values that were asked for. The words inside the fake are the model's part;
 * the parser, the checks, the write and the record are chief's, and they are what can be tested here. (`@real` is where a
 * real CLI's own phrasing is exercised; this file is not tagged, so it runs everywhere and costs nothing.)
 *
 * The workflow deliberately needs an input with no default: a schedule with `inputs: {}` would be refused, which is the
 * part a person found hard to get right by hand.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

/** A reply with one fenced `chief-schedule` block, which is what the instructions ask the agent for. */
const withSchedule = (text: string, block: unknown) => `${text}\n\n\`\`\`chief-schedule\n${JSON.stringify(block)}\n\`\`\`\n`;

test("E15.106-1 chief bot creates a schedule with the inputs in a sentence, changes it by #id, and deletes it", async ({ chief, page }) => {
  // `team` has no default: the run would be refused without it, so a schedule for this workflow has to carry it.
  chief.importWorkflow("name: em-daily-operation\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'collect for {{inputs.team}}' }\n");
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    /**
     * One question, on a conversation of its own.
     *
     * A follow-up resumes the CLI's session, and the fake answers a session from its turn list — so a second question in
     * one session would need a second scripted turn, and the case would be testing the fake's turn counter rather than
     * chief. Each sentence here is about what chief does with one reply; the conversation and its memory are E15.67-1 and
     * E15.98-1's subject.
     */
    const ask = async (question: string) => {
      await srv.api("DELETE", "/api/assistant");
      return srv.api("POST", "/api/assistant", { question });
    };

    // 1. Create, in a sentence, with the JSON input it needs. The block is what a model would emit; chief has to read it,
    //    check it against the workflow, write it and record it.
    const created = await ask(`schedule em-daily-operation every weekday at 10am for the payments team ${fake({ text: withSchedule("Scheduled.", { action: "create", workflow: "em-daily-operation", cron: "0 10 * * 1-5", inputs: { team: "payments" } }) })}`);
    expect(created.status).toBe(200);
    const made = (created.body.conversation as any[]).at(-1).meta;
    expect(made.schedule_error, "chief accepted it").toBeNull();
    expect(made.schedule).toMatchObject({ action: "create", workflow: "em-daily-operation", cron: "0 10 * * 1-5", inputs: { team: "payments" } });
    expect(made.schedule.id, "and it has the id the answer shows").toBe(1);
    expect(made.schedule.description, "the time in words, for the person to check at a glance").toContain("every weekday at 10:00");
    const rows = (await srv.api("GET", "/api/schedules")).body as any[];
    expect(rows.map((s) => ({ cron: s.cron, inputs: s.inputs }))).toEqual([{ cron: "0 10 * * 1-5", inputs: { team: "payments" } }]);

    // 2. A schedule whose inputs are missing is refused, with the reason the run would have given: this is the part that is
    //    hard to do by hand, and chief checks it before writing rather than at the first firing.
    const missing = await ask(`schedule em-daily-operation every day at 6 ${fake({ text: withSchedule("Scheduled.", { action: "create", workflow: "em-daily-operation", cron: "0 6 * * *", inputs: {} }) })}`);
    const refused = (missing.body.conversation as any[]).at(-1).meta;
    expect(refused.schedule, "nothing was written").toBeNull();
    expect(refused.schedule_error).toContain("team");
    expect((await srv.api("GET", "/api/schedules")).body.length, "still one schedule").toBe(1);

    // 3. Change it by quoting the id — the number the page shows.
    const moved = await ask(`move #1 to 18:30 ${fake({ text: withSchedule("Moved.", { action: "update", id: 1, cron: "30 18 * * 1-5" }) })}`);
    expect((moved.body.conversation as any[]).at(-1).meta.schedule).toMatchObject({ action: "update", id: 1, cron: "30 18 * * 1-5" });
    expect((await srv.api("GET", "/api/schedules")).body[0].cron).toBe("30 18 * * 1-5");

    // 4. Pause it, by id, without touching its expression or its inputs.
    const paused = await ask(`pause #1 ${fake({ text: withSchedule("Paused.", { action: "update", id: 1, enabled: false }) })}`);
    expect((paused.body.conversation as any[]).at(-1).meta.schedule).toMatchObject({ action: "update", id: 1, enabled: false });
    const off = (await srv.api("GET", "/api/schedules")).body[0];
    expect(off.enabled).toBe(false);
    expect(off.cron, "the expression is untouched").toBe("30 18 * * 1-5");

    // 5. Delete it, by id. The change says what went, with the cron and inputs, so it can be written back.
    const gone = await ask(`remove #1 ${fake({ text: withSchedule("Removed.", { action: "delete", id: 1 }) })}`);
    const removed = (gone.body.conversation as any[]).at(-1).meta;
    expect(removed.schedule_error).toBeNull();
    expect(removed.schedule).toMatchObject({ action: "delete", id: 1, cron: "30 18 * * 1-5", inputs: { team: "payments" } });
    expect((await srv.api("GET", "/api/schedules")).body).toEqual([]);

    // 6. And on the page: a create is shown as a schedule that is now there, and a delete as what went and how to put it
    //    back — including the id, which is what the next sentence will quote.
    const again = await ask(`schedule em-daily-operation every weekday at 10am for the payments team ${fake({ text: withSchedule("Scheduled.", { action: "create", workflow: "em-daily-operation", cron: "0 10 * * 1-5", inputs: { team: "payments" } }) })}`);
    expect(again.status).toBe(200);
    await page.goto(`${srv.url}/#/schedules`);
    await expect(tid(page, "schedule-row-2")).toBeVisible();
    await expect(tid(page, "schedule-id-2")).toHaveText("#2");
    await expect(tid(page, "schedule-cron-2")).toHaveValue("0 10 * * 1-5");
    await expect(tid(page, "schedule-inputs-2")).toHaveValue('{"team":"payments"}');
    await page.goto(`${srv.url}/#/runs`);
    await tid(page, "nav-assistant").click();
    await expect(tid(page, "assistant-panel")).toBeVisible();
    const line = page.locator('[data-testid="assistant-schedule"]').last();
    await expect(line).toHaveAttribute("data-action", "create");
    await expect(line).toContainText("#2");
  } finally {
    await srv.stop();
  }
});

test("E15.106-2 a delete is shown as an amber line naming what went, and never as a change that left something behind", async ({ chief, page }) => {
  chief.importWorkflow("name: nightly\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'x' }\n");
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    expect((await srv.api("POST", "/api/schedules", { workflow: "nightly", cron: "0 2 * * *" })).status).toBe(201);

    // A delete block carrying a cron as well is a mistake, and is said rather than half-carried-out.
    // Each question on a conversation of its own, for the reason E15.106-1 gives: a follow-up resumes the CLI's session,
    // and what this case is about is one reply and what chief does with it.
    const ask = async (question: string) => { await srv.api("DELETE", "/api/assistant"); return srv.api("POST", "/api/assistant", { question }); };
    const wrong = await ask(`remove #1 ${fake({ text: withSchedule("Removed.", { action: "delete", id: 1, cron: "0 3 * * *" }) })}`);
    const bad = (wrong.body.conversation as any[]).at(-1).meta;
    expect(bad.schedule).toBeNull();
    expect(bad.schedule_error).toContain("only `id`");
    expect((await srv.api("GET", "/api/schedules")).body.length, "nothing was removed").toBe(1);

    // The plain one works, and the panel's line is the amber one: nothing is left to visit on the Schedules page.
    const ok = await ask(`remove #1 ${fake({ text: withSchedule("Removed.", { action: "delete", id: 1 }) })}`);
    expect((ok.body.conversation as any[]).at(-1).meta.schedule).toMatchObject({ action: "delete", id: 1 });
    await page.goto(`${srv.url}/#/runs`);
    await tid(page, "nav-assistant").click();
    const line = page.locator('[data-testid="assistant-schedule"]').last();
    await expect(line).toHaveAttribute("data-action", "delete");
    await expect(line).toContainText("Removed schedule #1 of nightly");
    await expect(line).toContainText("To bring it back");
    await expect(line).toContainText("0 2 * * *");
    // Amber, not teal: a schedule that is gone is not one the page can show you. Chromium writes these tokens as `oklch`,
    // so the two are told apart by their hue — amber is around 91°, teal around 180° — rather than by their format.
    const tone = await line.evaluate((el) => getComputedStyle(el).borderTopColor);
    const hue = Number(tone.match(/oklch\([\d.]+\s+[\d.]+\s+([\d.]+)/)?.[1] ?? NaN);
    expect(hue, `an amber border, not teal (${tone})`).toBeGreaterThan(60);
    expect(hue).toBeLessThan(120);
    await expect(line.locator("a"), "and no 'it is on the Schedules page' link").toHaveCount(0);
  } finally {
    await srv.stop();
  }
});

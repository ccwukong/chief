import { expect, fake, roomyLayout, test } from "../helpers";

/**
 * Phase 15, task 15.32: chief bot writes a schedule.
 *
 * It has no tools (the rule the whole design rests on), so it asks the same way it changes a canvas: a
 * fenced `chief-schedule` block. chief checks it against the workflow and the cron parser — the check the
 * Schedules form gets — and writes it through the same operation the page calls. These cases are about
 * the seam: what gets written, what is refused, and that a refusal is asked for once and then dropped.
 */

const block = (tag: string, v: unknown) => "```" + tag + "\n" + JSON.stringify(v, null, 2) + "\n```";
const DAILY = { name: "daily", nodes: [{ id: "a", type: "agent", prompt: "A" }], edges: [] };
const imported = "name: daily\nnodes:\n  - { id: a, type: agent, prompt: 'A' }\n";
const schedules = async (s: any) => (await s.api("GET", "/api/schedules")).body;

test("E15.32-1 the assistant schedules the workflow on the canvas, through the same check the form gets", async ({ chief }) => {
  const s = await chief.serve();
  try {
    chief.importWorkflow(imported);
    const q = `every weekday at 9am ${fake({ text: `Scheduled it: every weekday at 09:00.\n\n${block("chief-schedule", { action: "create", cron: "0 9 * * 1-5" })}` })}`;
    const a = await s.api("POST", "/api/assistant", { question: q, workflow: { definition: DAILY } });

    expect(a.status).toBe(200);
    // The answer is the agent's text with the block taken out, and the schedule it wrote is recorded.
    expect(a.body).toMatchObject({ answer: "Scheduled it: every weekday at 09:00.", schedule_error: null, change: null });
    expect(a.body.schedule).toMatchObject({ action: "create", workflow: "daily", cron: "0 9 * * 1-5" });
    expect(a.body.schedule.id).toBeGreaterThan(0);
    // In words, and when it next fires: the panel and the log say what a person can check at a glance.
    expect(a.body.schedule.description).toContain("09:00");
    expect(a.body.schedule.description).toContain("next");
    expect(a.body.conversation.at(-1).meta.schedule).toMatchObject({ id: a.body.schedule.id });

    // Written, not proposed: the list the Schedules page reads already has it, enabled.
    expect(await schedules(s)).toMatchObject([{ id: a.body.schedule.id, workflow_name: "daily", cron: "0 9 * * 1-5", enabled: true }]);

    // It was told the block exists and what this workflow has; the block itself is not left in the prose.
    const prompt = chief.calls().at(-1)!.prompt;
    expect(prompt).toContain("## Schedules");
    expect(prompt).toContain("## Schedules of this workflow");
    expect(prompt).toContain("None.");
    expect(a.body.answer).not.toContain("chief-schedule");
  } finally {
    await s.stop();
  }
});

test("E15.32-2 an expression chief will not accept is refused once, corrected in the same session, and only the correction is written", async ({ chief }) => {
  const s = await chief.serve();
  try {
    chief.importWorkflow(imported);
    const q = `at 9 ${fake(
      { text: `Scheduling it.\n\n${block("chief-schedule", { action: "create", cron: "0 99 * * *" })}` },
      { text: `My mistake.\n\n${block("chief-schedule", { action: "create", cron: "0 9 * * *" })}` },
    )}`;
    const a = await s.api("POST", "/api/assistant", { question: q, workflow: { definition: DAILY } });

    expect(a.body).toMatchObject({ answer: "My mistake.", schedule_error: null, cost_usd: 0.02 });
    expect(a.body.schedule).toMatchObject({ cron: "0 9 * * *" });
    // The correction was asked for in the conversation, with the reason the engine gave, and the block to use.
    const fix = chief.calls().at(-1)!;
    expect(fix.prompt).toContain("chief did not accept that");
    expect(fix.prompt).toContain("invalid cron expression");
    expect(fix.prompt).toContain("chief-schedule block");
    // One schedule exists, and it is the corrected one: the refused expression never reached the store.
    const rows = await schedules(s);
    expect(rows).toMatchObject([{ cron: "0 9 * * *" }]);
    expect(rows.length).toBe(1);
  } finally {
    await s.stop();
  }
});

test("E15.32-3 a schedule that is still wrong writes nothing, and the reply says why", async ({ chief }) => {
  const s = await chief.serve();
  try {
    chief.importWorkflow(imported);
    // Four fields, twice: the correction is refused as well.
    const q = `every day ${fake(
      { text: `Scheduling it.\n\n${block("chief-schedule", { action: "create", cron: "0 9 * *" })}` },
      { text: `${block("chief-schedule", { action: "create", cron: "0 9 * *" })}` },
    )}`;
    const a = await s.api("POST", "/api/assistant", { question: q, workflow: { definition: DAILY } });

    expect(a.body.schedule).toBeNull();
    expect(a.body.schedule_error).toContain("5 fields");
    // Nothing was written, so the page has nothing to show and the person can ask again.
    expect(await schedules(s)).toEqual([]);
  } finally {
    await s.stop();
  }
});

test("E15.32-4 an existing schedule is changed by id, and one belonging to another workflow is refused", async ({ chief }) => {
  const s = await chief.serve();
  try {
    chief.importWorkflow(imported);
    chief.importWorkflow("name: other\nnodes:\n  - { id: b, type: agent, prompt: 'B' }\n");
    const mine = (await s.api("POST", "/api/schedules", { workflow: "daily", cron: "0 9 * * *" })).body;
    const theirs = (await s.api("POST", "/api/schedules", { workflow: "other", cron: "0 8 * * *" })).body;

    // Paused by id, from the list it was shown.
    const a = await s.api("POST", "/api/assistant", { question: `pause the daily one ${fake({ text: `Paused it.\n\n${block("chief-schedule", { action: "update", id: mine.id, enabled: false })}` })}`, workflow: { definition: DAILY } });
    expect(a.body).toMatchObject({ answer: "Paused it.", schedule_error: null });
    expect(a.body.schedule).toMatchObject({ action: "update", id: mine.id, workflow: "daily", enabled: false });
    expect((await schedules(s)).find((r: any) => r.id === mine.id).enabled).toBe(false);
    // It was given the id to name, and the expression in words.
    const prompt = chief.calls().at(-1)!.prompt;
    expect(prompt).toContain(`#${mine.id}: \`0 9 * * *\``);
    expect(prompt).toContain("enabled");

    // A new session (the conversation is cleared) so the second question is answered from a fresh prompt:
    // the canvas is "daily", and the schedule named belongs to "other".
    await s.api("DELETE", "/api/assistant");
    const b = await s.api("POST", "/api/assistant", { question: `pause ${theirs.id} ${fake({ text: `Done.\n\n${block("chief-schedule", { action: "update", id: theirs.id, enabled: false })}` })}`, workflow: { definition: DAILY } });
    expect(b.body.schedule).toBeNull();
    expect(b.body.schedule_error).toContain(`belongs to "other"`);
    // And it was not touched.
    expect((await schedules(s)).find((r: any) => r.id === theirs.id).enabled).toBe(true);
  } finally {
    await s.stop();
  }
});

test("E15.32-5 the chatbox writes it: asked in the designer, the panel says what was scheduled and the Schedules page has it", async ({ chief, page }) => {
  chief.importWorkflow(imported);
  const srv = await chief.serve();
  const tid = (id: string) => page.getByTestId(id);
  try {
    await roomyLayout(srv);
    await page.goto(`${srv.url}/#/designer/daily`);
    await tid("assistant-button").click();
    await expect(tid("assistant-context")).toHaveText("designing daily");

    await tid("assistant-question").fill(`run this every weekday at 9am ${fake({ text: `Scheduled it for every weekday at 09:00.\n\n${block("chief-schedule", { action: "create", cron: "0 9 * * 1-5" })}` })}`);
    await tid("assistant-send").click();

    // The answer says it in words, the block is not shown as prose, and the panel names what it wrote.
    await expect(tid("assistant-turn-assistant")).toContainText("every weekday at 09:00");
    await expect(tid("assistant-turn-assistant")).not.toContainText("chief-schedule");
    const card = tid("assistant-schedule");
    await expect(card).toHaveAttribute("data-action", "create");
    await expect(card).toContainText("Scheduled daily");
    await expect(card).toContainText("09:00");
    // No error card: it was accepted.
    await expect(tid("assistant-schedule-error")).toHaveCount(0);

    // And the page where schedules live has the row, with the expression in words the engine produced.
    await page.goto(`${srv.url}/#/schedules`);
    const row = page.locator('[data-testid^="schedule-row-"]').first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("daily");
    await expect(row).toContainText("09:00");
  } finally {
    await srv.stop();
  }
});

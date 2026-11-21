import { expect, test } from "../helpers";

/**
 * Task 15.98: chief bot's own context compaction.
 *
 * The bot does not keep an agent running: each question spawns the CLI once, and a follow-up is a new process with
 * `--resume <session>`. So while a conversation is being resumed, **its context is the CLI's** — chief cannot see into it
 * or trim it. Claude Code compacts its own session; `cursor-agent` has none and refuses outright once the context is full.
 *
 * What chief can do, and does, is measure: every reply reports `usage.input_tokens`, which is what the session actually
 * read. Past a budget, chief has the conversation written down as notes, records the message it was compacted through
 * (which retires that session), and answers the next question from a **fresh** session seeded with the notes. Nothing is
 * thrown away: the messages, the notes and the record all stay.
 *
 * The fake reports the token count it is told to, which is how a conversation can be made "large" in one turn.
 */
const fakeWith = (tokens: number, text: string) => `<fake>${JSON.stringify({ text, tokens: { in: tokens, out: 20 } })}</fake>`;

test("E15.98-1 a conversation past the budget is compacted once, and the next answer starts from the notes", async ({ chief }) => {
  const srv = await chief.serve();
  try {
    // A budget far below what the first answer reports, so one turn is enough to cross it.
    expect((await srv.api("PUT", "/api/settings", { "assistant-context-budget": 10_000 })).status).toBe(200);

    const first = await srv.api("POST", "/api/assistant", { question: `first ${fakeWith(200_000, "First answer.")}` });
    expect(first.status).toBe(200);
    expect(first.body.conversation.at(-1).meta.resumed, "the first answer has no session to resume").toBe(false);
    expect(first.body.conversation.at(-1).meta.compacted_from, "and nothing to compact yet").toBeNull();

    // The session now reports 200k, past the 10k budget: the next answer is compacted first, then given from a fresh
    // session that starts with the notes rather than resuming the large one.
    const second = await srv.api("POST", "/api/assistant", { question: `second ${fakeWith(300, "Second answer, from the notes.")}` });
    const m2 = second.body.conversation.at(-1).meta;
    expect(m2.compacted_from, "the answer records the size it compacted from").toBe(200_000);
    expect(m2.resumed, "and it did not resume the session it just retired").toBe(false);
    expect(second.body.conversation.at(-1).text).toContain("Second answer");

    // The third answer resumes the *new* session: compaction is not a one-way door, and it is not repeated until the new
    // session grows past the budget in its own right.
    const third = await srv.api("POST", "/api/assistant", { question: `third ${fakeWith(400, "Third answer.")}` });
    const m3 = third.body.conversation.at(-1).meta;
    expect(m3.resumed, "the session begun after the compaction is resumed normally").toBe(true);
    expect(m3.compacted_from, "and nothing is compacted again for nothing").toBeNull();

    // The notes are on the thread, with the message they cover, and the compaction itself is in the record (it was a real
    // invocation, and every invocation is recorded) without becoming a conversation turn.
    const threads = (await srv.api("GET", "/api/assistant/threads")).body as any[];
    expect(threads.length, "one conversation").toBe(1);
    const conversation = (await srv.api("GET", "/api/assistant")).body.conversation as any[];
    expect(conversation.every((t) => t.role === "user" || t.role === "assistant"), "the record is not a visible turn").toBe(true);
    expect(conversation.length, "three questions and three answers").toBe(6);
  } finally {
    await srv.stop();
  }
});

test("E15.98-2 a conversation under the budget is never compacted, and the budget is a setting", async ({ chief, page }) => {
  const srv = await chief.serve();
  try {
    // The shipped default is 100k; the field shows it and it survives being changed.
    await page.setViewportSize({ width: 1320, height: 1000 });
    await page.goto(`${srv.url}/#/settings`);
    const field = page.getByTestId("setting-bot-context-budget");
    await expect(field).toHaveValue("100000");
    await field.fill("20000");
    await field.blur();
    await expect.poll(async () => (await srv.api("GET", "/api/settings")).body["assistant-context-budget"]).toBe(20000);
    // A value too small to be sensible is refused rather than accepted: a budget of 1 would compact on every turn.
    await field.fill("5");
    await field.blur();
    await expect.poll(async () => (await srv.api("GET", "/api/settings")).body["assistant-context-budget"]).toBe(100_000);

    // Under the budget, a conversation continues on its session and is never compacted — which is the common case, and the
    // one a bug here would make expensive (a compaction call on every turn).
    const one = await srv.api("POST", "/api/assistant", { question: `one ${fakeWith(5_000, "One.")}` });
    expect(one.status).toBe(200);
    const two = await srv.api("POST", "/api/assistant", { question: `two ${fakeWith(6_000, "Two.")}` });
    const m = two.body.conversation.at(-1).meta;
    expect(m.resumed, "well under the budget, the session is resumed").toBe(true);
    expect(m.compacted_from).toBeNull();
    // The panel says nothing about compaction when nothing was compacted.
    await page.goto(`${srv.url}/#/runs`);
    await expect(page.getByTestId("sidenav")).toBeVisible();
    await page.getByTestId("nav-assistant").click();
    await expect(page.getByTestId("assistant-turn-assistant").last()).toBeVisible();
    await expect(page.getByTestId("assistant-compacted")).toHaveCount(0);
  } finally {
    await srv.stop();
  }
});

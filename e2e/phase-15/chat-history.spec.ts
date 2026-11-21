import { expect, test } from "../helpers";
import type { Page } from "@playwright/test";

/**
 * Task 15.104: past conversations are a dropdown, and one can be deleted for good.
 *
 * Reported 2026-11-22, with the inline strip selected: *"can we have a dropdown list to select the chat session history
 * instead of this? this looks so confusing. Also, users should be able to delete a chat session history completely."*
 *
 * The strip sat **above** the conversation and pushed it down every time it opened, and its delete was a `×` at
 * `opacity-0` until the row was hovered — which is why a delete existed and could not be found. It is a dropdown anchored
 * to the header now, over the conversation rather than in front of it, with a bin on every row and a confirmation that says
 * the messages go with it.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

/** Three conversations, the newest current, so the list has something to pick from. */
async function threeConversations(srv: { api: (m: string, p: string, b?: unknown) => Promise<{ status: number; body: any }> }) {
  const ask = (q: string) => srv.api("POST", "/api/assistant", { question: q });
  await ask("which runs failed this week?");
  await srv.api("POST", "/api/assistant/threads");
  await ask("summarise the daily triage run");
  await srv.api("POST", "/api/assistant/threads");
  await ask("what is waiting for me?");
}

test("E15.104-1 history is a dropdown over the conversation, and a conversation can be deleted with its messages", async ({ chief, page }) => {
  const srv = await chief.serve();
  try {
    await threeConversations(srv);
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "sidenav")).toBeVisible();
    await tid(page, "nav-assistant").click();
    await expect(tid(page, "assistant-panel")).toBeVisible();

    const conversation = tid(page, "assistant-conversation");
    const above = (await conversation.boundingBox())!;
    await tid(page, "assistant-history").click();
    const list = tid(page, "assistant-history-list");
    await expect(list).toBeVisible();
    await expect(list).toHaveAttribute("role", "menu");

    // A dropdown: it starts where the header ends, and the conversation does not move out from under it.
    const box = (await list.boundingBox())!;
    const header = (await tid(page, "assistant-history").boundingBox())!;
    expect(box.y, "below the button it hangs from").toBeGreaterThan(header.y);
    // The button is at the header's top, so the menu starts at the header's bottom (~52 px: the panel's top row is 48 and
    // the menu hangs a 4 px gap below it).
    expect(box.y, "just under the header, not down the page").toBeLessThan(header.y + 56);
    expect((await conversation.boundingBox())!.y, "the conversation stays where it was").toBe(above.y);
    // Over the conversation, not in front of the whole page: its right edge is inside the panel's.
    const panel = (await tid(page, "assistant-panel").boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);

    // One row per conversation, each with a visible bin — the part that could not be found when it was a hover-only ×.
    expect(await page.locator('[data-testid^="assistant-thread-open-"]').count()).toBe(3);
    const bins = page.locator('[data-testid^="assistant-thread-delete-"]');
    expect(await bins.count()).toBe(3);
    for (let i = 0; i < 3; i++) {
      const opacity = await bins.nth(i).evaluate((el) => getComputedStyle(el).opacity);
      expect(opacity, "every bin is visible without hovering").toBe("1");
      expect(await bins.nth(i).locator("svg").count(), "a drawn bin, not a ×").toBe(1);
    }
    // The current one is marked, so "which am I in" needs no guessing.
    expect(await page.locator('[data-testid^="assistant-thread-current-"]').count()).toBe(1);

    // Escape closes the menu and leaves the panel open — one press for one layer.
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);
    await expect(tid(page, "assistant-panel")).toBeVisible();

    // Clicking elsewhere closes it too, and changes nothing.
    await tid(page, "assistant-history").click();
    await expect(list).toBeVisible();
    await page.mouse.click(panel.x + panel.width + 60, 500);
    await expect(list).toHaveCount(0);

    // Picking one opens it and closes the menu.
    await tid(page, "assistant-history").click();
    await page.locator('[data-testid^="assistant-thread-open-"]').filter({ hasText: "summarise the daily triage run" }).first().click();
    await expect(list).toHaveCount(0);
    await expect(conversation).toContainText("summarise the daily triage run");

    // Deletion asks once, and says the messages go with it.
    const threads: { id: number; title: string }[] = (await srv.api("GET", "/api/assistant/threads")).body;
    const doomed = threads.find((t) => t.title.startsWith("which runs failed"))!;
    await tid(page, "assistant-history").click();
    await tid(page, `assistant-thread-delete-${doomed.id}`).click();
    const confirm = tid(page, "confirm-thread-delete");
    await expect(confirm).toContainText("which runs failed");
    await expect(confirm).toContainText("This cannot be undone");
    // "Keep" changes nothing.
    await tid(page, "confirm-thread-delete-keep").click();
    await expect(confirm).toHaveCount(0);
    expect((await srv.api("GET", "/api/assistant/threads")).body.length).toBe(3);

    // And "Delete conversation" removes it completely: the thread is gone from the list, and its messages are gone from
    // the database, not hidden from the panel.
    await tid(page, "assistant-history").click();
    await tid(page, `assistant-thread-delete-${doomed.id}`).click();
    await tid(page, "confirm-thread-delete-yes").click();
    await expect.poll(async () => (await srv.api("GET", "/api/assistant/threads")).body.map((t: any) => t.id)).not.toContain(doomed.id);
    const schemas = (await srv.api("GET", "/api/doctor")).body.db.schemas.assistant;
    const rows = Object.fromEntries(schemas.map((t: any) => [t.table, t.rows]));
    // Two conversations left, three rows each: the question, the prompt exactly as the CLI was given, and the answer. The
    // deleted one's three are gone, which is what "deleted completely" means — the count would be 9 if they were only
    // hidden from the panel.
    expect(rows.messages, "the deleted conversation's messages went with it").toBe(6);
    expect((await srv.api("GET", "/api/assistant/threads")).body.length).toBe(2);
    await tid(page, "assistant-history").click();
    await expect(page.locator('[data-testid^="assistant-thread-open-"]').filter({ hasText: "which runs failed" })).toHaveCount(0);
  } finally {
    await srv.stop();
  }
});

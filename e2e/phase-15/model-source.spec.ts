import { expect, test } from "../helpers";
import type { Locator, Page } from "@playwright/test";

/**
 * Task 15.101: one "from …" line under a model picker, in the CLI's own name.
 *
 * Reported 2026-11-22 from Settings, with two lines of text under one dropdown: *"why do i see 2 `from opencode`?"* Both
 * were the same sentence. `ModelSelect` draws its own hint ("from `<adapter>`", the raw slug) and Settings added the line
 * that explains what **Auto** means — which, for a chosen CLI, said the same thing again, in the friendly name
 * ("from OpenCode"). Two paragraphs of grey text under one field, disagreeing about what to call the CLI.
 *
 * The fix is not "delete the sentence": the line that survives is the one that knows something `ModelSelect` cannot, which
 * is what Auto resolves to on a page. So `ModelSelect` can be told the caller will say it (`saySource={false}`), and
 * everywhere else it says it in the label the rest of the app uses — never the slug.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

/**
 * The "from …" lines inside a field's whole box, so two of them can be counted rather than eyeballed in a screenshot.
 *
 * The box, not the `<label>`: Settings keeps its hint next to the picker rather than inside `ModelSelect`'s own `Field`, and
 * that is exactly the arrangement that produced the duplicate — a helper scoped to the label would have passed while the
 * screen still said it twice.
 */
const sourceLines = (box: Locator) => box.evaluate((el) =>
  [...el.querySelectorAll("*")]
    .filter((n) => n.children.length === 0 && /^from /.test((n.textContent ?? "").trim()))
    .map((n) => (n.textContent ?? "").trim()));

test("E15.101-1 a model picker says where its list comes from once, in the CLI's name", async ({ chief, page }) => {
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1360, height: 1000 });

    // Settings, with a CLI chosen: exactly one line, and it names the CLI the way the rest of the app does — "Claude Code",
    // not the slug "claude-code" that the picker used to print. (The harness fakes Claude Code; the other CLIs are absent.)
    await srv.api("PUT", "/api/settings", { "assistant-adapter": "claude-code" });
    await page.goto(`${srv.url}/#/settings`);
    await expect(tid(page, "setting-bot-model")).toHaveAttribute("data-loaded", "true");
    const settingsField = tid(page, "setting-bot-model-field");
    await expect.poll(() => sourceLines(settingsField)).toEqual(["from Claude Code"]);

    // With Auto, the line is the one that explains Auto — still a single line, because it is the one that carries the
    // meaning `ModelSelect` cannot ("the models come from the CLI of the page you are on").
    await tid(page, "setting-bot-adapter").selectOption("auto");
    await expect(tid(page, "bot-model-hint")).toContainText("Following the page");
    await expect.poll(() => sourceLines(settingsField)).toEqual([]);
    await expect.poll(async () => (await settingsField.textContent())?.match(/from /g)?.length).toBe(1);

    // A step's own model picker has no caller-supplied line, so it keeps its own — in the label, not the slug: the CLI is
    // "Claude Code" in the rail, in the panel and here.
    await srv.api("POST", "/api/workflows/import", { yaml: "name: hint\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'x' }\n" });
    await page.goto(`${srv.url}/#/designer/hint`);
    await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
    await tid(page, "flow-node-a").click();
    await expect(tid(page, "node-model")).toHaveAttribute("data-loaded", "true");
    // In the panel there is no caller-supplied line, so the field's own is the single one.
    await expect.poll(() => sourceLines(page.locator('label:has([data-testid="node-model"])'))).toEqual(["from Claude Code"]);
  } finally {
    await srv.stop();
  }
});

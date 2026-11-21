import { expect, test } from "../helpers";
import type { Page } from "@playwright/test";

/**
 * Task 15.107: a suggestion wraps instead of running out of the panel.
 *
 * Reported 2026-11-22, with one selected under the box the panel sits beside: *"this part is overlapped by the other
 * section, can we make it text wrapping?"* `Button`'s base class carries `whitespace-nowrap` — a rule that is right for a
 * toolbar and wrong for a sentence — so a row of pills in a 380 px panel drew 415 px of text and the last part of it went
 * under the neighbouring column. The rail's "14 MCP servers" was the same fault (15.88); this is the other place a
 * `Button` holds prose.
 *
 * What is asserted is geometry, not a class name: every suggestion fits inside the panel, and the long ones are **taller
 * than one line**, which is what "it wrapped" means.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

const suggestions = (page: Page) => page.evaluate(() => {
  const panel = document.getElementById("assistant-panel")!.getBoundingClientRect();
  return [...document.querySelectorAll('[data-testid^="assistant-suggestion-"]')].map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      text: (el.textContent ?? "").trim(),
      w: Math.round(r.width), h: Math.round(r.height),
      right: Math.round(r.right),
      panelRight: Math.round(panel.right), panelLeft: Math.round(panel.left),
      wrap: cs.whiteSpace,
    };
  });
});

test("E15.107-1 a suggestion wraps inside the panel, and the long ones take two lines", async ({ chief, page }) => {
  chief.importWorkflow("name: roomy\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'x' }\n");
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1200, height: 850 });
    await page.goto(`${srv.url}/#/designer/roomy`);
    await expect(tid(page, "sidenav")).toBeVisible();
    if (!(await tid(page, "assistant-panel").isVisible().catch(() => false))) await tid(page, "nav-assistant").click();
    await expect(tid(page, "assistant-suggestion-0")).toBeVisible();

    const list = await suggestions(page);
    expect(list.length, "the designer's suggestions are the long ones").toBeGreaterThan(2);
    for (const s of list) {
      expect(s.wrap, `"${s.text}" may wrap`).toBe("normal");
      // Inside the panel, with its own padding on both sides: no text under the column beside it.
      expect(s.right, `"${s.text}" ends inside the panel`).toBeLessThanOrEqual(s.panelRight);
      expect(s.w + 8, `"${s.text}" leaves room on both sides`).toBeLessThanOrEqual(s.panelRight - s.panelLeft + 1);
    }
    // A sentence that does not fit on one line is taller than one, which is the wrap itself: a `nowrap` button stays at
    // the one-line height however wide its text is.
    const oneLine = Math.min(...list.map((s) => s.h));
    const longest = list.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    expect(longest.h, `"${longest.text}" wraps onto a second line`).toBeGreaterThan(oneLine);
    expect(longest.h, "and no more than a couple of lines").toBeLessThan(oneLine * 3);

    // The panel does not scroll sideways either, and the page does not at 375 px (AGENTS.md).
    expect(await page.evaluate(() => { const p = document.getElementById("assistant-panel")!; return p.scrollWidth > p.clientWidth + 1; })).toBe(false);
    await page.setViewportSize({ width: 375, height: 700 });
    await page.waitForTimeout(300);
    for (const s of await suggestions(page)) {
      expect(s.right, `"${s.text}" fits a phone`).toBeLessThanOrEqual(375);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  } finally {
    await srv.stop();
  }
});

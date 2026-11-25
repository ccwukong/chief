import { expect, fake, test, gotoRuns } from "../helpers";
import type { Page } from "@playwright/test";

/**
 * Tasks 15.85 to 15.97: a run of one complaint, said nine times — *the controls were heavier than the things they do.*
 *
 * Dismissals and navigations were drawn as bordered, filled, shadowed boxes beside real actions, so the loudest control
 * on a page about reading was the one that closed it. Each case below measures one of those claims rather than trusting
 * the class name: **no border, no fill, no shadow, one drawn glyph**, and the confirmation carries the weight instead.
 *
 * These are the tasks' own cases. Where a task's work is also asserted by a wider case (the bin's three properties in
 * E15.90-1, the bot header in E9.64-2), the plan says so — the case here is the task's claim, and it is written so that a
 * regression in that one control fails here, by name.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

/** What a control looks like, as the browser computes it: the four properties "a glyph button" means. */
const look = (page: Page, testid: string) => tid(page, testid).evaluate((el) => {
  const s = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    border: s.borderTopWidth, bg: s.backgroundColor, shadow: s.boxShadow,
    w: Math.round(r.width), h: Math.round(r.height),
    glyphs: el.querySelectorAll("svg").length, text: (el.textContent ?? "").trim(),
  };
});
const bare = (v: { border: string; bg: string; shadow: string }) => ({
  border: v.border === "0px",
  noFill: v.bg === "rgba(0, 0, 0, 0)" || v.bg === "transparent",
  noShadow: v.shadow === "none",
});

test("E15.85-1 the bot panel's × is a glyph: no border, no fill, no shadow, and Escape still closes it", async ({ chief, page }) => {
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "sidenav")).toBeVisible();
    if (!(await tid(page, "assistant-panel").isVisible().catch(() => false))) await tid(page, "nav-assistant").click();
    await expect(tid(page, "assistant-close")).toBeVisible();

    const close = await look(page, "assistant-close");
    expect(bare(close)).toEqual({ border: true, noFill: true, noShadow: true });
    expect(close.glyphs, "a drawn cross, not a ✕ character").toBe(1);
    expect(close.text, "no word beside it").toBe("");
    expect([close.w, close.h], "a 32 × 32 target").toEqual([32, 32]);
    // The name is kept where a screen reader and a hover both find it.
    await expect(tid(page, "assistant-close")).toHaveAttribute("aria-label", "Close chief bot");

    // Still a real control: it closes the panel, and so does Escape.
    await tid(page, "assistant-close").click();
    await expect(tid(page, "assistant-panel")).toHaveCount(0);
    await tid(page, "nav-assistant").click();
    await expect(tid(page, "assistant-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tid(page, "assistant-panel")).toHaveCount(0);
  } finally {
    await srv.stop();
  }
});

test("E15.88-1 the collapsed rail's server button is not clipped, and its chevron is a glyph", async ({ chief, page }) => {
  const srv = await chief.serve();
  try {
    // A laptop window, which is where the report came from: `compact` is 1024–1600 px, and there the blocks are the
    // 72 px rail with the server count at its foot.
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.goto(`${srv.url}/#/designer`);
    await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
    await expect(tid(page, "palette")).toHaveAttribute("data-full", "false");
    const rail = page.getByTestId("palette-servers");
    {
      // The count over a short caption, and nothing running out of the box: `whitespace-nowrap` was what cut
      // "14 MCP servers" mid-word.
      expect(await rail.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "nothing is clipped").toBe(true);
      await expect(tid(page, "palette-servers-count")).toBeVisible();
      await expect(rail).toContainText("MCP");
      expect((await look(page, "palette-servers")).text).not.toContain("servers");
    }

    // The collapse handle is a chevron, not a shaped button.
    const toggle = await look(page, "palette-toggle");
    expect(bare(toggle), "no box around a chevron").toEqual({ border: true, noFill: true, noShadow: true });
    expect(toggle.glyphs, "drawn, not the « character").toBe(1);
    expect(toggle.text).toBe("");
  } finally {
    await srv.stop();
  }
});

test("E15.91-1 the run panel's navigation is four glyphs and a word, none of them boxed", async ({ chief, page }) => {
  chief.importWorkflow("name: nav\nnodes:\n  - { id: a, type: gate, kind: approve, value: ok }\n");
  chief.run(["run", "nav"]);
  chief.run(["run", "nav"]);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1360, height: 900 });
    await gotoRuns(page, srv.url);
    await tid(page, "run-row-1").click();
    await expect(tid(page, "run-panel-close")).toBeVisible();

    for (const id of ["run-panel-prev", "run-panel-next", "run-panel-close"]) {
      const v = await look(page, id);
      expect(bare(v), `${id} has no box`).toEqual({ border: true, noFill: true, noShadow: true });
      expect(v.glyphs, `${id} is a drawn glyph`).toBe(1);
      expect([v.w, v.h], `${id} is a 32 × 32 target`).toEqual([32, 32]);
    }
    // "Open full page" is a ghost button: no border of its own even though it is a link.
    const full = await look(page, "run-panel-full");
    expect(bare(full)).toEqual({ border: true, noFill: true, noShadow: true });
    expect(full.text).toBe("Open full page");

    // The close glyph still closes the panel.
    await tid(page, "run-panel-close").click();
    await expect(tid(page, "run-panel-close")).toHaveCount(0);
  } finally {
    await srv.stop();
  }
});

test("E15.92-1 the MCP card on Settings is 20 px from the card above it, as every other card is", async ({ chief, page }) => {
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1360, height: 1000 });
    await page.goto(`${srv.url}/#/settings`);
    const card = page.getByTestId("settings-mcp");
    await expect(card).toBeVisible();
    // The gap above it, and the one below it: the card carried `mb-5` and nothing above, so two cards touched — the only
    // place on the page where they did.
    const gaps = await card.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { top: cs.marginTop, bottom: cs.marginBottom };
    });
    // 20 px above — the report was a 0 px gap, the only place on the page where two cards touched — and 20 px below,
    // which is what `mb-5` already gave it.
    expect(gaps.top).toBe("20px");
    expect(gaps.bottom).toBe("20px");
  } finally {
    await srv.stop();
  }
});

test("E15.94-1 Delete on a run is a bin, and the danger is in the confirmation", async ({ chief, page }) => {
  chief.importWorkflow(`name: binned\nnodes:\n  - { id: a, type: agent, prompt: 'A ${fake({ cost: 0.01 })}' }\n`);
  chief.run(["run", "binned"]);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(`${srv.url}/#/runs/1`);
    await expect(tid(page, "btn-delete-run")).toBeVisible();

    const bin = await look(page, "btn-delete-run");
    expect(bare(bin), "not a filled red bar").toEqual({ border: true, noFill: true, noShadow: true });
    expect(bin.glyphs).toBe(1);
    expect(bin.text).toBe("");
    expect([bin.w, bin.h]).toEqual([32, 32]);
    // Slate at rest — the red appears when the pointer is on it.
    const rest = await tid(page, "btn-delete-run").evaluate((el) => getComputedStyle(el).color);
    await tid(page, "btn-delete-run").hover();
    expect(await tid(page, "btn-delete-run").evaluate((el) => getComputedStyle(el).color)).not.toBe(rest);

    // The weight moved to the confirmation, which names the run and says it cannot be undone.
    await tid(page, "btn-delete-run").click();
    await expect(tid(page, "confirm-delete")).toContainText("Delete run #1?");
    await expect(tid(page, "confirm-delete")).toContainText("This cannot be undone.");
    await tid(page, "confirm-delete-keep").click();
    await expect(tid(page, "confirm-delete")).toHaveCount(0);
  } finally {
    await srv.stop();
  }
});

test("E15.96-1 every place that deletes one run uses the same bin, and none of them is a red bar", async ({ chief, page }) => {
  chief.importWorkflow(`name: many\nnodes:\n  - { id: a, type: agent, prompt: 'A ${fake({ cost: 0.01 })}' }\n`);
  chief.run(["run", "many"]);
  chief.run(["run", "many"]);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1360, height: 900 });
    await gotoRuns(page, srv.url);
    await expect(tid(page, "run-delete-1")).toBeVisible();

    // One per row, small, and the toolbar's for a selection — three of the same component, so they cannot drift.
    for (const id of ["run-delete-1", "run-delete-2"]) {
      const v = await look(page, id);
      expect(bare(v), `${id} is a bin, not a bar`).toEqual({ border: true, noFill: true, noShadow: true });
      expect(v.glyphs).toBe(1);
      expect(v.text).toBe("");
      expect(v.w, `${id} is the small size`).toBe(28);
    }
    const toolbar = await look(page, "runs-delete");
    expect(bare(toolbar)).toEqual({ border: true, noFill: true, noShadow: true });
    expect(toolbar.glyphs).toBe(1);
    await expect(tid(page, "runs-delete")).toBeDisabled();

    // It still deletes, with the confirmation carrying the weight.
    await tid(page, "run-delete-1").click();
    await expect(tid(page, "confirm-delete")).toContainText("Delete run #1?");
    await tid(page, "confirm-delete-yes").click();
    await expect(tid(page, "run-delete-1")).toHaveCount(0);
    expect((await srv.api("GET", "/api/runs")).body.length).toBe(1);
  } finally {
    await srv.stop();
  }
});

test("E15.97-1 the bot panel's header is three glyphs of one size, and the plus is named", async ({ chief, page }) => {
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "sidenav")).toBeVisible();
    if (!(await tid(page, "assistant-panel").isVisible().catch(() => false))) await tid(page, "nav-assistant").click();

    const header = ["assistant-history", "assistant-new", "assistant-close"];
    const sizes = new Set<string>();
    for (const id of header) {
      const v = await look(page, id);
      expect(bare(v), `${id} is a glyph`).toEqual({ border: true, noFill: true, noShadow: true });
      expect(v.glyphs, `${id} is drawn`).toBe(1);
      expect(v.text, `${id} shows no word`).toBe("");
      sizes.add(`${v.w}×${v.h}`);
    }
    expect([...sizes], "one size for all three").toEqual(["32×32"]);
    // The word that left the panel is in the accessible name, and the title says what it does with the old thread.
    await expect(tid(page, "assistant-new")).toHaveAttribute("aria-label", "New conversation");
  } finally {
    await srv.stop();
  }
});

test("E15.109-1 every delete in the designer is the bin: a step and a connection too", async ({ chief, page }) => {
  // Asked 2026-11-22: *"let's change all Delete buttons to the Bin icon button"*. The run list, a run's header, a
  // schedule and a workflow already had it (15.94-15.96); the last two filled red bars were the step panel's **Delete
  // node** and the connection panel's **Delete connection**.
  chief.importWorkflow("name: two\nnodes:\n  - { id: a, type: agent, prompt: 'x' }\n  - { id: b, type: agent, prompt: 'y' }\nedges: [a -> b]\n");
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.goto(`${srv.url}/#/designer/two`);
    await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
    if (!(await tid(page, "wf-settings").isVisible().catch(() => false))) await tid(page, "panel-toggle").click();

    // A step: the bin replaces the red bar, and it names the step it deletes.
    await tid(page, "flow-node-a").click();
    await expect(tid(page, "node-delete")).toBeVisible();
    const step = await look(page, "node-delete");
    expect(bare(step), "a glyph, not a filled red bar").toEqual({ border: true, noFill: true, noShadow: true });
    expect(step.glyphs).toBe(1);
    expect(step.text, "no word on it").toBe("");
    await expect(tid(page, "node-delete")).toHaveAttribute("aria-label", /Delete step a/);
    await expect(tid(page, "node-delete")).toHaveAttribute("title", /Delete step/);

    // A connection: the same control, beside the keyboard shortcut it does not replace.
    await page.locator(".react-flow__edge").first().dispatchEvent("click");
    await expect(tid(page, "edge-delete")).toBeVisible();
    const edge = await look(page, "edge-delete");
    expect(bare(edge), "a glyph here too").toEqual({ border: true, noFill: true, noShadow: true });
    expect(edge.glyphs).toBe(1);
    expect(edge.text).toBe("");
    await expect(tid(page, "edge-delete")).toHaveAttribute("aria-label", "Delete this connection");
    await expect(tid(page, "edge-panel")).toContainText("or press Backspace");

    // And it still deletes: the connection goes, and then the step.
    await tid(page, "edge-delete").click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await tid(page, "flow-node-a").click();
    await tid(page, "node-delete").click();
    await expect(tid(page, "flow-node-a")).toHaveCount(0);
  } finally {
    await srv.stop();
  }
});

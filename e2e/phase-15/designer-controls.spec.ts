import { expect, test } from "../helpers";
import type { Page } from "@playwright/test";

/**
 * Task 15.100: three controls in the designer that were louder than what they do.
 *
 * The workflow settings' danger block was a heading, an outlined **Archive**, a sentence beside it, a filled red
 * **Delete** and a second sentence — five pieces of furniture for two actions, one of them usually disabled. It is one
 * **Archive workflow** button and a bin now (asked 2026-11-22: *"let's simplify this, keep only 1 button `Archive
 * workflow`, that's it, no need to header and hint text"*). Deletion stayed in the UI — the user picked the bin over
 * dropping it — and says why it cannot be used in its own title instead of in a paragraph under it.
 *
 * The **"?" beside Agent CLI is gone: the label and the dropdown say it, and the precedence rule belongs in the guide
 * rather than in a bubble. (The draft notice this file first described — and its Discard — was removed outright in 15.108;
 * the case now asserts that it is absent while the restored working copy is still there.)
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

/** A step's box on the canvas, by its id. */
const flowNode = (page: Page, id: string) => page.getByTestId(`flow-node-${id}`);

/** The panel is closed on a wide window until it is asked for, and the workflow's actions live in it. */
async function openPanel(page: Page) {
  if (!(await tid(page, "wf-settings").isVisible().catch(() => false))) await tid(page, "panel-toggle").click();
  await expect(tid(page, "wf-settings")).toBeVisible();
}

test("E15.100-1 the danger block is one button and a bin, there is no draft notice, and Agent CLI has no \"?\"", async ({ chief, page }) => {
  chief.importWorkflow("name: never-ran\nnodes:\n  - { id: a, type: gate, kind: approve, value: ok }\n");
  chief.importWorkflow("name: used\nnodes:\n  - { id: a, type: gate, kind: approve, value: ok }\n");
  chief.run(["run", "used"]);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1360, height: 950 });
    await page.goto(`${srv.url}/#/designer/never-ran`);
    await openPanel(page);

    // One button and a bin. No heading, and no sentence beside either of them: the copy that used to explain the two
    // actions is gone with them.
    const danger = tid(page, "wf-danger");
    await expect(danger).toContainText("Archive workflow");
    await expect(danger).not.toContainText("When this workflow is finished");
    await expect(tid(page, "wf-archive-note")).toHaveCount(0);
    await expect(tid(page, "wf-delete-note")).toHaveCount(0);
    // The bin is the second control, and it is a glyph rather than a filled red bar: an icon with a name of its own.
    await expect(tid(page, "wf-delete")).toHaveAttribute("aria-label", /^Delete/);
    await expect(tid(page, "wf-delete")).toBeEnabled();
    await expect(danger.locator("button")).toHaveCount(2);

    // Where it can work, it opens the same confirmation as before.
    await tid(page, "wf-delete").click();
    await expect(tid(page, "delete-modal")).toBeVisible();
    await tid(page, "delete-no").click();
    await expect(tid(page, "delete-modal")).toHaveCount(0);
    expect((await srv.api("GET", "/api/workflows")).body.map((w: any) => w.name).sort()).toEqual(["never-ran", "used"]);

    // Where it cannot — a run is the record of what happened — it is disabled and its own title says why, which is where
    // the sentence beside the button went.
    await page.goto(`${srv.url}/#/designer/used`);
    await openPanel(page);
    await expect(tid(page, "wf-delete")).toBeDisabled();
    await expect(tid(page, "wf-delete")).toHaveAttribute("title", /1 run is kept in full/);
    await expect(tid(page, "wf-archive")).toHaveText("Archive workflow");

    // Agent CLI has no "?": the label and the dropdown say it. The fields whose label cannot explain them keep theirs,
    // which is what makes this one a deliberate exception rather than a tooltip audit.
    await expect(tid(page, "help-wf-agent")).toHaveCount(0);
    await expect(tid(page, "help-wf-base-dir")).toBeVisible();

    // The draft notice and its Discard are gone (removed 2026-11-22: "i just realized that this discard feature isn't
    // required, remove this"). What the notices were for is still there — a restored draft is on the canvas, the working
    // copy is still written — so this asserts the removal without losing that: a stored working copy is opened, and there is
    // no banner above it.
    await srv.api("PUT", `/api/drafts/${encodeURIComponent("designer:used")}`, {
      value: { definition: { name: "used", nodes: [{ id: "a", type: "gate", kind: "approve", value: "ok" }] }, baseDir: null },
    });
    await page.reload();
    await expect(tid(page, "flow-node-a")).toBeVisible();
    await expect(tid(page, "draft-notice")).toHaveCount(0);
    await expect(tid(page, "draft-discard")).toHaveCount(0);
  } finally {
    await srv.stop();
  }
});

test("E15.108-1 a restored draft is on the canvas with no notice, and the draft is still kept", async ({ chief, page }) => {
  // Task 15.108: the "your changes were restored" banner and its Discard are gone (asked 2026-11-22: *"i just realized that
  // this discard feature isn't required, remove this"*). The **draft is untouched** — it is still written as it is typed and
  // still comes back, which is the no-data-loss rule — so this case keeps the two things that must survive the removal.
  chief.importWorkflow("name: kept\nnodes:\n  - { id: a, type: agent, prompt: 'stored text' }\n");
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1360, height: 950 });
    // A working copy that differs from the stored workflow: what an unfinished edit looks like when the page is opened.
    await srv.api("PUT", `/api/drafts/${encodeURIComponent("designer:kept")}`, {
      value: { definition: { name: "kept", nodes: [{ id: "a", type: "agent", prompt: "" }] }, baseDir: null },
    });
    await page.goto(`${srv.url}/#/designer/kept`);
    await expect(tid(page, "flow-node-a")).toBeVisible();

    // The restored copy is on the canvas, and nothing announces it.
    await flowNode(page, "a").click();
    await expect(tid(page, "node-prompt")).toHaveValue("");
    await expect(tid(page, "draft-notice")).toHaveCount(0);
    await expect(tid(page, "draft-discard")).toHaveCount(0);

    // The draft is still being kept: the stored workflow is still its last valid version, and a reload brings the same
    // unfinished canvas back rather than the stored one.
    expect((await srv.api("GET", "/api/workflows/kept")).body.definition.nodes[0].prompt).toBe("stored text");
    await page.reload();
    await expect(tid(page, "flow-node-a")).toBeVisible();
    await flowNode(page, "a").click();
    await expect(tid(page, "node-prompt")).toHaveValue("");

    // Undoing the edit is the way back now, and it saves: no working copy is left behind, and nothing was thrown away.
    await tid(page, "node-prompt").fill("stored text");
    await expect(tid(page, "autosave-status")).toHaveAttribute("data-dirty", "false", { timeout: 15_000 });
    await expect.poll(async () => (await srv.api("GET", "/api/drafts")).body["designer:kept"]).toBeUndefined();
  } finally {
    await srv.stop();
  }
});

import type { Page } from "@playwright/test";
import { expect, fake, test } from "../helpers";

/**
 * Task 15.90: the run page offers the actions that apply, and only those.
 *
 * The row used to render all five — Pause, Resume, Run again, Cancel, Delete — and disable the four that did not
 * apply, so a cancelled run showed a strip of greyed-out controls and read as "these exist and you are not allowed".
 * The model, which the engine already enforced, is small enough to state:
 *
 *  - **Pause** while it is doing something.
 *  - **Resume** only when something a person can fix stopped it: paused on purpose, `interrupted` (the server went
 *    away), or `failed` (a connection, a quota, a bad model). **Never after a cancel** — a cancelled run is finished,
 *    and the way forward is a new run.
 *  - **Cancel** while it is going.
 *  - **Run again** and **Delete** once it is no longer progressing; Run again starts a *new* run and leaves this one.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

/** The action buttons on the page, by test id: what is drawn, not what is enabled. */
async function actions(page: Page): Promise<string[]> {
  return page.locator('[data-testid="run-actions"] button').evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-testid") ?? "?"));
}

test("E15.90-1 a stopped run offers only what applies, and a cancelled run cannot be resumed", async ({ chief, page }) => {
  chief.importWorkflow("name: gated\nnodes:\n  - { id: ask, type: gate, kind: approve, value: ship it }\n");
  chief.importWorkflow(`name: quick\nnodes:\n  - { id: a, type: agent, prompt: 'hello ${fake({ output: { ok: 1 } })}' }\n`);
  chief.importWorkflow(`name: broken\nnodes:\n  - { id: a, type: agent, prompt: 'go ${fake({ error: "connection refused" })}' }\n`);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });

    // A run waiting at a gate is going: Pause and Cancel, and nothing that ends it twice.
    const gated = await srv.api("POST", "/api/runs", { workflow: "gated" });
    const gatedId = gated.body.run.id;
    await page.goto(`${srv.url}/#/runs/${gatedId}`);
    await expect(tid(page, "run-status")).toHaveAttribute("data-status", "waiting_gate");
    expect(await actions(page)).toEqual(["btn-pause", "btn-cancel"]);

    // Cancel it: a cancelled run is finished, so the row is Run again and Delete — and **no Resume**, which is the
    // rule the person stated. Run again is a new run; this one stays cancelled.
    await tid(page, "btn-cancel").click();
    await expect(tid(page, "run-status")).toHaveAttribute("data-status", "cancelled");
    expect(await actions(page)).toEqual(["btn-rerun", "btn-delete-run"]);
    // The server agrees: a cancelled run cannot be resumed, however it is asked.
    const refused = await srv.api("POST", `/api/runs/${gatedId}/resume`);
    expect(refused.status, "resume on a cancelled run is refused").toBeGreaterThanOrEqual(400);
    expect(refused.body.error).toContain("cancelled");
    expect(refused.body.error).toContain("only paused, interrupted or failed");

    // Delete is a bin, not a filled red bar: in the header, the destructive action was the loudest thing on the page. The
    // weight belongs in the confirmation, which names the run and says it cannot be undone (asked 2026-11-22).
    //
    // Read at rest — a ghost button takes a tint while the pointer is on it, and Cancel was just clicked — and here rather
    // than after "Run again", which leaves this page for the new run.
    await page.mouse.move(700, 700);
    // And given the hover tint's own transition time to fade out: `transition-all` was still returning a partly-faded
    // background when it was read (first 0.458 alpha, then 0.175 — the same colour on its way to none).
    await page.waitForTimeout(400);
    const bin = await tid(page, "btn-delete-run").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderWidth, bg: cs.backgroundColor, glyph: !!el.querySelector("svg"), text: (el.textContent ?? "").trim(), label: el.getAttribute("aria-label") };
    });
    expect(bin.border).toBe("0px");
    expect(bin.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(bin.glyph, "a drawn bin, not the word Delete").toBe(true);
    expect(bin.text).toBe("");
    expect(bin.label, "and it still says what it does to a screen reader").toBe("Delete this run");
    await tid(page, "btn-delete-run").click();
    await expect(tid(page, "confirm-delete")).toContainText(`Delete run #${gatedId}?`);
    await expect(tid(page, "confirm-delete")).toContainText("cannot be undone");
    await tid(page, "confirm-delete-keep").click();

    // Run again does exactly what was said: a *new* run, and the cancelled one is untouched.
    await tid(page, "btn-rerun").click();
    await expect(page).toHaveURL(/#\/runs\/\d+$/);
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${gatedId}`)).body.run.status).toBe("cancelled");

    // Delete is a bin, not a filled red bar: in the header, the destructive action was the loudest thing on the page. The
    // weight belongs in the confirmation, which names the run and says it cannot be undone (asked 2026-11-22).
    // A completed run: also just Run again and Delete.
    const done = await srv.api("POST", "/api/runs", { workflow: "quick", inputs: {} });
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${done.body.run.id}`)).body.run.status, { timeout: 20_000 }).toBe("completed");
    await page.goto(`${srv.url}/#/runs/${done.body.run.id}`);
    await expect(tid(page, "run-status")).toHaveAttribute("data-status", "completed");
    expect(await actions(page)).toEqual(["btn-rerun", "btn-delete-run"]);

    // A failed run is the case Resume exists for — the person fixes the cause and continues this run — so it offers
    // Resume as well, and the run it continues is this one rather than a new one.
    const failed = await srv.api("POST", "/api/runs", { workflow: "broken", inputs: {} });
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${failed.body.run.id}`)).body.run.status, { timeout: 20_000 }).toBe("failed");
    await page.goto(`${srv.url}/#/runs/${failed.body.run.id}`);
    await expect(tid(page, "run-status")).toHaveAttribute("data-status", "failed");
    expect(await actions(page)).toEqual(["btn-resume", "btn-rerun", "btn-delete-run"]);
    // Which is what the server does: the same run moves again, it is not a second one.
    const resumed = await srv.api("POST", `/api/runs/${failed.body.run.id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.run.id).toBe(failed.body.run.id);
  } finally {
    await srv.stop();
  }
});

test("E15.90-2 a run in flight has no Resume, and a finished one has no Pause or Cancel", async ({ chief, page }) => {
  // The negative direction of the same rule, stated separately because it is what was reported: the row must not carry
  // a control that could never apply (asked 2026-11-22: "i think there should be only a Resume button, no?").
  chief.importWorkflow("name: gated\nnodes:\n  - { id: ask, type: gate, kind: approve, value: ship it }\n");
  const srv = await chief.serve();
  try {
    const run = await srv.api("POST", "/api/runs", { workflow: "gated" });
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.goto(`${srv.url}/#/runs/${run.body.run.id}`);
    await expect(tid(page, "run-status")).toHaveAttribute("data-status", "waiting_gate");
    for (const gone of ["btn-resume", "btn-rerun", "btn-delete-run"]) {
      await expect(tid(page, gone), `${gone} is not drawn while the run is going`).toHaveCount(0);
    }
    // The row says its own state, so a case (or a person reading the DOM) never has to infer it.
    await expect(tid(page, "run-actions")).toHaveAttribute("data-state", "waiting_gate");

    await tid(page, "btn-cancel").click();
    await expect(tid(page, "run-status")).toHaveAttribute("data-status", "cancelled");
    for (const gone of ["btn-pause", "btn-cancel", "btn-resume"]) {
      await expect(tid(page, gone), `${gone} is not drawn on a cancelled run`).toHaveCount(0);
    }
    await expect(tid(page, "run-actions")).toHaveAttribute("data-state", "cancelled");
  } finally {
    await srv.stop();
  }
});

test("E15.117-1 a run can be run again from a step onwards, keeping the earlier steps' results", async ({ chief, page }) => {
  // Asked 2026-11-23: *"a full rerun of a workflow run everytime is waste of token and time, can we have an option to run from
  // a certain step onwards only?"*. A chain of three agent steps, so "from two" has exactly one step before it and one after.
  chief.importWorkflow(`name: chain
nodes:
  - { id: one, type: agent, mcp: [], prompt: 'ONE ${fake({ output: { value: "from-one" } })}' }
  - { id: two, type: agent, mcp: [], prompt: 'TWO reads {{nodes.one.output.value}} ${fake({ output: { value: "from-two" } })}' }
  - { id: three, type: agent, mcp: [], prompt: 'THREE reads {{nodes.two.output.value}} ${fake({ output: { ok: 1 } })}' }
edges: [one -> two, two -> three]
`);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    const first = await srv.api("POST", "/api/runs", { workflow: "chain", inputs: {} });
    const id = first.body.run.id as number;
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run.status, { timeout: 30_000 }).toBe("completed");
    const callsBefore = chief.calls().length;

    // The button is unchanged, and a caret beside it offers where to start — never the first step, which is a full rerun.
    await page.goto(`${srv.url}/#/runs/${id}`);
    await expect(tid(page, "btn-rerun")).toHaveText("Run again — new run");
    await tid(page, "btn-rerun-menu").click();
    const menu = tid(page, "rerun-menu");
    await expect(menu).toContainText("keep the results they returned in this run");
    await expect(tid(page, "rerun-from-two")).toContainText("two");
    await expect(tid(page, "rerun-from-one"), "the first step is the button itself").toHaveCount(0);

    // From step two: a new run that runs two and three and takes one from the earlier run.
    // The new run's page, which is a different run: wait for the address to change, not for a URL that matches the page it
    // is already on (`/runs/1` matches the pattern too, so reading it immediately gave this run's own id).
    await tid(page, "rerun-from-two").click();
    await expect(page).not.toHaveURL(new RegExp(`/runs/${id}$`));
    await expect(page).toHaveURL(/\/runs\/\d+$/);
    const id2 = Number(page.url().split("/").pop());
    expect(id2).not.toBe(id);
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${id2}`)).body.run.status, { timeout: 30_000 }).toBe("completed");

    // What it ran, read from the record: two agent calls instead of three, and no attempt for `one`.
    const ran = chief.calls().slice(callsBefore);
    expect(ran.length, "two steps ran, not three").toBe(2);
    const detail = (await srv.api("GET", `/api/runs/${id2}`)).body;
    expect(detail.run.start_from).toBe("two");
    expect(detail.run.parent_run_id).toBe(id);
    expect(detail.node_runs.map((n: any) => n.node_id)).toEqual(["two", "three"]);
    // Its results are the earlier run's, so the step that ran second read what the first returned there.
    expect(JSON.stringify(detail.node_runs[0].io.input)).toContain("from-one");
    // And the record says where the kept results came from, on the step the run starts at.
    const transcript = (await srv.api("GET", `/api/runs/${id2}/transcript`)).body as any[];
    const note = transcript.find((m) => m.kind === "resumed_from");
    expect(note?.node_id).toBe("two");
    expect(note?.content).toContain(`run #${id}'s`);

    // The menu is gone when there is only one step to start at: a one-step workflow has no choice to offer.
    chief.importWorkflow(`name: solo\nnodes:\n  - { id: only, type: agent, prompt: 'S ${fake({ output: { ok: 1 } })}' }\n`);
    const solo = await srv.api("POST", "/api/runs", { workflow: "solo", inputs: {} });
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${solo.body.run.id}`)).body.run.status, { timeout: 30_000 }).toBe("completed");
    await page.goto(`${srv.url}/#/runs/${solo.body.run.id}`);
    await expect(tid(page, "btn-rerun")).toBeVisible();
    await expect(tid(page, "btn-rerun-menu"), "one step: nothing to choose").toHaveCount(0);

    // And the server refuses a start point that is not a step, so a stale menu cannot start something wrong.
    const bad = await srv.api("POST", `/api/runs/${id}/rerun`, { from: "nope" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("is not a step");
  } finally {
    await srv.stop();
  }
});

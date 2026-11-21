import type { Page } from "@playwright/test";
import { expect, fake, test } from "../helpers";

/**
 * Task 15.89: what a run's page says about a step's prompt and its JSON.
 *
 * Three things a person reading a run could not settle for themselves. **Where their prompt ended**: chief appends its own
 * text to every agent prompt (the result contract, the earlier steps' results, the MCP servers it may reach), and the run
 * page showed one undivided block, so the numbered output contract read as if the author had written it — "it looks like
 * appended by chief system itself, why is this needed?". It *is* appended, and now the page says where. **Read-only JSON
 * wearing an editor**: a recorded input had a line-number gutter, which is an editor's affordance on a block nobody can
 * type in. **Replay rows out of line**: `Button` centres its content, so the timestamp was pushed to the middle of the
 * column instead of starting at its edge.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

/** The run's page, with the step's details open. */
async function openStep(page: Page, url: string) {
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto(url);
  await expect(tid(page, "sidenav")).toBeVisible();
  await page.locator('[data-testid^="node-run-"]').first().click();
  await expect(tid(page, "node-input")).toBeVisible();
}

test("E15.89-1 the run page says where the step's prompt ends and chief's own text begins", async ({ chief, page }) => {
  chief.importWorkflow(`name: probe
nodes:
  - id: plan
    type: agent
    prompt: |
      Review the PR at https://example.test/7.

      DO NOT post any comments at this step
`);
  const srv = await chief.serve();
  try {
    const run = await srv.api("POST", "/api/runs", { workflow: "probe", inputs: {} });
    expect(run.status).toBe(201);
    const id = run.body.run.id;
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run?.status, { timeout: 20_000 }).toBe("completed");

    // The record knows the boundary, because the engine wrote it down rather than a page guessing from the text.
    const nr = (await srv.api("GET", `/api/runs/${id}`)).body.node_runs[0];
    expect(nr.io.input_kind).toBe("prompt");
    expect(nr.io.appended_at, "the author's prompt is 63 characters").toBeGreaterThan(0);
    expect(nr.io.input.slice(0, nr.io.appended_at)).toContain("DO NOT post any comments at this step");
    expect(nr.io.input.slice(nr.io.appended_at)).toContain("Output contract (required by the orchestrator running you)");

    await openStep(page, `${srv.url}/#/runs/${id}`);
    // The boundary is on the page, in words, between the two parts.
    const boundary = tid(page, "node-input-appended");
    await expect(boundary).toContainText("Appended by chief");
    const order = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="node-input"]')!;
      const mark = document.querySelector('[data-testid="node-input-appended"]')!;
      const authored = (box.textContent ?? "").indexOf("DO NOT post any comments");
      const contract = (box.textContent ?? "").indexOf("Output contract (required by the orchestrator");
      return { authored, contract, mark: [...box.querySelectorAll("*")].indexOf(mark) };
    });
    expect(order.authored, "the author's text comes first").toBeLessThan(order.contract);
    expect(order.mark).toBeGreaterThanOrEqual(0);

    // Nothing was hidden: the whole prompt is still there, because it is what the step was sent, and Copy copies it all.
    await expect(tid(page, "node-input")).toContainText("Output contract (required by the orchestrator running you)");
    await expect(tid(page, "node-input")).toContainText("Review the PR at https://example.test/7");
  } finally {
    await srv.stop();
  }
});

test("E15.89-2 read-only JSON is highlighted text, not an editor, and replay rows start at the left", async ({ chief, page }) => {
  chief.importWorkflow(`name: probe\ninputs:\n  reviewer:\n    prlink: https://example.test/pull/7\nnodes:\n  - { id: plan, type: agent, prompt: 'Review {{inputs.reviewer.prlink}} ${fake({ output: { ok: 1 } })}' }\n`);
  const srv = await chief.serve();
  try {
    const run = await srv.api("POST", "/api/runs", { workflow: "probe", inputs: { reviewer: { prlink: "https://example.test/pull/7" } } });
    const id = run.body.run.id;
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run?.status, { timeout: 20_000 }).toBe("completed");

    await openStep(page, `${srv.url}/#/runs/${id}`);
    // The inputs a run ran with: JSON, coloured, and with no numbered margin — that gutter is the editor's affordance and
    // these blocks cannot be typed in (asked 2026-11-22: "just the json syntax highlight will do").
    const code = tid(page, "run-inputs-json");
    // The inputs are a fold — they are context, not what a run page is for — so they are opened before being read.
    if (!(await code.isVisible())) await tid(page, "run-inputs").locator("summary").click();
    await expect(code).toBeVisible();
    const block = await code.evaluate((el) => {
      const box = el.closest("[data-json-code]")!;
      return {
        readOnly: box.getAttribute("data-read-only"),
        gutters: box.querySelectorAll('[aria-hidden="true"]').length,
        lineNumbers: [...box.querySelectorAll("*")].filter((e) => /^\d+$/.test((e.textContent ?? "").trim())).length,
        coloured: el.querySelectorAll("span").length,
        tag: el.tagName,
      };
    });
    expect(block.tag, "a pre, not a textarea").toBe("PRE");
    expect(block.readOnly).toBe("true");
    expect(block.gutters, "no line-number gutter on a read-only block").toBe(0);
    expect(block.lineNumbers, "and no bare numbers standing in for one").toBe(0);
    // Still a highlight, not plain text: the keys and strings are coloured spans.
    expect(block.coloured, "the JSON is highlighted").toBeGreaterThan(2);
    // Nothing to type into anywhere in these blocks.
    await expect(page.locator("[data-json-code] textarea")).toHaveCount(0);

    // The replay list's rows: the timestamp starts at the row's edge, not centred in it.
    const row = page.locator("[data-replay-row]").first();
    await expect(row, "the replay list is on the run page").toBeVisible();
    const geometry = await row.evaluate((el) => {
      const first = el.firstElementChild!;
      const r = el.getBoundingClientRect(), f = first.getBoundingClientRect();
      return { align: getComputedStyle(el).justifyContent, inset: Math.round(f.left - r.left), room: Math.round(r.right - f.right), text: (el.textContent ?? "").slice(0, 20) };
    });
    // The claim is geometry, not a keyword: engine versions compute `justify-content: flex-start` as `flex-start`,
    // `start` or `flow-start` on the same markup, so what is asserted is where the text actually sits.
    expect(["flex-start", "start", "flow-start", "normal"], `"${geometry.text}" is packed from its start (${geometry.align})`).toContain(geometry.align);
    expect(geometry.inset, "only the row's own padding").toBeLessThanOrEqual(12);
    expect(geometry.room, "the slack is on the right, not split either side").toBeGreaterThan(geometry.inset);
  } finally {
    await srv.stop();
  }
});

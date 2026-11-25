import type { Page } from "@playwright/test";
import { expect, fake, test as base, type Server, roomyLayout, openInputSetPanel } from "../helpers";

const test = base.extend<{ boot: (opts?: { env?: Record<string, string>; compact?: boolean }) => Promise<Server> }>({
  boot: async ({ chief }, use) => {
    const started: Server[] = [];
    // The designer starts with everything open (see roomyLayout), unless a case asks for the compact layout.
    await use(async (opts) => { const s = await chief.serve(opts); started.push(s); if (!opts?.compact) await roomyLayout(s); return s; });
    for (const s of started) await s.stop();
  },
});
const tid = (page: Page, id: string) => page.getByTestId(id);

test("E9.48-3 the Runs page and the designer ask for the inputs a workflow uses, and the run page shows them", async ({ chief, boot, page }) => {
  chief.importWorkflow(`
name: review
inputs: { repo: my-org/app }
nodes:
  - { id: review, type: agent, mcp: [], prompt: 'Review {{inputs.prlink}} in {{inputs.repo}} ${fake({ output: { ok: true } })}' }
`);
  chief.importWorkflow(`
name: plain
inputs: { who: team }
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'hello {{inputs.who}} ${fake({ output: { ok: true } })}' }
`);
  const srv = await boot();

  // Runs page: a field for the input that needs a value, and the default folded away under it (15.120).
  await page.goto(srv.url + "/#/runs");
  await openInputSetPanel(page);
  await tid(page, "input-set-workflow").selectOption("review");
  await expect(tid(page, "new-run-inputs-field-prlink")).toBeVisible();
  await expect(tid(page, "new-run-inputs-repo-input")).toHaveValue("my-org/app");
  await expect(tid(page, "new-run-inputs-from-workflow-repo")).toBeVisible();
  // Start run is disabled while the required-by-use input is empty, and says which field is missing.
  await expect(tid(page, "input-set-start")).toBeDisabled();
  await expect(tid(page, "input-set-start")).toHaveAttribute("title", /prlink/);
  await tid(page, "new-run-inputs-prlink-input").fill("https://x/pull/7");
  await tid(page, "input-set-start").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  // The run page reads back as the form that asked: the label, the value, and the JSON one click away.
  await expect(tid(page, "run-input-prlink")).toContainText("https://x/pull/7");
  await expect(tid(page, "run-input-repo")).toContainText("my-org/app");
  // Both disclosures are opened **by their own state**, not by what is visible: the outer one opens by itself when the
  // run came from a collection (15.122), and the inner one still starts shut — so "if not visible, click" closed the
  // outer instead of opening the inner (found 2026-11-25).
  const openIt = async (id: string, summary = true) => {
    const el = tid(page, id);
    if (!(await el.evaluate((n) => (n as HTMLDetailsElement).open))) await el.locator("summary").first().click({ force: !summary });
  };
  await openIt("run-inputs");
  await openIt("run-inputs-json-view");
  await expect(tid(page, "run-inputs-json")).toContainText('"prlink": "https://x/pull/7"');
  await expect(tid(page, "run-inputs-json")).toContainText('"repo": "my-org/app"');
  expect(chief.calls()[0].prompt).toContain("Review https://x/pull/7 in my-org/app");

  // Designer: Run starts at once with the workflow's inputs, no dialog. An input that has no value is refused, naming it,
  // and the Workflow tab is where it is set — now through a field, whose value is the default.
  await page.goto(srv.url + "/#/designer/review");
  await expect(tid(page, "flow-node-review")).toBeVisible();
  await tid(page, "btn-run").click();
  await expect(tid(page, "designer-error")).toContainText("inputs.prlink");
  await expect(tid(page, "start-run")).toHaveCount(0);
  await expect(tid(page, "tab-workflow")).toHaveAttribute("aria-selected", "true");
  // The two inputs it uses are declared first, then given their values.
  await tid(page, "wf-inputs-adopt").click();
  await expect(tid(page, "wf-input-field-0")).toBeVisible();
  await tid(page, "wf-field-value-0-input").fill("https://x/pull/8");
  await expect.poll(async () => (await srv.api("GET", "/api/workflows/review")).body.definition.inputs?.prlink).toBe("https://x/pull/8");
  await tid(page, "btn-run").click();
  await expect(page).toHaveURL(/#\/runs\/2$/);
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect(chief.calls()[1].prompt).toContain("Review https://x/pull/8 in my-org/app");

  // A value is changed in the Workflow tab before Run; the run uses it.
  await page.goto(srv.url + "/#/designer/plain");
  await expect(tid(page, "flow-node-a")).toBeVisible();
  await expect(tid(page, "btn-run-inputs")).toHaveCount(0);
  await tid(page, "wf-inputs-adopt").click();
  await tid(page, "wf-field-value-0-input").fill("everyone");
  await expect.poll(async () => (await srv.api("GET", "/api/workflows/plain")).body.definition.inputs).toEqual({ who: "everyone" });
  await tid(page, "btn-run").click();
  await expect(page).toHaveURL(/#\/runs\/3$/);
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect(chief.calls()[2].prompt).toContain("hello everyone");
});

test("E9.67-1 every JSON block is coloured the same way, whether it can be edited or not", async ({ chief, boot, page }) => {
  chief.importWorkflow(`name: demo\ninputs: { a: { who: everyone, n: 3, ok: true } }\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'Hi {{inputs.a.who}} ${fake({ output: { items: [1, 2], name: "x" } })}' }\n`);
  const srv = await boot();
  const id = (await srv.api("POST", "/api/runs", { workflow: "demo" })).body.run.id as number;
  await expect.poll(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run?.status).toBe("completed");

  // Read-only: the inputs the run ran with have the editor's frame and colours, are exactly the JSON as text, and carry no
  // line numbers — a numbered margin invites a click that does nothing (asked 2026-11-22).
  await page.goto(`${srv.url}/#/runs/${id}/full`);
  await page.getByText("Inputs this run ran with").click();
  // The JSON is one more disclosure below the form that now reads the inputs (15.121).
  await tid(page, "run-inputs-json-view").locator("summary").click();
  const block = tid(page, "run-inputs-json");
  await expect(block).toHaveText('{\n  "a": {\n    "who": "everyone",\n    "n": 3,\n    "ok": true\n  }\n}');
  for (const kind of ["key", "string", "number", "word"]) await expect(block.locator(`[data-json="${kind}"]`).first()).toBeVisible();
  await expect(page.locator("[data-json-code]").first()).not.toContainText(/^\s*1\s*$/m);
  const colour = (loc: ReturnType<Page["locator"]>) => loc.first().evaluate((el) => getComputedStyle(el).color);
  const readOnly = { key: await colour(block.locator('[data-json="key"]')), number: await colour(block.locator('[data-json="number"]')) };

  // Editable: the designer's workflow inputs use the same colours.
  await page.goto(`${srv.url}/#/designer/demo`);
  const editor = tid(page, "wf-inputs-code");
  await expect(editor.locator('[data-json="key"]').first()).toBeVisible();
  expect(await colour(editor.locator('[data-json="key"]'))).toBe(readOnly.key);
  expect(await colour(editor.locator('[data-json="number"]'))).toBe(readOnly.number);
});

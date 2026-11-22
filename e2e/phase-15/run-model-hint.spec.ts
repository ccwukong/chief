import { expect, fake, test } from "../helpers";
import type { Page } from "@playwright/test";

/**
 * Task 15.111: a step refused for its **model** says so, and one model can be set for every step that failed the
 * same way.
 *
 * Run #51 of `flight-weather-forecast` (2026-11-22) is what this is for. Every agent step was left on **"CLI
 * default"**, so chief passed no `-m` at all and the CLI used whatever model its own configuration names — which
 * needed an account token that endpoint does not accept. Every step failed with
 * *"Personal Access Tokens are not supported for this endpoint"*, the page said only *"This step failed"*, and
 * putting it right meant the same edit three times, once per step.
 *
 * So there are two halves here, and the case checks both: the failure names its cause (a model or account was
 * refused, not the work), and the model chosen for one step can be applied to **all** the steps that failed the same
 * way in one click — one request, all-or-nothing, so they cannot end up half changed.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

/** The exact error run #51 recorded, which the hint has to recognise. */
const REFUSED = "agent reported an error: Bad Request: checking third-party user token: bad request: Personal Access Tokens are not supported for this endpoint";

test("E15.111-1 a step refused for its model says so, and one model can be set for every step that failed the same way", async ({ chief, page }) => {
  // Run #51's shape exactly: the first failure stops the run, so the step after it never starts — and it would
  // fail the same way, because it has no model of its own either.
  chief.importWorkflow(`name: refused
nodes:
  - { id: first, type: agent, prompt: 'A ${fake({ error: REFUSED })}' }
  - { id: second, type: agent, prompt: 'B ${fake({ output: { ok: 2 } })}' }
edges: [first -> second]
`);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    const started = await srv.api("POST", "/api/runs", { workflow: "refused", inputs: {} });
    expect(started.status).toBe(201);
    const runId = started.body.run.id as number;
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${runId}`)).body.run.status, { timeout: 30_000 }).toBe("failed");
    await page.goto(`${srv.url}/#/runs/${runId}`);
    await expect(tid(page, "run-status")).toHaveAttribute("data-status", "failed");

    // The collapsed row names the cause instead of "This step failed": a person who reads it knows the setting at
    // fault without opening the details.
    const help = tid(page, "node-failed-help-1");
    await expect(help).toContainText("model or account was refused");
    await expect(help).toContainText("default model");
    // A different failure keeps the old wording: this must not claim every error is about the model.
    chief.importWorkflow(`name: plain\nnodes:\n  - { id: only, type: agent, prompt: 'X ${fake({ error: "the script printed nothing" })}' }\n`);
    const other = await srv.api("POST", "/api/runs", { workflow: "plain", inputs: {} });
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${other.body.run.id}`)).body.run.status, { timeout: 30_000 }).toBe("failed");
    await page.goto(`${srv.url}/#/runs/${other.body.run.id}`);
    const plainHelp = page.locator('[data-testid^="node-failed-help-"]').first();
    await expect(plainHelp).toContainText("This step failed.");
    await expect(plainHelp).not.toContainText("model or account was refused");

    // Back to the refused run: open the first step. The hint says which model it ran on and what to do.
    await page.goto(`${srv.url}/#/runs/${runId}`);
    await tid(page, "node-tab-first").click();
    // The row of the selected step, by testid prefix: `node-run-<attempt id>`.
    const row = page.locator('[data-testid^="node-run-"][data-node-id="first"]').first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(tid(page, "step-model-hint")).toContainText("refused by its model or account");
    await expect(tid(page, "step-model-hint")).toContainText("the CLI's default model");
    // Nothing to copy to yet: no model has been chosen for this step.
    await expect(tid(page, "step-model-others")).toHaveCount(0);

    // Choosing one here offers it for the steps that would inherit the same default — which is the fix that would
    // have saved the three rounds in run #51, where every step was left on "CLI default" one after another.
    await tid(page, "step-model-select").selectOption("sonnet");
    await expect(tid(page, "step-model-others")).toContainText("One more step of this run has no model");
    await expect(tid(page, "step-model-others")).toContainText("second");
    await expect(tid(page, "step-model-others-apply")).toContainText("sonnet");

    // One click sets both. Read back from the server, not from the page: the definition the run will resume with.
    await tid(page, "step-model-others-apply").click();
    await expect.poll(async () => {
      const d = (await srv.api("GET", `/api/runs/${runId}`)).body;
      return d.run.definition.nodes.map((n: any) => n.model ?? null);
    }, { timeout: 15_000 }).toEqual(["sonnet", "sonnet"]);
    // The block goes: no step of this run is left without a model.
    await expect(tid(page, "step-model-others")).toHaveCount(0);

    // What the three rounds in run #51 cost, stated as a check: not one agent step of this run is left without a
    // model, so the next Resume cannot fail for the same reason. (The resume itself is E15.90-1's subject; the
    // first step's prompt is a fake that always errors, so this run cannot complete.)
    const settled = (await srv.api("GET", `/api/runs/${runId}`)).body.run.definition.nodes.filter((n: any) => n.type === "agent");
    expect(settled.map((n: any) => n.model), "every agent step names a model now").toEqual(["sonnet", "sonnet"]);

    // The endpoint is all-or-nothing: a step that does not exist is refused and nothing moves.
    const bad = await srv.api("POST", `/api/runs/${runId}/steps/model`, { model: "opus", nodes: ["first", "nope"] });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.body.error).toContain("nope");
    const after = (await srv.api("GET", `/api/runs/${runId}`)).body;
    expect(after.run.definition.nodes.map((n: any) => n.model), "the good step was not changed either").toEqual(["sonnet", "sonnet"]);
  } finally {
    await srv.stop();
  }
});

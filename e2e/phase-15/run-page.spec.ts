import { expect, test } from "../helpers";
import type { Page } from "@playwright/test";

/**
 * Phase 15, task 15.23: the run page's action buttons follow the request, not the reload, and a run that
 * is being driven is still watched when the event stream says nothing.
 *
 * Reported 2026-11-20: Cancel kept its spinner for a long time while the run was already cancelled — the
 * panel showed `cancelled` as soon as it was closed and reopened. The cause was `act()` awaiting a refetch
 * of the run's whole record before releasing the button, and that record is read in full (every message,
 * including tool results) for the page. Two things were fixed: the refetch no longer blocks the button and
 * no longer reads the transcript, and a running run is polled slowly as well, so a stream that ends
 * without an event cannot leave the page saying "running" for ever.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);
const RULES = JSON.stringify([{ match: "slow-step", turns: [{ sleep_ms: 120_000, output: { ok: true } }] }]);

test("E15.23-1 Cancel releases its button at once, even when the record takes seconds to come back", async ({ chief, page }) => {
  const srv = await chief.serve({ env: { FAKE_CLAUDE_RULES: chief.file("rules.json", RULES) } });
  try {
    chief.importWorkflow("name: slow\nnodes:\n  - { id: a, type: agent, prompt: 'slow-step' }\n");
    const started = await srv.api("POST", "/api/runs", { workflow: "slow" });
    const id = started.body.run.id as number;
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run.status).toBe("running");

    await page.goto(`${srv.url}/#/runs/${id}`);
    await expect(tid(page, "btn-cancel")).toBeEnabled();

    // Every refetch of the record is slow: this is what a big run's record becomes, and it is the condition
    // that held the spinner before (the button waited for it). Installed after the first load, so the page
    // itself is not held up by it.
    await page.route("**/api/runs/*", async (route) => {
      if (route.request().method() === "GET" && /\/api\/runs\/\d+$/.test(route.request().url())) await new Promise((r) => setTimeout(r, 5000));
      await route.fallback();
    });

    const t0 = Date.now();
    await tid(page, "btn-cancel").click();
    // The server has the request almost at once; the button must not be the thing that is waiting.
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run.requested_action, { timeout: 5000 }).toBe("cancel");
    await expect.poll(async () => tid(page, "btn-cancel").evaluate((el) => el.getAttribute("aria-busy") === "true"), { timeout: 4000 }).toBe(false);
    expect(Date.now() - t0, "the button was released without the 5 s refetch").toBeLessThan(5000);

    // And the page gets to `cancelled` on its own: the slow refetch lands, or the safety-net poll asks.
    await expect(tid(page, "run-status")).toHaveText("cancelled", { timeout: 30_000 });
  } finally {
    await srv.stop();
  }
});

test("E15.23-2 with the event stream gone, the page still finds a run that was cancelled elsewhere", async ({ chief, page }) => {
  const srv = await chief.serve({ env: { FAKE_CLAUDE_RULES: chief.file("rules.json", RULES) } });
  try {
    chief.importWorkflow("name: slow\nnodes:\n  - { id: a, type: agent, prompt: 'slow-step' }\n");
    const started = await srv.api("POST", "/api/runs", { workflow: "slow" });
    const id = started.body.run.id as number;
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run.status).toBe("running");

    // No events at all: a proxy, a sleeping laptop or a server restart ends the stream, and then the only
    // thing that can notice a change is asking again. Before this task a running run had no polling, so the
    // page stayed on "running" for ever — which looked exactly like the cancel that never arrived.
    await page.route("**/api/runs/*/events*", (route) => route.abort());
    await page.goto(`${srv.url}/#/runs/${id}`);
    await expect(tid(page, "run-status")).toHaveText("running");

    // Cancelled from outside the page (the CLI, another tab, a second window).
    await srv.api("POST", `/api/runs/${id}/cancel`);
    // The safety-net poll is 10 s while the run is not stopped; it must find it well inside that.
    await expect(tid(page, "run-status")).toHaveText("cancelled", { timeout: 25_000 });
  } finally {
    await srv.stop();
  }
});

test("E15.23-3 the Cancel button says Cancelling… and cannot be pressed again while the request is in flight", async ({ chief, page }) => {
  const srv = await chief.serve();
  try {
    chief.importWorkflow("name: gated\nnodes:\n  - { id: g, type: gate, kind: approve, value: ship it }\n");
    const started = await srv.api("POST", "/api/runs", { workflow: "gated" });
    const id = started.body.run.id as number;
    await expect.poll(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run.status).toBe("waiting_gate");

    // The record says a cancel was asked for while the run is still going: the state the button has to
    // show. Written into the response rather than raced for, because the real window is milliseconds.
    await page.route("**/api/runs/*", async (route) => {
      if (route.request().method() !== "GET" || !/\/api\/runs\/\d+$/.test(route.request().url())) return route.fallback();
      const res = await route.fetch();
      const body = await res.json();
      body.run.status = "running";
      body.run.requested_action = "cancel";
      await route.fulfill({ response: res, json: body });
    });

    await page.goto(`${srv.url}/#/runs/${id}`);
    await expect(tid(page, "btn-cancel")).toHaveText("Cancelling…");
    await expect(tid(page, "btn-cancel")).toBeDisabled();
  } finally {
    await srv.stop();
  }
});

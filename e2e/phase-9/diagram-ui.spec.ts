import type { Page } from "@playwright/test";
import { showStep, expect, fake, test as base, type Server, roomyLayout } from "../helpers";

const test = base.extend<{ boot: (opts?: { env?: Record<string, string>; compact?: boolean }) => Promise<Server> }>({
  boot: async ({ chief }, use) => {
    const started: Server[] = [];
    // The designer starts with everything open (see roomyLayout), unless a case asks for the compact layout.
    await use(async (opts) => { const s = await chief.serve(opts); started.push(s); if (!opts?.compact) await roomyLayout(s); return s; });
    for (const s of started) await s.stop();
  },
});
const tid = (page: Page, id: string) => page.getByTestId(id);
const edge = (page: Page, from: string, to: string) => page.locator(`.react-flow__edge[data-id="${from}-${to}"]`);

test("E9.49-1 the run page shows the run on the workflow's diagram, following every step live", async ({ chief, boot, page }) => {
  chief.importWorkflow(`
name: live
nodes:
  - { id: plan, type: agent, mcp: [], prompt: 'plan ${fake({ output: { items: ["a", "b"] } })}' }
  - { id: slow, type: agent, mcp: [], prompt: 'slow ${fake({ sleep_ms: 6000, output: { ok: true } })}' }
  - { id: check, type: gate, kind: approve, message: "Go on?", value: go }
  - { id: each, type: map, over: "{{nodes.plan.output.items}}", node: { type: agent, mcp: [], prompt: 'do {{item}} ${fake({ output: { done: true } })}' } }
edges: [plan -> slow, slow -> check, check -> each]
`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "live" });
  await page.goto(srv.url + "/#/runs/1");

  // While the slow step works: the first step is done, the slow one is in progress with the arrow into it moving, the rest not reached.
  const diagram = tid(page, "run-diagram");
  await expect(diagram).toBeVisible();
  await expect(tid(page, "diagram-node-slow")).toHaveAttribute("data-status", "running");
  await expect(tid(page, "diagram-node-plan")).toHaveAttribute("data-status", "completed");
  await expect(tid(page, "diagram-status-slow")).toContainText("in progress");
  await expect(tid(page, "diagram-node-slow")).toHaveClass(/diagram-running/);
  await expect(edge(page, "plan", "slow")).toHaveClass(/animated/);
  await expect(edge(page, "slow", "check")).not.toHaveClass(/animated/);
  await expect(tid(page, "diagram-node-check")).toHaveAttribute("data-status", "pending");
  await expect(tid(page, "diagram-node-each")).toHaveAttribute("data-status", "pending");
  await expect(tid(page, "diagram-legend")).toContainText("in progress");

  // The gate: marked as waiting for an answer; the arrow into it moves now.
  await expect(tid(page, "diagram-node-check")).toHaveAttribute("data-status", "waiting_gate", { timeout: 20_000 });
  await expect(tid(page, "diagram-node-slow")).toHaveAttribute("data-status", "completed");
  await expect(edge(page, "slow", "check")).toHaveClass(/animated/);
  await expect(edge(page, "plan", "slow")).not.toHaveClass(/animated/);

  // Clicking a step of the diagram opens its row; a step not reached opens its entry under "Not started yet".
  await tid(page, "diagram-node-plan").click();
  await expect(tid(page, "node-details")).toHaveAttribute("data-for", "plan");
  await tid(page, "diagram-node-check").click();
  await expect(tid(page, "node-details")).toHaveAttribute("data-for", "check");
  await tid(page, "diagram-node-each").click();
  await expect(tid(page, "pending-step-each").locator("button").first()).toHaveAttribute("aria-expanded", "true");

  // After the answer the map reports its items and every step ends green. The card is inside the gate's own tab, and
  // opening the not-started entry above left the view there.
  await showStep(page, "check");
  await tid(page, "gate-approve").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  await expect(tid(page, "diagram-progress-each")).toContainText("2 of 2 items done");
  for (const id of ["plan", "slow", "check", "each"]) await expect(tid(page, `diagram-node-${id}`)).toHaveAttribute("data-status", "completed");
  await expect(edge(page, "check", "each")).not.toHaveClass(/animated/);
});

test("E9.49-2 a failed step is red on the diagram and turns green after a resume", async ({ chief, boot, page }) => {
  chief.importWorkflow(`
name: fallible
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { ok: 1 } })}' }
  - { id: b, type: agent, mcp: [], prompt: 'B ${fake({ by_start: [{ error: "context window exceeded" }, { error: "context window exceeded" }, { sleep_ms: 4000, output: { ok: 2 } }] })}' }
  - { id: c, type: agent, mcp: [], prompt: 'C ${fake({ output: { ok: 3 } })}' }
edges: [a -> b, b -> c]
`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "fallible" });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("failed");
  await expect(tid(page, "diagram-node-b")).toHaveAttribute("data-status", "failed");
  await expect(tid(page, "diagram-status-b")).toContainText("failed");
  await expect(tid(page, "diagram-node-c")).toHaveAttribute("data-status", "pending");
  await expect(tid(page, "diagram-node-a")).toHaveAttribute("data-status", "completed");

  // Change its model from the row the diagram opens, resume: in progress (try 2), then green.
  await tid(page, "diagram-node-b").click();
  await expect(tid(page, "node-details")).toHaveAttribute("data-for", "b");
  await tid(page, "step-model-select").selectOption("opus");
  await expect(tid(page, "step-edit-status")).toHaveAttribute("data-state", "saved");
  await tid(page, "btn-resume").click();
  await expect(tid(page, "diagram-node-b")).toHaveAttribute("data-status", "running");
  await expect(tid(page, "diagram-status-b")).toContainText("try 2");
  await expect(tid(page, "run-status")).toHaveText("completed", { timeout: 20_000 });
  for (const id of ["a", "b", "c"]) await expect(tid(page, `diagram-node-${id}`)).toHaveAttribute("data-status", "completed");
  await expect(tid(page, "btn-revert")).toHaveCount(0);
});

test("E9.57-1 the run diagram keeps the wheel for the page, and a step still opens on click", async ({ chief, boot, page }) => {
  // This case used to assert that the diagram "cannot be dragged, scrolled or zoomed away". That was the
  // design until 2026-11-21, when it was reported as the bug: a workflow wider than the box could not be
  // read, and there was no way back after panning. It now pans and zooms (E15.48-1), so what is left here
  // is the part that is still a rule — the wheel belongs to the page this diagram sits in, so scrolling
  // over it moves the page rather than being trapped in a 288 px band.
  chief.importWorkflow(`
name: still
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { ok: 1 } })}' }
  - { id: b, type: agent, mcp: [], prompt: 'B ${fake({ output: { ok: 2 } })}' }
edges: [a -> b]
`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "still" });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("completed");
  const node = tid(page, "diagram-node-a"), canvas = tid(page, "run-diagram-canvas");
  // The wheel over the diagram scrolls the page instead of being swallowed by the canvas. The resize comes
  // first and the canvas is brought back into view after it: resizing a page that was scrolled moves the
  // diagram off screen, and a wheel at a point outside the window goes nowhere (this case failed that way).
  await page.setViewportSize({ width: 1100, height: 400 });
  await canvas.scrollIntoViewIfNeeded();
  const c = (await canvas.boundingBox())!;
  expect(c.y, "the diagram is on screen to scroll over").toBeGreaterThanOrEqual(0);
  expect(c.y + 20, "the point is inside the window").toBeLessThan(400);
  await page.mouse.move(c.x + 20, c.y + 20);
  const y0 = (await canvas.boundingBox())!.y;
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await canvas.boundingBox())!.y).toBeLessThan(y0);
  // A step can still be clicked to open its row, which is what the diagram is for.
  await node.click();
  await expect(tid(page, "node-details")).toHaveAttribute("data-for", "a");
});

test("E15.48-1 the run's diagram can be moved and zoomed, has a way back, and a way into the designer", async ({ chief, boot, page }) => {
  chief.importWorkflow(`name: viewable
nodes:
  - { id: first, type: agent, mcp: [], prompt: 'one ${fake({ output: { ok: 1 } })}' }
  - { id: second, type: agent, mcp: [], prompt: 'two ${fake({ output: { ok: 2 } })}' }
edges: [first -> second]
`);
  const srv = await boot();
  await page.setViewportSize({ width: 1280, height: 900 });
  await srv.api("POST", "/api/runs", { workflow: "viewable" });
  await page.goto(srv.url + "/#/runs/1");
  const node = tid(page, "diagram-node-first");
  await expect(node).toBeVisible();
  // It sits below the run's header and gates: a mouse drag needs it on screen, not merely in the document.
  await tid(page, "run-diagram-canvas").scrollIntoViewIfNeeded();

  // The pane's own transform: what "moved" and "zoomed" mean, without trusting a control's label.
  const viewport = tid(page, "run-diagram-canvas").locator(".react-flow__viewport");
  const transform = () => viewport.evaluate((el) => getComputedStyle(el).transform);
  const shown = async () => {
    const box = (await node.boundingBox())!, pane = (await tid(page, "run-diagram-canvas").boundingBox())!;
    return box.x >= pane.x - 1 && box.x + box.width <= pane.x + pane.width + 1 && box.y >= pane.y - 1 && box.y + box.height <= pane.y + pane.height + 1;
  };
  // It opens fitted: the whole workflow is in the box.
  expect(await shown(), "the workflow is fitted when the diagram opens").toBe(true);
  const opened = await transform();

  // Dragging the background moves it (reported 2026-11-21: "a user still can't move around the canvas").
  // The drag must start on an empty spot: a step is not draggable, so starting on one would move nothing —
  // and that is the mistake this case made first.
  const pane = (await tid(page, "run-diagram-canvas").boundingBox())!;
  const steps = await page.locator(".react-flow__node").evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }));
  const empty = [[0.5, 0.05], [0.05, 0.95], [0.95, 0.05], [0.5, 0.95], [0.05, 0.05]]
    .map(([fx, fy]) => ({ x: pane.x + pane.width * fx, y: pane.y + pane.height * fy }))
    .find((p) => !steps.some((b) => p.x >= b.x - 8 && p.x <= b.x + b.w + 8 && p.y >= b.y - 8 && p.y <= b.y + b.h + 8));
  expect(empty, "the diagram has an empty spot to drag from").toBeTruthy();
  await page.mouse.move(empty!.x, empty!.y);
  await page.mouse.down();
  await page.mouse.move(empty!.x - 70, empty!.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(transform).not.toBe(opened);
  const panned = await transform();

  // A view the person chose is not re-fitted under their hands when the box changes size or the run updates.
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForTimeout(600);
  expect(await transform(), "the chosen view survives a resize").toBe(panned);

  // The way back: one labelled control, and the whole workflow is in the box again.
  const fit = tid(page, "diagram-fit");
  await expect(fit).toHaveAttribute("aria-label", "Fit the whole workflow in the diagram");
  await fit.click();
  await expect.poll(shown).toBe(true);
  // Polled: the view is animated into place, so a single read can catch the frame before it moves.
  await expect.poll(transform, { message: "the fit control moves the view back" }).not.toBe(panned);

  // Zooming: the library's zoom-in control changes the scale, and double-click on the background does too.
  const scale = async () => Number(/matrix\(([^)]+)\)/.exec(await transform())![1].split(",")[0]);
  const before = await scale();
  await tid(page, "run-diagram-canvas").locator(".react-flow__controls-zoomin").click();
  await expect.poll(scale).toBeGreaterThan(before);

  // A step is still clickable while the pane is draggable: it opens, and no drag was started.
  await tid(page, "diagram-node-first").click();
  await expect(tid(page, "node-details")).toHaveAttribute("data-for", "first");

  // And the way into the designer: the workflow as it is now, not this run's frozen version.
  const edit = tid(page, "diagram-edit");
  await expect(edit).toHaveAttribute("href", "#/designer/viewable");
  await expect(edit).toHaveAttribute("title", /keeps the version it started with/);
  await edit.click();
  await expect(tid(page, "wf-picker")).toHaveValue("viewable");
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
});


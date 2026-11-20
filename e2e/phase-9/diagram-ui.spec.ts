import type { Page } from "@playwright/test";
import { expect, fake, test as base, type Server, roomyLayout } from "../helpers";

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

  // After the answer the map reports its items and every step ends green.
  await tid(page, "gate-approve").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  await expect(tid(page, "diagram-progress-each")).toContainText("2 of 2 items done");
  for (const id of ["plan", "slow", "check", "each"]) await expect(tid(page, `diagram-node-${id}`)).toHaveAttribute("data-status", "completed");
  await expect(edge(page, "check", "each")).not.toHaveClass(/animated/);
});

test("E9.49-2 a failed step is red on the diagram, turns green after a resume, and a compensated step is marked reverted", async ({ chief, boot, page }) => {
  chief.importWorkflow(`
name: fallible
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { ok: 1 } })}', compensate: { prompt: 'undo A ${fake({ output: { undone: true } })}' } }
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

  // Revert: the step with a compensation is marked reverted.
  await tid(page, "btn-revert").click();
  await expect(tid(page, "run-status")).toHaveText("reverted");
  await expect(tid(page, "diagram-node-a")).toHaveAttribute("data-status", "reverted");
  await expect(tid(page, "diagram-status-a")).toContainText("reverted");
});

test("E9.57-1 the run diagram cannot be dragged, scrolled or zoomed away, and the page scrolls over it", async ({ chief, boot, page }) => {
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
  const at = async () => { const b = (await node.boundingBox())!, c = (await canvas.boundingBox())!; return { x: Math.round(b.x - c.x), y: Math.round(b.y - c.y), w: Math.round(b.width) }; };
  const before = await at();
  const c = (await canvas.boundingBox())!;
  // Dragging the background, the wheel and a double-click leave the diagram where it is, at the same size.
  await page.mouse.move(c.x + 20, c.y + 20);
  await page.mouse.down();
  await page.mouse.move(c.x + 220, c.y + 120, { steps: 8 });
  await page.mouse.up();
  await page.mouse.wheel(0, 300);
  await page.mouse.dblclick(c.x + 20, c.y + 20);
  expect(await at()).toEqual(before);
  // The wheel over the diagram scrolls the page instead.
  await page.setViewportSize({ width: 1100, height: 400 });
  await page.mouse.move(c.x + 20, c.y + 20);
  const y0 = (await canvas.boundingBox())!.y;
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await canvas.boundingBox())!.y).toBeLessThan(y0);
  // A step can still be clicked to open its row.
  await node.click();
  await expect(tid(page, "node-details")).toHaveAttribute("data-for", "a");
});

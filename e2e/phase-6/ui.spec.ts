import type { Page } from "@playwright/test";
import { expect, fake, test as base, type Server, roomyLayout } from "../helpers";

/** `chief` plus a real `chief serve` that is stopped after the test. */
const test = base.extend<{ boot: (opts?: { env?: Record<string, string>; compact?: boolean }) => Promise<Server> }>({
  boot: async ({ chief }, use) => {
    const started: Server[] = [];
    // The designer starts with everything open (see roomyLayout), unless a case asks for the compact layout.
    await use(async (opts) => { const s = await chief.serve(opts); started.push(s); if (!opts?.compact) await roomyLayout(s); return s; });
    for (const s of started) await s.stop();
  },
});

const ITEMS = [
  { title: "Review PR 12", kind: "code-review", priority: "P1", url: "https://example.test/pr/12" },
  { title: "Write ADR", kind: "doc", priority: "P2", url: "https://example.test/adr" },
  { title: "Fix prod alert", kind: "other", priority: "P0", url: "https://example.test/alert" },
];
const tid = (page: Page, id: string) => page.getByTestId(id);
/** The designer's side panel has two tabs: the workflow's settings, and the selected step. */
const wfTab = (page: Page) => tid(page, "tab-workflow").click();
const stepTab = (page: Page) => tid(page, "tab-step").click();
const nodeOf = (d: any, id: string) => d.node_runs.filter((n: any) => n.node_id === id && n.phase === "forward").at(-1);
const flowNode = (page: Page, id: string) => page.locator(`.react-flow__node:has([data-testid="flow-node-${id}"])`);

/** Drag a palette entry onto the canvas at a position relative to the canvas. */
async function dropFromPalette(page: Page, palette: string, x: number, y: number) {
  // The MCP servers arrive a moment after the page; until then the entries below them still move.
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  // A real mouse drag can miss when several windows are open; it is repeated only if no node appeared.
  const nodes = page.locator(".react-flow__node");
  const before = await nodes.count();
  for (let attempt = 0; attempt < 3; attempt++) {
    await tid(page, palette).dragTo(tid(page, "canvas"), { targetPosition: { x, y } });
    try { await expect(nodes).toHaveCount(before + 1, { timeout: 1500 }); return; } catch { /* try again */ }
  }
  await expect(nodes).toHaveCount(before + 1);
}

/** Drop an Agent block and restrict it to one MCP server in its panel (servers themselves are not draggable). The node is named after the server. */
async function dropAgentWith(page: Page, server: string, x: number, y: number) {
  await dropFromPalette(page, "palette-agent", x, y);
  await tid(page, "node-id").fill(server);
  // A new agent node may use all connected servers; restrict it to this one.
  await tid(page, "node-mcp-all").uncheck();
  await tid(page, `node-mcp-${server}`).check();
}

/** Draw an edge from one node's bottom handle to another node's top handle. */
async function connect(page: Page, from: string, to: string) {
  const a = await flowNode(page, from).locator(".react-flow__handle-bottom").boundingBox();
  const b = await flowNode(page, to).locator(".react-flow__handle-top").boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** There is no Save button. Wait until the designer reports that the canvas is stored as the workflow. */
async function saved(page: Page, name: string, version?: number) {
  const st = tid(page, "autosave-status");
  await expect(st).toHaveAttribute("data-dirty", "false", { timeout: 15_000 });
  await expect(st).toHaveAttribute("data-state", "saved");
  await expect(st).toContainText(version ? `${name} v${version}` : name);
}
/** Wait until the designer has tried to save and found the canvas is not a valid workflow yet. */
const blocked = (page: Page) => expect(tid(page, "autosave-status")).toHaveAttribute("data-state", "blocked", { timeout: 15_000 });

async function startRun(srv: Server, workflow: string, inputs: object = {}) {
  const r = await srv.api("POST", "/api/runs", { workflow, inputs });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.run.id as number;
}
const detail = async (srv: Server, id: number) => (await srv.api("GET", `/api/runs/${id}`)).body;

test("E6.1-7 the built web app is served at /", async ({ boot, page }) => {
  const srv = await boot();
  const res = await page.goto(srv.url + "/");
  expect(res!.status()).toBe(200);
  expect(res!.headers()["content-type"]).toContain("text/html");
  await expect(page).toHaveTitle("chief");
  await expect(tid(page, "brand")).toHaveText("chief");
  await expect(tid(page, "page-runs")).toBeVisible();
  // Assets are served, and unknown paths fall back to the app (API paths do not).
  const script = await page.locator('script[type="module"]').getAttribute("src");
  const asset = await page.request.get(srv.url + script);
  expect(asset.status()).toBe(200);
  expect(asset.headers()["content-type"]).toContain("javascript");
  await page.goto(srv.url + "/some/deep/link");
  await expect(tid(page, "brand")).toBeVisible();
  expect((await page.request.get(srv.url + "/api/nope")).status()).toBe(404);
});

test("E6.2-1 the app shell navigates between pages without console errors", async ({ boot, page }) => {
  const srv = await boot();
  const problems: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.goto(srv.url + "/");
  for (const p of ["designer", "settings", "runs"]) {
    await tid(page, `nav-${p}`).click();
    await expect(tid(page, `page-${p}`)).toBeVisible();
    await expect(tid(page, `nav-${p}`)).toHaveAttribute("aria-current", "page");
    expect(page.url()).toContain(`#/${p}`);
  }
  await expect(tid(page, "canvas")).toBeHidden();
  await tid(page, "nav-designer").click();
  await expect(tid(page, "canvas")).toBeVisible();
  await expect(tid(page, "gates-badge")).toHaveText("0 gates waiting");
  await page.waitForTimeout(300);
  expect(problems).toEqual([]);
});

test("E6.3-1 the runs page lists runs with status and opens one", async ({ chief, boot, page }) => {
  chief.importWorkflow(`name: quick\nnodes:\n  - { id: a, type: agent, prompt: 'A ${fake({ cost: 0.25 })}' }\n`);
  chief.importWorkflow("name: gated\nnodes:\n  - { id: g, type: gate, kind: approve, value: ship it }\n");
  chief.run(["run", "quick"]);
  chief.run(["run", "gated"]);
  const srv = await boot();
  await page.goto(srv.url + "/#/runs");
  await expect(tid(page, "run-row-1")).toContainText("quick");
  await expect(tid(page, "run-row-1")).toContainText("completed");
  await expect(tid(page, "run-row-2")).toContainText("gated");
  await expect(tid(page, "run-row-2")).toContainText("waiting gate");
  // The dollar figure is hidden while its usefulness is decided (task 15.24): no Cost column, and no
  // money in a row. The Tokens column (task 15.33) is new, so the table has six columns with cost
  // hidden; what the list is for is still the status, and the tokens are labelled by their header.
  await expect(page.getByTestId("runs-table").locator("thead th")).toHaveCount(6);
  await expect(page.getByTestId("runs-table").locator("thead")).toContainText("Tokens");
  await expect(page.getByTestId("runs-table")).not.toContainText("Cost");
  await expect(page.getByTestId("runs-table")).not.toContainText("$");
  await expect(tid(page, "gates-badge")).toHaveText("1 gate waiting");
  await tid(page, "run-row-1").click();
  await expect(tid(page, "run-title")).toHaveText("Run #1 · quick v1");
  await expect(tid(page, "run-status")).toHaveText("completed");
});

test("E6.3-2 run detail updates live and shows node output and usage", async ({ chief, boot, page }) => {
  chief.importWorkflow(`
name: live
inputs: { who: nobody }
nodes:
  - { id: first, type: agent, prompt: 'A for {{inputs.who}} ${fake({ sleep_ms: 1500, cost: 0.12, tokens: { in: 1000, out: 200 }, output: { answer: 42 } })}' }
  - { id: second, type: agent, prompt: 'B ${fake({ sleep_ms: 800, cost: 0.03 })}' }
edges: [first -> second]
`);
  const srv = await boot();
  await page.goto(srv.url + "/#/runs");
  await tid(page, "new-run-workflow").selectOption("live");
  await tid(page, "new-run-inputs").fill('{"who": "ana"}');
  await tid(page, "new-run-start").click();
  await expect(tid(page, "run-title")).toContainText("Run #1 · live");
  await page.evaluate(() => { (window as any).__notReloaded = true; });

  // The steps became tabs (15.93): `data-node-id` is now on both the tab that selects a step and the row that shows it,
  // and only the selected tab's row is mounted. So the **status** is read from the tab, which is always there and carries
  // it, and a row's content is read after its tab is selected.
  const tab = (id: string) => tid(page, `node-tab-${id}`);
  await expect(tab("first")).toHaveAttribute("data-status", "running");
  await expect(tid(page, "run-status")).toHaveText("running");
  await expect(tab("first")).toHaveAttribute("data-status", "completed");
  await expect(tab("second")).toHaveAttribute("data-status", "running");
  await expect(tid(page, "run-status")).toHaveText("completed");
  await expect(tab("second")).toHaveAttribute("data-status", "completed");
  expect(await page.evaluate(() => (window as any).__notReloaded)).toBe(true);

  await tab("first").click();
  const first = page.locator('[data-node-id="first"][data-item]');
  await expect(first).toContainText("1000 in · 200 out");
  // No dollars on the step or in the run's totals while cost is hidden (task 15.24); the token counts,
  // which is what the number was standing in for, are still there and now say what they are (15.33).
  await expect(first).not.toContainText("$");
  await expect(first).toContainText("prompt ~");
  await expect(tid(page, "run-totals")).toHaveText("1,100 tokens in · 220 tokens out");
  await expect(tid(page, "run-totals")).not.toContainText("$");
  await first.click();
  await tid(page, "node-output-json").click();
  await expect(tid(page, "node-output")).toContainText('"answer": 42');
  // The run's events are in the replay like everything else the run did (task 15.99): there is one record, and the
  // separate event-log panel that repeated it is gone. `run_completed` is chief's own entry, so it has no `content` and
  // the row says what it reported instead of "(no content)".
  const completed = page.locator('[data-testid^="replay-row-"][data-kind="run_completed"]');
  await expect(completed).toHaveCount(1);
  expect(chief.calls()[0].prompt).toContain("A for ana");
});

test("E6.3-3 pause, resume, cancel and revert work from the run detail", async ({ chief, boot, page }) => {
  const effect = (ref: string) => ({ kind: "doc", ref, url: `https://example.test/${ref}`, how_to_undo: `delete ${ref}` });
  chief.importWorkflow(`
name: ctl
nodes:
  - { id: writer, type: agent, prompt: 'W ${fake({ output: { side_effects: [effect("d1")] } })}' }
  - id: slow
    type: agent
    prompt: 'S ${fake({ sleep_ms: 60000 }, { output: { side_effects: [effect("t1")] } })}'
    compensate: { prompt: 'UNDO ${fake({ output: { reverted: ["t1"], failed: [] } })}' }
edges: [writer -> slow]
`);
  const srv = await boot();
  const id = await startRun(srv, "ctl");
  await page.goto(`${srv.url}/#/runs/${id}`);
  const slow = page.locator('[data-node-id="slow"][data-phase="forward"]');
  await expect(slow).toHaveAttribute("data-status", "running");
  // While it runs there is nothing to resume, so Resume is not drawn at all — not a greyed-out button (task 15.90).
  await expect(tid(page, "btn-resume")).toHaveCount(0);
  await expect(tid(page, "btn-pause")).toBeEnabled();
  await expect(tid(page, "btn-cancel")).toBeEnabled();

  await tid(page, "btn-pause").click();
  await expect(tid(page, "run-status")).toHaveText("paused");
  await expect(slow).toHaveAttribute("data-status", "interrupted");
  // And once it is paused there is nothing to pause: the row offers Resume and Cancel.
  await expect(tid(page, "btn-pause")).toHaveCount(0);
  await expect(tid(page, "btn-resume")).toBeEnabled();

  await tid(page, "btn-resume").click();
  // This waits for the engine to finish a resumed agent turn — spawn the CLI, collect its result, update
  // the record, then reach the page — not for the page to repaint a value it already has. On a loaded
  // four-worker runner that round trip exceeded the shared 15 s allowance once (E6.3-3 on 2026-11-21,
  // `paused` for the whole wait while the run had in fact resumed), so it gets its own budget.
  await expect(tid(page, "run-status")).toHaveText("completed", { timeout: 45_000 });
  expect(chief.calls().at(-1)!.resume).toBe(chief.calls()[1].session);
  await expect(tid(page, "side-effects")).toContainText("t1");
  // A finished run has nothing to cancel or resume; what is left is Run again and Delete.
  await expect(tid(page, "btn-cancel")).toHaveCount(0);
  await expect(tid(page, "btn-resume")).toHaveCount(0);
  await expect(tid(page, "btn-rerun")).toBeVisible();
  await expect(tid(page, "btn-delete-run")).toBeVisible();

  await tid(page, "btn-revert").click();
  // Same reason: a revert runs each step's compensation agent, which is engine work like the resume above.
  await expect(tid(page, "run-status")).toHaveText("reverted", { timeout: 45_000 });
  await expect(tid(page, "revert-report")).toContainText("Compensated: slow");
  await expect(tid(page, "revert-report")).toContainText("side effects reverted: 1");
  await expect(tid(page, "revert-manual")).toContainText("writer: doc d1");
  await expect(tid(page, "revert-manual")).toContainText("node has no compensation");
  await expect(tid(page, "revert-manual")).toContainText("how to undo: delete d1");
  await expect(page.locator('[data-node-id="slow"][data-phase="compensate"]')).toHaveAttribute("data-status", "completed");
  await expect(tid(page, "btn-revert")).toBeDisabled();
  expect((await detail(srv, id)).run.status).toBe("reverted");

  // Cancel a second, running run.
  const id2 = await startRun(srv, "ctl");
  await page.goto(`${srv.url}/#/runs/${id2}`);
  await expect(page.locator('[data-node-id="slow"]')).toHaveAttribute("data-status", "running");
  await tid(page, "btn-cancel").click();
  await expect(tid(page, "run-status")).toHaveText("cancelled");
  expect((await detail(srv, id2)).run.status).toBe("cancelled");
});

const SELECT = `
name: pick
nodes:
  - { id: plan, type: agent, prompt: 'plan ${fake({ output: { items: ITEMS } })}' }
  - { id: choose, type: gate, kind: select, from: "{{nodes.plan.output.items}}", message: "Which ones?" }
  - { id: after, type: agent, prompt: 'chosen={{nodes.choose.output.selected}}' }
edges: [plan -> choose, choose -> after]
`;

test("E6.4-1 a select gate is answered in the UI, item by item or by mode", async ({ chief, boot, page }) => {
  chief.importWorkflow(SELECT);
  const srv = await boot();

  let id = await startRun(srv, "pick");
  await page.goto(`${srv.url}/#/runs/${id}`);
  const gate = page.locator('[data-kind="select"]');
  await expect(gate).toBeVisible();
  await expect(tid(page, "gate-message")).toHaveText("Which ones?");
  await expect(gate).toContainText("Fix prod alert");
  await expect(tid(page, "gates-badge")).toHaveText("1 gate waiting");
  await tid(page, "gate-item-0").check();
  await tid(page, "gate-item-2").check();
  await tid(page, "gate-select-submit").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  await expect(gate).toHaveCount(0);
  let out = nodeOf(await detail(srv, id), "choose").output;
  expect(out.selected.map((i: any) => i.title)).toEqual(["Review PR 12", "Fix prod alert"]);
  expect(out.unselected.map((i: any) => i.title)).toEqual(["Write ADR"]);
  expect(out.mode).toBe("sequential");
  expect(chief.calls().at(-1)!.prompt).toContain("Fix prod alert");

  id = await startRun(srv, "pick");
  await page.goto(`${srv.url}/#/runs/${id}`);
  await tid(page, "gate-mode-all").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  out = nodeOf(await detail(srv, id), "choose").output;
  expect(out.selected).toHaveLength(3);
  expect(out.mode).toBe("parallel");

  id = await startRun(srv, "pick");
  await page.goto(`${srv.url}/#/runs/${id}`);
  await tid(page, "gate-priority-cutoff").fill("P1");
  await tid(page, "gate-mode-by-priority").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  out = nodeOf(await detail(srv, id), "choose").output;
  expect(out.selected.map((i: any) => i.priority)).toEqual(["P0", "P1"]);
});

test("E6.4-2 an approve gate can be edited before approving, or rejected", async ({ chief, boot, page }) => {
  chief.importWorkflow(`
name: appr
nodes:
  - { id: draft, type: agent, prompt: 'draft ${fake({ output: { text: "Hello team" } })}' }
  - { id: ok, type: gate, kind: approve, value: "{{nodes.draft.output.text}}", message: "Send this?" }
  - { id: send, type: agent, prompt: 'send: {{nodes.ok.output.value}}' }
edges: [draft -> ok, ok -> send]
`);
  chief.importWorkflow(`
name: review
nodes:
  - { id: review, type: agent, prompt: 'Review. ${fake({ needs_input: { question: "Post this review?", proposed: { body: "LGTM" } } }, { output: { posted: true } })}' }
`);
  const srv = await boot();

  // Edit, then approve: the workflow receives the edited value.
  let id = await startRun(srv, "appr");
  await page.goto(`${srv.url}/#/runs/${id}`);
  await expect(tid(page, "gate-message")).toHaveText("Send this?");
  await expect(tid(page, "gate-value")).toHaveValue("Hello team");
  await tid(page, "gate-value").fill("Hello everyone");
  await tid(page, "gate-approve").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect(nodeOf(await detail(srv, id), "ok").output.value).toBe("Hello everyone");
  expect(chief.calls().at(-1)!.prompt).toContain("send: Hello everyone");

  // Approve unchanged: the original value passes through.
  id = await startRun(srv, "appr");
  await page.goto(`${srv.url}/#/runs/${id}`);
  await tid(page, "gate-approve").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect(chief.calls().at(-1)!.prompt).toContain("send: Hello team");

  // Reject cancels the run; the next node never runs.
  id = await startRun(srv, "appr");
  await page.goto(`${srv.url}/#/runs/${id}`);
  await expect(tid(page, "gate-reject")).toBeVisible(); // the draft node has run; only the gate is left
  const before = chief.calls().length;
  await tid(page, "gate-reject").click();
  await expect(tid(page, "run-status")).toHaveText("cancelled");
  expect(chief.calls()).toHaveLength(before);

  // An agent's question (needs_input) is an approve gate too; an edited object stays an object.
  id = await startRun(srv, "review");
  await page.goto(`${srv.url}/#/runs/${id}`);
  await expect(page.locator('[data-reason="needs_input"]')).toBeVisible();
  await expect(tid(page, "gate-message")).toHaveText("Post this review?");
  await expect(tid(page, "gate-value")).toHaveValue(/"body": "LGTM"/);
  await tid(page, "gate-value").fill('{"body": "Please split this PR"}');
  await tid(page, "gate-text").fill("be kind");
  await tid(page, "gate-approve").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  const gates = (await detail(srv, id)).gates;
  expect(gates[0].answer).toEqual({ decision: "approve", value: { body: "Please split this PR" }, text: "be kind" });
  expect(chief.calls().at(-1)!.prompt).toContain("Please split this PR");
});

test("E6.4-3 an input gate submits text and an option", async ({ chief, boot, page }) => {
  chief.importWorkflow(`
name: fb
nodes:
  - { id: work, type: agent, prompt: 'work ${fake({ output: { done: 2 } })}' }
  - { id: feedback, type: gate, kind: input, summary: "{{nodes.work.output}}", options: [done, redo], message: "How did it go?" }
edges: [work -> feedback]
`);
  chief.importWorkflow("name: plain\nnodes:\n  - { id: note, type: gate, kind: input }\n");
  const srv = await boot();
  let id = await startRun(srv, "fb");
  await page.goto(`${srv.url}/#/runs/${id}`);
  await expect(tid(page, "gate-message")).toHaveText("How did it go?");
  await expect(tid(page, "gate-summary")).toContainText('"done": 2');
  await tid(page, "gate-text").fill("looks good");
  await tid(page, "gate-option-redo").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect(nodeOf(await detail(srv, id), "feedback").output).toEqual({ text: "looks good", option: "redo" });

  id = await startRun(srv, "plain");
  await page.goto(`${srv.url}/#/runs/${id}`);
  await tid(page, "gate-text").fill("free text only");
  await tid(page, "gate-submit").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect(nodeOf(await detail(srv, id), "note").output).toEqual({ text: "free text only", option: null });
});

test("E6.5-1 the left column offers the building blocks and lists every MCP server of the agent CLI", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  for (const b of ["palette-agent", "palette-script", "palette-gate", "palette-map"]) await expect(tid(page, b)).toBeVisible();
  await expect(tid(page, "palette-script")).not.toHaveAttribute("data-disabled", "true");
  // Every server the agent CLI reports, with its status; the ones it is connected to are in view.
  await expect(page.locator('[data-testid^="palette-mcp-"][data-status]')).toHaveCount(5);
  for (const s of ["atlassian", "github-custom", "google-drive", "slack"]) {
    await expect(tid(page, `palette-mcp-${s}`)).toBeVisible();
    await expect(tid(page, `palette-mcp-${s}`)).toHaveAttribute("data-status", "connected");
  }
  await expect(tid(page, "palette-mcp-notion")).toHaveAttribute("data-status", "needs-auth");
  expect((await srv.api("GET", "/api/mcp")).body).toHaveLength(5);
});

test("E6.5-2 an Agent block dropped on the canvas may use all servers, or the ones ticked in its panel", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "canvas-empty")).toBeVisible();
  await dropFromPalette(page, "palette-agent", 300, 160);
  await expect(tid(page, "flow-node-agent")).toHaveAttribute("data-node-type", "agent");
  // The new node is selected. Nothing to set up: it may use every connected server.
  await expect(tid(page, "node-panel")).toHaveAttribute("data-node-type", "agent");
  await expect(tid(page, "node-id")).toHaveValue("agent");
  await expect(tid(page, "node-mcp-all")).toBeChecked();
  await expect(tid(page, "flow-node-agent")).toContainText("all MCP servers");
  await expect(tid(page, "node-mcp-slack")).toHaveCount(0);
  // Restricting it: untick "all", tick the ones it may use.
  await tid(page, "node-mcp-all").uncheck();
  await expect(tid(page, "flow-node-agent")).toContainText("no MCP");
  await tid(page, "node-mcp-slack").check();
  await expect(tid(page, "flow-node-agent")).toContainText("slack");
  await expect(tid(page, "node-mcp-atlassian")).not.toBeChecked();
  // A second drop gets its own id.
  await dropFromPalette(page, "palette-agent", 300, 360);
  await expect(tid(page, "flow-node-agent-2")).toBeVisible();
  expect((await srv.api("GET", "/api/meta")).status).toBe(200);
});

test("E6.5-3 edges and panel edits end up in the saved definition", async ({ chief, boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await dropAgentWith(page, "slack", 300, 120);
  await tid(page, "node-id").fill("plan");
  await tid(page, "node-prompt").fill("Summarise my Slack for {{inputs.who}}.");
  await tid(page, "node-mcp-github-custom").check();
  // The model is a dropdown filled from the agent CLI, not free text.
  await expect(tid(page, "node-model")).toHaveAttribute("data-loaded", "true");
  await tid(page, "node-model").selectOption("sonnet");
  await tid(page, "node-tools").selectOption("read-only");
  await tid(page, "node-output-schema").fill('{"summary": "string", "items": [{"title": "string"}]}');
  await tid(page, "node-compensate-prompt").fill("Undo: {{output.side_effects}}");
  await tid(page, "node-irreversible").check();
  await tid(page, "node-confirm").uncheck();

  await dropFromPalette(page, "palette-gate", 300, 380);
  await expect(tid(page, "flow-node-gate")).toBeVisible();
  await tid(page, "node-id").fill("choose");
  await tid(page, "node-kind").selectOption("select");
  await tid(page, "node-from").fill("{{nodes.plan.output.items}}");
  await tid(page, "node-message").fill("Which ones?");

  await expect(async () => {
    await connect(page, "plan", "choose");
    await expect(page.locator(".react-flow__edge")).toHaveCount(1, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });

  await wfTab(page);
  await tid(page, "wf-name").fill("designed");
  await tid(page, "wf-base-dir").fill(chief.dir);
  await saved(page, "designed", 1);
  await expect(page).toHaveURL(/#\/designer\/designed$/);

  const { status, body } = await srv.api("GET", "/api/workflows/designed");
  expect(status).toBe(200);
  expect(body.base_dir).toBe(chief.dir);
  const def = body.definition;
  expect(def.edges).toEqual([{ from: "plan", to: "choose" }]);
  const [plan, choose] = def.nodes;
  expect(plan).toMatchObject({
    id: "plan", type: "agent", prompt: "Summarise my Slack for {{inputs.who}}.", mcp: ["slack", "github-custom"], model: "sonnet", tools: "read-only",
    "output-schema": { summary: "string", items: [{ title: "string" }] }, compensate: { prompt: "Undo: {{output.side_effects}}" }, irreversible: true, confirm: false,
  });
  expect(choose).toMatchObject({ id: "choose", type: "gate", kind: "select", from: "{{nodes.plan.output.items}}", message: "Which ones?" });
  // Canvas positions are persisted with the nodes.
  expect(plan.position.y).toBeLessThan(choose.position.y);
  expect(typeof plan.position.x).toBe("number");
  // The CLI sees the same workflow.
  expect(chief.run(["workflow", "export", "designed"]).stdout).toContain("- plan -> choose");
});

test("E6.5-4 validation problems are shown as you go and keep the workflow from being updated", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  // There is nothing to click: no Save and no Validate button.
  await expect(tid(page, "btn-save")).toHaveCount(0);
  await expect(tid(page, "btn-validate")).toHaveCount(0);
  await dropAgentWith(page, "slack", 300, 120);
  await tid(page, "node-prompt").fill("see {{nodes.ghost.output.x}} and {{1+1}}");
  await wfTab(page);
  await tid(page, "wf-name").fill("broken");
  await blocked(page);
  await expect(tid(page, "validation")).toHaveAttribute("data-ok", "false");
  await expect(tid(page, "validation-errors")).toContainText("invalid template reference");

  await stepTab(page);
  await tid(page, "node-prompt").fill("see {{nodes.ghost.output.x}}");
  await expect(tid(page, "validation-errors")).toContainText('refers to unknown node "ghost"');
  await blocked(page);
  expect((await srv.api("GET", "/api/workflows/broken")).status).toBe(404);

  // Fixed: it becomes a workflow by itself.
  await tid(page, "node-prompt").fill("fine now");
  await saved(page, "broken", 1);
  expect((await srv.api("GET", "/api/workflows/broken")).status).toBe(200);

  // A cycle is reported, and the stored workflow keeps its last valid state.
  await dropFromPalette(page, "palette-gate", 300, 380);
  await tid(page, "node-kind").selectOption("approve");
  await expect(async () => {
    await connect(page, "slack", "gate");
    await expect(page.locator(".react-flow__edge")).toHaveCount(1, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await expect.poll(async () => (await srv.api("GET", "/api/workflows/broken")).body.definition.edges).toEqual([{ from: "slack", to: "gate" }]);
  await saved(page, "broken", 1);
  await expect(async () => {
    await connect(page, "gate", "slack");
    await expect(page.locator(".react-flow__edge")).toHaveCount(2, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await blocked(page);
  await expect(tid(page, "validation-errors")).toContainText("workflow has a cycle");
  await expect(tid(page, "autosave-status")).toContainText("“broken” keeps its last valid version (v1)");
  expect((await srv.api("GET", "/api/workflows/broken")).body.definition.edges).toEqual([{ from: "slack", to: "gate" }]);

  // Once fixed, it is saved again, with warnings and estimates shown.
  await page.locator(".react-flow__edge").last().click({ force: true });
  await page.keyboard.press("Backspace");
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await saved(page, "broken", 1);
  await expect(tid(page, "validation")).toHaveAttribute("data-ok", "true");
  await expect(tid(page, "validation-estimates")).toContainText("slack: ~");
});

test("E6.5-5 a saved workflow survives a reload and can be run from the designer", async ({ chief, boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await dropAgentWith(page, "slack", 320, 200);
  await tid(page, "node-id").fill("hello");
  await tid(page, "node-prompt").fill(`Say hello to {{inputs.who}} ${fake({ output: { greeting: "hi" } })}`);
  await wfTab(page);
  await tid(page, "wf-name").fill("from-designer");
  await tid(page, "wf-inputs").fill('{"who": "the team"}');
  await tid(page, "wf-agent").selectOption("claude-code");
  await tid(page, "wf-base-dir").fill(chief.dir);
  await saved(page, "from-designer", 1);

  await page.reload();
  await expect(tid(page, "flow-node-hello")).toBeVisible();
  await wfTab(page);
  await expect(tid(page, "wf-name")).toHaveValue("from-designer");
  await expect(tid(page, "wf-picker")).toHaveValue("from-designer");
  await wfTab(page);
  await expect(tid(page, "wf-inputs")).toHaveValue('{\n  "who": "the team"\n}');
  await expect(tid(page, "wf-agent")).toHaveValue("claude-code");
  await flowNode(page, "hello").click();
  await expect(tid(page, "node-prompt")).toHaveValue(/Say hello/);
  await expect(tid(page, "node-mcp-slack")).toBeChecked();

  await tid(page, "btn-run").click();
  await expect(page).toHaveURL(/#\/runs\/1$/);
  await expect(tid(page, "run-title")).toContainText("Run #1 · from-designer");
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect(chief.calls()[0].prompt).toContain("Say hello to the team");
  expect(chief.calls()[0].argv).toContain("mcp__claude_ai_Slack");
  expect((await srv.api("GET", "/api/workflows/from-designer")).body.definition).toMatchObject({ agent: "claude-code", inputs: { who: "the team" } });
  // Unchanged save before the run: still version 1.
  expect((await srv.api("GET", "/api/workflows/from-designer")).body.version).toBe(1);
});

test("E6.5-6 YAML can be imported onto the canvas and exported again", async ({ chief, boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await tid(page, "btn-import").click();
  await tid(page, "import-yaml").fill("name: Not Valid\nnodes: []\n");
  await tid(page, "import-load").click();
  await expect(tid(page, "import-errors")).toContainText("lower-case kebab-case");

  // "New workflow" gives an empty canvas after an import (the imported workflow itself was saved automatically).
  await tid(page, "import-yaml").fill("name: throwaway\nnodes:\n  - { id: only, type: agent, prompt: x }\n");
  await tid(page, "import-load").click();
  await expect(tid(page, "flow-node-only")).toBeVisible();
  await tid(page, "btn-new").click();
  await tid(page, "new-wf-name").fill("next-one");
  await tid(page, "new-wf-create").click();
  await expect(tid(page, "flow-node-only")).toHaveCount(0);
  await wfTab(page);
  await expect(tid(page, "wf-name")).toHaveValue("next-one");
  await tid(page, "btn-import").click();

  await tid(page, "import-yaml").fill(`
name: imported
budget: { max-usd: 3 }
nodes:
  - { id: plan, type: agent, mcp: [slack], prompt: "Plan the day" }
  - { id: ok, type: gate, kind: approve, value: "{{nodes.plan.output}}" }
  - id: each
    type: map
    over: "{{nodes.plan.output.items}}"
    mode: parallel
    node: { type: agent, mcp: [github-custom], prompt: "Do {{item}}" }
edges: [plan -> ok, ok -> each]
`);
  await tid(page, "import-load").click();
  await expect(tid(page, "import-modal")).toHaveCount(0);
  for (const n of ["plan", "ok", "each"]) await expect(tid(page, `flow-node-${n}`)).toBeVisible();
  await expect(tid(page, "flow-node-each")).toHaveAttribute("data-node-type", "map");
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await wfTab(page);
  await expect(tid(page, "wf-name")).toHaveValue("imported");
  // The budget fields are hidden while budgets are (task 15.24), but what the import carried is kept: the
  // workflow's budget is still there, just not shown.
  await expect(tid(page, "wf-max")).toHaveCount(0);
  // An import is saved like any other change.
  await saved(page, "imported", 1);
  expect((await srv.api("GET", "/api/workflows/imported")).status).toBe(200);
  expect((await srv.api("GET", "/api/workflows/imported")).body.definition.budget).toEqual({ "max-usd": 3 });

  // The map's inner node is editable in the panel.
  await flowNode(page, "each").click();
  await expect(tid(page, "node-over")).toHaveValue("{{nodes.plan.output.items}}");
  await expect(tid(page, "inner-prompt")).toHaveValue("Do {{item}}");
  await expect(tid(page, "inner-mcp-github-custom")).toBeChecked();

  await wfTab(page);
  await tid(page, "wf-base-dir").fill(chief.dir);
  await saved(page, "imported", 1);
  await tid(page, "btn-export").click();
  const shown = await tid(page, "export-yaml").inputValue();
  expect(shown).toBe(chief.run(["workflow", "export", "imported"]).stdout);
  expect(shown).toContain("- plan -> ok");
  expect(shown).toContain("mode: parallel");
  await expect(tid(page, "export-download")).toHaveAttribute("download", "imported.yaml");
});

test("E6.5-7 the script panel shows the sandbox, cannot turn it off, and asks before widening it", async ({ chief, boot, page }) => {
  chief.file("job.sh", "cat > /dev/null\necho '{\"ok\": true}'\n");
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await dropFromPalette(page, "palette-script", 320, 200);
  await expect(tid(page, "node-panel")).toHaveAttribute("data-node-type", "script");
  const sandbox = tid(page, "node-sandbox");
  await expect(sandbox).toContainText("Scripts always run sandboxed");
  // The only sandbox controls widen it: network, extra write paths, env names. Nothing disables it.
  await expect(sandbox.locator("input[type=checkbox]")).toHaveCount(1);
  await expect(tid(page, "node-sandbox-network")).not.toBeChecked();
  expect(await sandbox.locator("input, textarea, select, button:not([data-testid^='help-'])").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")))).toEqual(["node-sandbox-network", "node-sandbox-write", "node-sandbox-env"]);
  expect((await tid(page, "node-panel").innerText()).toLowerCase()).not.toMatch(/disable the sandbox|turn off|sandbox: off|unsandboxed|without sandbox/);

  await tid(page, "node-id").fill("job");
  await tid(page, "node-run").fill("job.sh");
  await wfTab(page);
  await tid(page, "wf-name").fill("scripted");
  await tid(page, "wf-base-dir").fill(chief.dir);

  // Default sandbox: saved by itself, nothing to approve.
  await saved(page, "scripted", 1);
  await expect(tid(page, "approval-needed")).toHaveCount(0);
  expect((await srv.api("GET", "/api/workflows/scripted")).body.approvals).toEqual([]);

  // Widening is saved like any other change, but the workflow cannot run until you approve it.
  await stepTab(page);
  await tid(page, "node-sandbox-network").check();
  await tid(page, "node-sandbox-env").fill("GITHUB_TOKEN");
  await saved(page, "scripted", 1);
  await expect(tid(page, "approval-needed")).toContainText("Approval needed before this workflow can run");
  await expect(tid(page, "approve-list")).toContainText("job");
  await expect(tid(page, "approve-list")).toContainText("network");
  await expect(tid(page, "approve-list")).toContainText("env: GITHUB_TOKEN");
  let stored = (await srv.api("GET", "/api/workflows/scripted")).body;
  expect(stored.definition.nodes[0].sandbox).toEqual({ network: true, write: [], env: ["GITHUB_TOKEN"] });
  expect(stored.approvals).toEqual([expect.objectContaining({ node_id: "job", approved: false })]);
  const refused = chief.run(["run", "scripted"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("is not approved for the current script");

  // Approving is an explicit click; after it the workflow can run.
  await tid(page, "approve-confirm").click();
  await expect(tid(page, "approval-needed")).toHaveCount(0);
  stored = (await srv.api("GET", "/api/workflows/scripted")).body;
  expect(stored.approvals).toEqual([expect.objectContaining({ node_id: "job", approved: true })]);
  await expect(tid(page, "validation-warnings")).toContainText("widens the sandbox without a `compensate`");
  const run = chief.run(["run", "scripted", "--json"]);
  expect(run.code, run.stdout + run.stderr).toBe(0);
  expect(run.json().node_runs[0].output).toEqual({ ok: true });
});

test("E6.5-8 without a sandbox backend the Script entry is greyed out and cannot be added", async ({ boot, page }) => {
  const srv = await boot({ env: { CHIEF_SANDBOX_BACKEND: "none" } });
  expect((await srv.api("GET", "/api/meta")).body.sandbox.available).toBe(false);
  await page.goto(srv.url + "/#/designer");
  // The MCP servers arrive a moment after the page; until then the entries below them still move.
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  const script = tid(page, "palette-script");
  await expect(script).toHaveAttribute("data-disabled", "true");
  await expect(script).toHaveAttribute("aria-disabled", "true");
  await expect(script).toHaveAttribute("draggable", "false");
  await expect(script).toHaveClass(/cursor-not-allowed/);
  await expect(tid(page, "palette-script-reason")).toContainText("sandbox backend disabled");
  await script.dragTo(tid(page, "canvas"), { targetPosition: { x: 300, y: 200 } }).catch(() => {});
  await script.dblclick();
  await expect(page.locator('[data-node-type="script"]')).toHaveCount(0);
  await expect(tid(page, "canvas-empty")).toBeVisible();
  // Other blocks still work, and a map cannot pick a script inner node either.
  await dropFromPalette(page, "palette-map", 300, 200);
  await expect(tid(page, "flow-node-map")).toBeVisible();
  await expect(tid(page, "inner-type").locator('option[value="script"]')).toBeDisabled();
  // Settings says the same.
  await tid(page, "nav-settings").click();
  await expect(tid(page, "doctor-sandbox")).toContainText("script nodes disabled");
});

test("E6.6-2 settings can be changed and persist", async ({ chief, boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/settings");
  // The doctor and discovery spawn the agent CLI, which can be slow when many tests run at once.
  await expect(tid(page, "doctor-ok")).toHaveText("All good.", { timeout: 20_000 });
  await expect(tid(page, "doctor-adapter-claude-code")).toContainText("2.1.311 ok");
  await expect(tid(page, "setting-default-adapter")).toHaveValue("claude-code");
  await expect(tid(page, "setting-output-size-limit")).toHaveValue("20000");
  await expect(tid(page, "setting-notify")).toBeChecked();

  // One path field per agent CLI, in the provider cards: each card shows its own (task 15.14).
  for (const a of ["claude-code", "codex", "cursor", "antigravity", "opencode", "hermes"]) {
    await expect(tid(page, `provider-${a}`)).toBeVisible();
    await tid(page, `provider-${a}`).click();
    await expect(tid(page, `setting-${a}-path`)).toBeVisible();
  }
  // Only the CLIs switched on are offered as the default, and only Claude Code was found here.
  await expect(tid(page, "setting-default-adapter").locator("option")).toHaveText(["Claude Code"]);

  // Paths that exist, so this case is about the field persisting and not about the self-healing below.
  const codexBin = chief.file("bin/codex", "#!/bin/sh\necho codex-cli 0.63.0\n");
  const opencodeBin = chief.file("bin/opencode", "#!/bin/sh\necho 1.18.31\n");
  await tid(page, "provider-codex").click();
  await tid(page, "setting-codex-path").fill(codexBin);
  await tid(page, "provider-opencode").click();
  await tid(page, "setting-opencode-path").fill(opencodeBin);
  // The budget fields are hidden while budgets are (task 15.24), so nothing here sets one: a budget that
  // already exists is kept by the form, which is what the assertions below check.
  await expect(tid(page, "setting-warn-usd")).toHaveCount(0);
  await expect(tid(page, "setting-max-usd")).toHaveCount(0);
  await tid(page, "setting-output-size-limit").fill("5000");
  await tid(page, "setting-workspace-dir").fill("~/somewhere-else");
  await tid(page, "setting-notify").uncheck();
  // No Save button: each change is saved a moment after it is made.
  await expect(tid(page, "settings-save")).toHaveCount(0);
  await expect(tid(page, "settings-status")).toHaveAttribute("data-state", "saved");
  await expect(tid(page, "settings-status")).toContainText("Saved automatically");

  // What was typed in the path fields is stored; the paths detection found are stored too, so the field
  // of the CLI that was found holds its real path rather than being empty.
  await expect.poll(() => chief.run(["settings", "get", "--json"]).json()).toMatchObject({
    "default-adapter": "claude-code", "codex.path": codexBin, "opencode.path": opencodeBin,
    "output-size-limit": 5000, notify: false, "workspace-dir": "~/somewhere-else",
  });
  await page.reload();
  await tid(page, "provider-codex").click();
  await expect(tid(page, "setting-codex-path")).toHaveValue(codexBin);
  await tid(page, "provider-opencode").click();
  await expect(tid(page, "setting-opencode-path")).toHaveValue(opencodeBin);
  await expect(tid(page, "setting-output-size-limit")).toHaveValue("5000");
  await expect(tid(page, "setting-workspace-dir")).toHaveValue("~/somewhere-else");
  await expect(tid(page, "setting-notify")).not.toBeChecked();

  // An invalid value is not saved and says why; the last valid value stays in the database.
  await tid(page, "setting-output-size-limit").fill("lots");
  await expect(tid(page, "error")).toContainText("output size limit must be a whole number");
  await expect(tid(page, "settings-status")).toHaveAttribute("data-state", "invalid");
  expect(chief.run(["settings", "get", "output-size-limit", "--json"]).json()).toBe(5000);
  await tid(page, "setting-output-size-limit").fill("6000");
  await expect(tid(page, "settings-status")).toHaveAttribute("data-state", "saved");
  await expect(tid(page, "error")).toHaveCount(0);
  await expect.poll(() => chief.run(["settings", "get", "output-size-limit", "--json"]).json()).toBe(6000);
  await tid(page, "btn-discover").click();
  await expect(tid(page, "settings-note")).toContainText("claude-code: 5 servers", { timeout: 20_000 });
  await expect(tid(page, "doctor-mcp")).toHaveText("5 MCP servers known", { timeout: 20_000 });
});

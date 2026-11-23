import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, fake, FAKE_ANTIGRAVITY, FAKE_CODEX, FAKE_CURSOR, FAKE_OPENCODE, ROOMY_LAYOUT_KEYS, ROOT_DIR, showStep, test as base, type Server, roomyLayout } from "../helpers";

const test = base.extend<{ boot: (opts?: { env?: Record<string, string>; compact?: boolean }) => Promise<Server> }>({
  boot: async ({ chief }, use) => {
    const started: Server[] = [];
    // The designer starts with everything open (see roomyLayout), unless a case asks for the compact layout.
    await use(async (opts) => { const s = await chief.serve(opts); started.push(s); if (!opts?.compact) await roomyLayout(s); return s; });
    for (const s of started) await s.stop();
  },
});

const tid = (page: Page, id: string) => page.getByTestId(id);
/** The designer's side panel has two tabs: the workflow's settings, and the selected step. */
const wfTab = (page: Page) => tid(page, "tab-workflow").click();
const stepTab = (page: Page) => tid(page, "tab-step").click();
const flowNode = (page: Page, id: string) => page.locator(`.react-flow__node:has([data-testid="flow-node-${id}"])`);
/** Drag a palette entry onto the canvas. A real mouse drag can miss when several windows are open, so it is repeated only if no node appeared. */
async function drop(page: Page, palette: string, x: number, y: number) {
  // The MCP servers arrive a moment after the page; until then the entries below them still move.
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
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
  await drop(page, "palette-agent", x, y);
  await tid(page, "node-id").fill(server);
  // A new agent node may use all connected servers; restrict it to this one.
  await tid(page, "node-mcp-all").uncheck();
  await tid(page, `node-mcp-${server}`).check();
}
async function connect(page: Page, from: string, to: string) {
  const a = await flowNode(page, from).locator(".react-flow__handle-bottom").boundingBox();
  const b = await flowNode(page, to).locator(".react-flow__handle-top").boundingBox();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 12 });
  await page.mouse.up();
}
/** Keys of the drafts stored in chief's database (after the page's writes have gone out). */
const drafts = async (page: Page, srv: Server) => {
  await page.waitForFunction(() => !(window as any).__chiefDraftWrites);
  // Without the layout choices every case starts with (see roomyLayout): they are not drafts of anything typed.
  return Object.keys((await srv.api("GET", "/api/drafts")).body).filter((k) => !ROOMY_LAYOUT_KEYS.includes(k)).sort();
};
/** Refresh the page once what was typed has been handed to the server. */
const refresh = async (page: Page) => {
  await page.waitForFunction(() => !(window as any).__chiefDraftWrites);
  await page.reload();
};
/** There is no Save button. Wait until the designer reports that the canvas is stored as the workflow. */
async function saved(page: Page, name: string, version?: number) {
  const st = tid(page, "autosave-status");
  await expect(st).toHaveAttribute("data-dirty", "false", { timeout: 15_000 });
  await expect(st).toHaveAttribute("data-state", "saved");
  await expect(st).toContainText(version ? `${name} v${version}` : name);
}
/** Wait until the designer has tried to save and found the canvas is not a valid workflow yet. */
const blocked = (page: Page) => expect(tid(page, "autosave-status")).toHaveAttribute("data-state", "blocked", { timeout: 15_000 });
/** "New workflow": the panel that slides in from the right, filled in and created. */
const newWorkflow = async (page: Page, name: string, baseDir?: string) => {
  await tid(page, "btn-new").click();
  await expect(tid(page, "new-wf-panel")).toBeVisible();
  await tid(page, "new-wf-name").fill(name);
  if (baseDir) await tid(page, "new-wf-base-dir").fill(baseDir);
  await tid(page, "new-wf-create").click();
  await expect(tid(page, "new-wf-panel")).toHaveCount(0);
};
const importYaml = async (page: Page, yaml: string) => {
  await tid(page, "btn-import").click();
  await tid(page, "import-yaml").fill(yaml);
  await tid(page, "import-load").click();
  await expect(tid(page, "import-modal")).toHaveCount(0);
};

test("E9.1-2 the web UI has no backlog", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/");
  await expect(tid(page, "nav-runs")).toBeVisible();
  await expect(tid(page, "nav-backlog")).toHaveCount(0);
  await expect(page.getByText(/backlog/i)).toHaveCount(0);
  await page.goto(srv.url + "/#/backlog");
  await expect(page.getByText("Page not found.")).toBeVisible();
  await page.goto(srv.url + "/#/designer");
  await drop(page, "palette-gate", 300, 200);
  await tid(page, "node-kind").selectOption("select");
  await expect(tid(page, "side-panel")).not.toContainText(/backlog/i);
});

test("E9.2-8 the run page replays the recorded messages step by step", async ({ chief, boot, page }) => {
  const tools = [{ name: "mcp__claude_ai_Slack__slack_search_channels", input: { query: "general" }, result: "found #general" }];
  chief.importWorkflow(`
name: replayed
nodes:
  - { id: plan, type: agent, mcp: [slack], prompt: 'Plan the day ${fake({ tools, output: { summary: "quiet" } })}' }
  - { id: broken, type: script, run: nope.sh }
edges: [plan -> broken]
`);
  chief.file("nope.sh", "echo 'cannot continue' >&2\nexit 3\n");
  chief.importWorkflow("name: other\nnodes:\n  - { id: z, type: agent, prompt: other }\n");
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "replayed" });
  await srv.api("POST", "/api/runs", { workflow: "other" });
  await chief.until(async () => (await srv.api("GET", "/api/runs/1")).body.run.status === "failed");
  const total = (await srv.api("GET", "/api/runs/1/transcript")).body.length;

  // Runs can be listed per workflow.
  await page.goto(srv.url + "/#/runs");
  await expect(tid(page, "run-row-2")).toBeVisible();
  await tid(page, "runs-filter").selectOption("replayed");
  await expect(tid(page, "run-row-2")).toHaveCount(0);
  await expect(tid(page, "run-row-1")).toBeVisible();
  await tid(page, "run-row-1").click();

  await expect(tid(page, "replay-count")).toHaveText(`(${total} recorded messages)`);
  await expect(tid(page, "replay-position")).toHaveText(`1 / ${total}`);
  await expect(tid(page, "replay-kind")).toHaveText("run_input");
  await expect(tid(page, "replay-prev")).toBeDisabled();

  // Step forward to the prompt: it is shown exactly as it was sent.
  const kinds: string[] = [];
  for (let i = 0; i < total; i++) {
    kinds.push((await tid(page, "replay-kind").textContent())!);
    if (kinds.at(-1) === "prompt") break;
    await tid(page, "replay-next").click();
  }
  expect(kinds.slice(0, 5)).toEqual(["run_input", "run_started", "node_running", "command", "prompt"]);
  await expect(tid(page, "replay-content")).toContainText("Plan the day");
  await expect(tid(page, "replay-content")).toContainText("Output contract");
  await expect(tid(page, "replay-head")).toContainText("→ to worker");
  await expect(tid(page, "replay-head")).toContainText("node plan");

  // Jump to a tool call and to the script's stderr by clicking the list.
  await page.locator('[data-testid^="replay-row-"][data-kind="tool_use"]').click();
  await expect(tid(page, "replay-content")).toContainText('"query": "general"');
  await expect(tid(page, "replay-head")).toContainText("slack_search_channels");
  await tid(page, "replay-next").click();
  await expect(tid(page, "replay-kind")).toHaveText("tool_result");
  await expect(tid(page, "replay-content")).toHaveText("found #general");
  await tid(page, "replay-prev").click();
  await expect(tid(page, "replay-kind")).toHaveText("tool_use");

  // One node only.
  await tid(page, "replay-node").selectOption("broken");
  await expect(page.locator('[data-testid^="replay-row-"]')).toHaveCount(6);
  await page.locator('[data-testid^="replay-row-"][data-kind="stderr"]').click();
  await expect(tid(page, "replay-content")).toHaveText("cannot continue");
  await page.locator('[data-testid^="replay-row-"][data-kind="node_failed"]').click();
  await expect(tid(page, "replay-content")).toContainText("script exited with code 3");

  // Play runs through to the end on its own.
  await tid(page, "replay-node").selectOption("");
  await page.locator('[data-testid^="replay-row-"]').nth(total - 3).click();
  await tid(page, "replay-play").click();
  await expect(tid(page, "replay-position")).toHaveText(`${total} / ${total}`, { timeout: 10_000 });
  await expect(tid(page, "replay-kind")).toHaveText("run_failed");
  await expect(tid(page, "replay-next")).toBeDisabled();
});

test("E9.3-1 designer edits are kept across a refresh, valid or not", async ({ chief, boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await dropAgentWith(page, "slack", 320, 160);
  await tid(page, "node-id").fill("plan");
  await tid(page, "node-prompt").fill("Summarise my Slack.\nSecond line that must not be lost.");
  await wfTab(page);
  await tid(page, "wf-inputs").fill('{"hours": 8}');
  await tid(page, "wf-base-dir").fill(chief.dir);

  // Without a name it cannot be a workflow yet, but nothing typed is lost on a refresh.
  await blocked(page);
  await expect(tid(page, "validation-errors")).toContainText("Give the workflow a name");
  // The message says where, and the empty Name field is marked.
  await expect(tid(page, "validation-errors")).toContainText("Name field at the top of this page");
  await expect(tid(page, "wf-name")).toHaveAttribute("aria-invalid", "true");
  expect(await drafts(page, srv)).toEqual(["designer:__new__"]);
  expect((await srv.api("GET", "/api/workflows")).body).toEqual([]);
  // No "your changes were restored" banner any more (removed 2026-11-22): the canvas coming back is the news.
  await refresh(page);
  await expect(tid(page, "draft-notice")).toHaveCount(0);
  await expect(tid(page, "flow-node-plan")).toBeVisible();
  await wfTab(page);
  await expect(tid(page, "wf-inputs")).toHaveValue('{"hours": 8}');
  await flowNode(page, "plan").click();
  await expect(tid(page, "node-prompt")).toHaveValue("Summarise my Slack.\nSecond line that must not be lost.");
  await expect(tid(page, "node-mcp-slack")).toBeChecked();

  // Naming it makes it a workflow, with no Save click; the working copy is no longer needed.
  await wfTab(page);
  await tid(page, "wf-name").fill("drafted");
  await saved(page, "drafted", 1);
  expect(await drafts(page, srv)).toEqual([]);
  expect((await srv.api("GET", "/api/workflows/drafted")).body.definition.nodes[0].prompt).toContain("Second line that must not be lost.");
  await refresh(page);
  await expect(tid(page, "flow-node-plan")).toBeVisible();
  await expect(tid(page, "draft-notice")).toHaveCount(0);

  // An edit that makes it invalid is kept too, while the workflow keeps its last valid state.
  await flowNode(page, "plan").click();
  await tid(page, "node-prompt").fill("");
  await drop(page, "palette-gate", 320, 420);
  await blocked(page);
  expect(await drafts(page, srv)).toEqual(["designer:drafted"]);
  await refresh(page);
  // No banner to announce it: the invalid edit and the step that was dropped are back on the canvas, which is the assertion.
  await expect(tid(page, "draft-notice")).toHaveCount(0);
  await expect(tid(page, "flow-node-gate")).toBeVisible();
  await flowNode(page, "plan").click();
  await expect(tid(page, "node-prompt")).toHaveValue("");
  await blocked(page);
  const kept = (await srv.api("GET", "/api/workflows/drafted")).body.definition;
  expect(kept.nodes).toHaveLength(1);
  expect(kept.nodes[0].prompt).toContain("Second line that must not be lost.");

  // There is no "throw the working copy away" button any more (removed 2026-11-22 with its notice). Putting the canvas
  // back to the stored workflow is undoing the two edits — the emptied prompt and the dropped step — and the last of them
  // saves it, with no working copy left behind.
  await expect(tid(page, "draft-discard")).toHaveCount(0);
  await expect(tid(page, "flow-node-gate")).toBeVisible();
  await flowNode(page, "gate").click();
  await tid(page, "node-delete").click();
  await expect(tid(page, "flow-node-gate")).toHaveCount(0);
  await flowNode(page, "plan").click();
  await tid(page, "node-prompt").fill("Summarise my Slack.\nSecond line that must not be lost.");
  await saved(page, "drafted", 1);
  expect(await drafts(page, srv)).toEqual([]);
});

test("E9.3-2 gate answers in progress survive a refresh and are cleared once sent", async ({ chief, boot, page }) => {
  chief.importWorkflow(`
name: gates
inputs: { items: [{ title: "First", priority: P1 }, { title: "Second", priority: P2 }, { title: "Third", priority: P0 }] }
nodes:
  - { id: pick, type: gate, kind: select, from: "{{inputs.items}}" }
  - { id: ok, type: gate, kind: approve, value: "Original announcement text" }
  - { id: fb, type: gate, kind: input, options: [done, redo] }
  - { id: end, type: agent, prompt: 'got {{nodes.ok.output.value}} / {{nodes.fb.output.text}} / {{nodes.pick.output.selected}}' }
edges: [pick -> ok, ok -> fb, fb -> end]
`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "gates" });
  await page.goto(srv.url + "/#/runs/1");

  await tid(page, "gate-item-0").check();
  await tid(page, "gate-item-2").check();
  await tid(page, "gate-priority-cutoff").fill("P1");
  await refresh(page);
  await expect(tid(page, "gate-item-0")).toBeChecked();
  await expect(tid(page, "gate-item-1")).not.toBeChecked();
  await expect(tid(page, "gate-item-2")).toBeChecked();
  await expect(tid(page, "gate-priority-cutoff")).toHaveValue("P1");
  await tid(page, "gate-select-submit").click();

  await expect(tid(page, "gate-value")).toHaveValue("Original announcement text");
  await tid(page, "gate-value").fill("A long, carefully edited announcement\nthat took a while to write.");
  await tid(page, "gate-text").fill("please keep the second line");
  await refresh(page);
  await expect(tid(page, "gate-value")).toHaveValue("A long, carefully edited announcement\nthat took a while to write.");
  await expect(tid(page, "gate-text")).toHaveValue("please keep the second line");
  await tid(page, "gate-approve").click();

  await expect(tid(page, "gate-option-done")).toBeVisible();
  // The note of the previous gate does not leak into this one.
  await expect(tid(page, "gate-text")).toHaveValue("");
  await tid(page, "gate-text").fill("Feedback typed before an accidental refresh.");
  await refresh(page);
  await expect(tid(page, "gate-text")).toHaveValue("Feedback typed before an accidental refresh.");
  await tid(page, "gate-option-done").click();
  await expect(tid(page, "run-status")).toHaveText("completed");

  const prompt = chief.calls()[0].prompt;
  expect(prompt).toContain("that took a while to write.");
  expect(prompt).toContain("Feedback typed before an accidental refresh.");
  expect(prompt).toContain('"title": "Third"');
  expect(prompt).not.toContain('"title": "Second"');
  expect((await drafts(page, srv)).filter((k) => k.startsWith("gate:"))).toEqual([]);
});

test("E9.3-3 new-run inputs, settings and import text survive a refresh", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: alpha\nnodes:\n  - { id: a, type: agent, prompt: 'hi {{inputs.who}}' }\n");
  chief.importWorkflow("name: beta\ninputs: { who: nobody }\nnodes:\n  - { id: a, type: agent, prompt: 'hello {{inputs.who}}' }\n");
  const srv = await boot();

  await page.goto(srv.url + "/#/runs");
  await tid(page, "new-run-workflow").selectOption("beta");
  await tid(page, "new-run-inputs").fill('{"who": "the whole team"}');
  await refresh(page);
  await expect(tid(page, "new-run-workflow")).toHaveValue("beta");
  await expect(tid(page, "new-run-inputs")).toHaveValue('{"who": "the whole team"}');
  await tid(page, "new-run-start").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect(chief.calls()[0].prompt).toContain("hello the whole team");
  await page.goto(srv.url + "/#/runs");
  // What was typed is gone; the box comes back as the inputs' **shape**, with the workflow's own default in it (15.116),
  // rather than empty or as a grey sample nobody can edit.
  await expect(tid(page, "new-run-inputs")).toHaveValue(/\{\s*"who": "nobody"\s*\}/);
  await expect(tid(page, "new-run-inputs")).not.toHaveValue(/the whole team/);

  await page.goto(srv.url + "/#/settings");
  await expect(tid(page, "setting-output-size-limit")).toHaveValue("20000");
  // Valid changes are saved by themselves and are there after a refresh.
  await tid(page, "setting-output-size-limit").fill("5000");
  await tid(page, "setting-workspace-dir").fill("~/draft-test");
  await expect(tid(page, "settings-status")).toHaveAttribute("data-state", "saved");
  await expect.poll(async () => (await srv.api("GET", "/api/settings")).body).toMatchObject({ "output-size-limit": 5000, "workspace-dir": "~/draft-test" });
  await refresh(page);
  await expect(tid(page, "setting-output-size-limit")).toHaveValue("5000");
  await expect(tid(page, "setting-workspace-dir")).toHaveValue("~/draft-test");
  // A value that cannot be saved stays on screen across a refresh, with the reason.
  await tid(page, "setting-output-size-limit").fill("fifty");
  await expect(tid(page, "settings-status")).toHaveAttribute("data-state", "invalid");
  await refresh(page);
  await expect(tid(page, "setting-output-size-limit")).toHaveValue("fifty");
  await expect(tid(page, "settings-status")).toHaveAttribute("data-state", "invalid");
  await expect(tid(page, "error")).toContainText("output size limit must be a whole number");
  expect((await srv.api("GET", "/api/settings")).body["output-size-limit"]).toBe(5000);
  await tid(page, "setting-output-size-limit").fill("6000");
  await expect(tid(page, "settings-status")).toHaveAttribute("data-state", "saved");
  await expect.poll(async () => (await srv.api("GET", "/api/settings")).body["output-size-limit"]).toBe(6000);
  expect((await drafts(page, srv)).filter((k) => k.startsWith("settings"))).toEqual([]);

  await page.goto(srv.url + "/#/designer");
  await tid(page, "btn-import").click();
  await tid(page, "import-yaml").fill("name: half-pasted\nnodes:\n  - id: a");
  await refresh(page);
  await tid(page, "btn-import").click();
  await expect(tid(page, "import-yaml")).toHaveValue("name: half-pasted\nnodes:\n  - id: a");
});

test("E9.4-1 every connection is an arrow and the nodes that run first are marked", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await importYaml(page, `
name: arrows
nodes:
  - { id: first, type: agent, prompt: a }
  - { id: second, type: agent, prompt: b }
  - { id: third, type: agent, prompt: c }
  - { id: alone, type: agent, prompt: d }
edges: [first -> second, second -> third]
`);
  const paths = page.locator(".react-flow__edge-path");
  await expect(paths).toHaveCount(2);
  for (const marker of await paths.evaluateAll((els) => els.map((e) => e.getAttribute("marker-end")))) expect(marker).toMatch(/^url\(.+\)$/);
  // The arrowhead they point to really exists in the drawing.
  const id = (await paths.first().getAttribute("marker-end"))!.match(/#([^'")]+)/)![1];
  await expect(page.locator(`marker[id="${id}"]`)).toHaveCount(1);
  // An arrow goes from the node that runs first (above) to the node that runs after it (below).
  const y = async (n: string) => (await flowNode(page, n).boundingBox())!.y;
  expect(await y("first")).toBeLessThan(await y("second"));
  expect(await y("second")).toBeLessThan(await y("third"));

  // Nodes nothing points to are marked; the others are not.
  await expect(tid(page, "runs-first-first")).toHaveText("runs first");
  await expect(tid(page, "runs-first-alone")).toBeVisible();
  await expect(tid(page, "runs-first-second")).toHaveCount(0);
  await expect(tid(page, "runs-first-third")).toHaveCount(0);

  // A connection drawn by hand is an arrow too, and its target stops being a starting point.
  // (The drag is retried: with several browser windows open at once a mouse drag can miss its target.)
  await expect(async () => {
    await connect(page, "third", "alone");
    await expect(paths).toHaveCount(3, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  for (const marker of await paths.evaluateAll((els) => els.map((e) => e.getAttribute("marker-end")))) expect(marker).toMatch(/^url\(.+\)$/);
  await expect(tid(page, "runs-first-alone")).toHaveCount(0);
  // With nothing selected, the side panel explains how to read the arrows.
  await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } });
  await stepTab(page);
  await expect(tid(page, "panel-empty")).toContainText("the arrow points to the node that runs after");
});

test("E9.5-4 the model is chosen from a dropdown filled by the node's agent CLI", async ({ chief, boot, page }) => {
  const srv = await boot({ env: { CHIEF_CURSOR_BIN: FAKE_CURSOR } });
  await page.goto(srv.url + "/#/designer");
  await drop(page, "palette-agent", 320, 180);
  const model = tid(page, "node-model");
  await expect(model).toHaveAttribute("data-loaded", "true");
  expect(await model.evaluate((el) => el.tagName)).toBe("SELECT");
  await expect(model).toHaveAttribute("data-adapter", "claude-code");
  expect(await model.locator("option").evaluateAll((os) => os.map((o) => [(o as HTMLOptionElement).value, o.textContent]))).toEqual([
    ["", "Default (recommended) (claude-fable-5-1)"], ["opus", "Opus 5.5 (claude-opus-5-5)"], ["sonnet", "Sonnet 5.5 (claude-sonnet-5-5)"], ["haiku", "Haiku 5.5 (claude-haiku-5-5)"],
  ]);
  await model.selectOption("haiku");
  await tid(page, "node-id").fill("a");
  await tid(page, "node-prompt").fill("hello");
  await wfTab(page);
  await tid(page, "wf-name").fill("models");
  await tid(page, "wf-base-dir").fill(chief.dir);
  // Picking a model is saved like everything else.
  await saved(page, "models", 1);
  expect((await srv.api("GET", "/api/workflows/models")).body.definition.nodes[0].model).toBe("haiku");
  await stepTab(page);
  await tid(page, "node-model").selectOption("opus");
  await expect.poll(async () => (await srv.api("GET", "/api/workflows/models")).body.definition.nodes[0].model).toBe("opus");
  await saved(page, "models", 1);
  await tid(page, "node-model").selectOption("haiku");
  await saved(page, "models", 1);

  // Another agent CLI, another list.
  await wfTab(page);
  await tid(page, "wf-agent").selectOption("cursor");
  await flowNode(page, "a").click();
  await expect(tid(page, "node-model")).toHaveAttribute("data-adapter", "cursor");
  await expect(tid(page, "node-model")).toHaveAttribute("data-loaded", "true");
  const cursor = await tid(page, "node-model").locator("option").evaluateAll((os) => os.map((o) => [(o as HTMLOptionElement).value, o.textContent]));
  expect(cursor).toEqual([["", "CLI default"], ["auto", "auto"], ["gpt-5", "gpt-5"], ["sonnet-4.5", "sonnet-4.5"], ["haiku", "haiku (not offered by cursor)"]]);
  // A CLI that is not installed offers nothing but its default, and says why.
  await wfTab(page);
  await tid(page, "wf-agent").selectOption("codex");
  await flowNode(page, "a").click();
  await expect(tid(page, "node-model")).toHaveAttribute("data-loaded", "true");
  await expect(tid(page, "side-panel")).toContainText("CLI not installed");

  // The inner node of a map has the same dropdown; a model from an imported file is kept even if the CLI does not list it.
  await newWorkflow(page, "legacy");
  await importYaml(page, "name: legacy\nnodes:\n  - id: each\n    type: map\n    over: [1]\n    node: { type: agent, prompt: 'x {{item}}', model: claude-old-1 }\n");
  await flowNode(page, "each").click();
  await expect(tid(page, "inner-model")).toHaveAttribute("data-loaded", "true");
  await expect(tid(page, "inner-model")).toHaveValue("claude-old-1");
  await expect(tid(page, "inner-model").locator("option:checked")).toHaveText("claude-old-1 (not offered by claude-code)");
  await tid(page, "inner-model").selectOption("opus");
  await wfTab(page);
  await tid(page, "wf-base-dir").fill(chief.dir);
  await saved(page, "legacy", 1);
  expect((await srv.api("GET", "/api/workflows/legacy")).body.definition.nodes[0].node.model).toBe("opus");
});

test("E9.6-3 the working copy is stored in chief's database, not in the browser", async ({ boot, page, browser }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  // No name yet, so this is not a workflow; it exists only as the working copy.
  await drop(page, "palette-agent", 320, 180);
  await tid(page, "node-id").fill("draft-node");
  await tid(page, "node-prompt").fill("Typed in the first browser.");
  await blocked(page);
  expect(await drafts(page, srv)).toEqual(["designer:__new__"]);

  // Nothing is kept in browser storage.
  expect(await page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length)).toBe(0);
  const stored = (await srv.api("GET", "/api/drafts")).body["designer:__new__"];
  expect(stored.definition.nodes).toEqual([expect.objectContaining({ id: "draft-node", prompt: "Typed in the first browser." })]);

  // A different browser (no shared storage, no cookies) sees the same working copy.
  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await second.goto(srv.url + "/#/designer");
    await expect(tid(second, "flow-node-draft-node")).toBeVisible();
    await flowNode(second, "draft-node").click();
    await expect(tid(second, "node-prompt")).toHaveValue("Typed in the first browser.");
    // Removing the step there removes it for everyone: the working copy is shared, and nothing is kept in a browser.
    await tid(second, "node-delete").click();
    await expect(tid(second, "canvas-empty")).toBeVisible();
    expect(await drafts(second, srv)).toEqual([]);
  } finally { await other.close(); }
  await page.reload();
  await expect(tid(page, "canvas-empty")).toBeVisible();
  await expect(tid(page, "draft-notice")).toHaveCount(0);
});

const storedDraft = async (page: Page, srv: Server, key = "designer:__new__") => {
  await page.waitForFunction(() => !(window as any).__chiefDraftWrites);
  return (await srv.api("GET", "/api/drafts")).body[key]?.definition as { nodes: any[]; edges: any[] } | undefined;
};

test("E9.7-1 every drop, move, connection and deletion on the canvas is stored in the database at once", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "autosave-status")).toHaveAttribute("data-state", "empty");
  expect(await storedDraft(page, srv)).toBeUndefined();

  // Drop: no typing, no Save.
  await drop(page, "palette-agent", 300, 120);
  let d = (await storedDraft(page, srv))!;
  expect(d.nodes.map((n) => n.id)).toEqual(["agent"]);
  // (Without a name it is not a workflow yet; the canvas itself is stored all the same.)
  await blocked(page);
  await expect(tid(page, "autosave-status")).toContainText("Your changes are stored");
  await drop(page, "palette-gate", 300, 380);
  d = (await storedDraft(page, srv))!;
  expect(d.nodes.map((n) => n.id)).toEqual(["agent", "gate"]);

  // Move a node with the mouse.
  const before = d.nodes[0].position;
  const box = (await flowNode(page, "agent").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2 + 30, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await storedDraft(page, srv))!.nodes[0].position.x).toBeGreaterThan(before.x + 80);
  const moved = (await storedDraft(page, srv))!.nodes[0].position;

  // Connect.
  await expect(async () => {
    await connect(page, "agent", "gate");
    await expect(page.locator(".react-flow__edge")).toHaveCount(1, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  expect((await storedDraft(page, srv))!.edges).toEqual([{ from: "agent", to: "gate" }]);

  // Refresh: the canvas is exactly as it was left, positions included.
  await refresh(page);
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  d = (await storedDraft(page, srv))!;
  expect(d.nodes[0].position).toEqual(moved);
  expect(d.edges).toEqual([{ from: "agent", to: "gate" }]);
  await expect(tid(page, "runs-first-agent")).toBeVisible();

  // Delete the connection, then a node. (The connection is selected by its own element: where its middle
  // falls on screen depends on the zoom, and a node may lie on top of it.)
  await page.locator(".react-flow__edge").first().dispatchEvent("click");
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  expect((await storedDraft(page, srv))!.edges).toEqual([]);
  await flowNode(page, "gate").click();
  await tid(page, "node-delete").click();
  await expect(tid(page, "flow-node-gate")).toHaveCount(0);
  expect((await storedDraft(page, srv))!.nodes.map((n) => n.id)).toEqual(["agent"]);

  // Emptying the canvas again leaves nothing behind in the database.
  await flowNode(page, "agent").click();
  await tid(page, "node-delete").click();
  await expect(tid(page, "canvas-empty")).toBeVisible();
  expect(await storedDraft(page, srv)).toBeUndefined();
  await expect(tid(page, "autosave-status")).toHaveAttribute("data-state", "empty");
});

test("E9.7-2 canvas changes to an existing workflow update the workflow itself at once", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: flow\nnodes:\n  - { id: a, type: agent, prompt: first, position: { x: 100, y: 60 } }\n  - { id: b, type: agent, prompt: second, position: { x: 100, y: 300 } }\n");
  const srv = await boot();
  await page.goto(srv.url + "/#/designer/flow");
  await expect(tid(page, "flow-node-a")).toBeVisible();
  await saved(page, "flow", 1);

  // A connection drawn with the mouse is in the workflow without any Save.
  await expect(async () => {
    await connect(page, "a", "b");
    await expect(page.locator(".react-flow__edge")).toHaveCount(1, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await expect.poll(async () => (await srv.api("GET", "/api/workflows/flow")).body.definition.edges).toEqual([{ from: "a", to: "b" }]);
  await saved(page, "flow", 1);
  expect(await storedDraft(page, srv, "designer:flow")).toBeUndefined();
  // And that is what runs.
  const id = (await srv.api("POST", "/api/runs", { workflow: "flow" })).body.run.id;
  await chief.until(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run.status === "completed");
  expect(chief.calls().map((c) => c.prompt.split("\n")[0])).toEqual(["first", "second"]);

  // A change that is not valid yet is kept, flagged here and on the Runs page, and does not touch the workflow.
  await flowNode(page, "a").click();
  await tid(page, "node-prompt").fill("");
  await blocked(page);
  expect((await storedDraft(page, srv, "designer:flow"))!.nodes[0].prompt ?? "").toBe("");
  expect((await srv.api("GET", "/api/workflows/flow")).body.definition.nodes[0].prompt).toBe("first");
  await tid(page, "nav-runs").click();
  await tid(page, "new-run-workflow").selectOption("flow");
  await expect(tid(page, "new-run-unsaved")).toContainText("not a valid workflow yet");

  await page.goto(srv.url + "/#/designer/flow");
  await flowNode(page, "a").click();
  await tid(page, "node-prompt").fill("first, edited");
  await saved(page, "flow", 2);
  expect(await storedDraft(page, srv, "designer:flow")).toBeUndefined();
  await tid(page, "nav-runs").click();
  await expect(tid(page, "new-run-workflow")).toHaveValue("flow");
  await expect(tid(page, "new-run-unsaved")).toHaveCount(0);
});

test("E9.8-1 a selected connection is clearly highlighted and can be deleted", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  // The canvas restores its draft on load; importing before that has settled is a race
  // (the restored empty canvas can replace the imported workflow).
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  await importYaml(page, "name: pick-edge\nnodes:\n  - { id: first, type: agent, prompt: a }\n  - { id: second, type: agent, prompt: b }\n  - { id: third, type: agent, prompt: c }\nedges: [first -> second, second -> third]\n");
  /** The canvas's working copy: the designer keeps it under the workflow's name once it has one. */
  const draft = async () => {
    await page.waitForFunction(() => !(window as any).__chiefDraftWrites);
    const all = (await srv.api("GET", "/api/drafts")).body as any;
    return (all["designer:pick-edge"] ?? all["designer:__new__"])?.definition as { edges: any[] } | undefined;
  };
  const edges = page.locator(".react-flow__edge");
  await expect(edges).toHaveCount(2);
  const look = (i: number) => edges.nth(i).locator(".react-flow__edge-path").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { stroke: cs.stroke, width: parseFloat(cs.strokeWidth), marker: el.getAttribute("marker-end") };
  });
  const idle = await look(0);
  expect(idle.stroke).toBe("rgb(51, 65, 85)");
  expect(idle.width).toBe(2);
  await expect(tid(page, "edge-panel")).toHaveCount(0);

  // Click the first arrow: it, and only it, changes colour and thickness, arrowhead included.
  await edges.nth(0).click({ force: true });
  await expect(edges.nth(0)).toHaveClass(/selected/);
  const picked = await look(0);
  expect(picked.stroke).toBe("rgb(37, 99, 235)");
  expect(picked.width).toBe(4);
  expect(picked.marker).not.toBe(idle.marker);
  const markerId = picked.marker!.match(/#([^'")]+)/)![1];
  expect(await page.locator(`marker[id="${markerId}"] polyline`).evaluate((el) => getComputedStyle(el).fill)).toBe("rgb(37, 99, 235)");
  expect(await look(1)).toEqual(idle);
  // The side panel says which connection it is.
  await expect(tid(page, "edge-label")).toHaveText("first → second");
  await expect(tid(page, "edge-panel")).toContainText("“second” runs after “first” has completed.");

  // Clicking the empty canvas clears the selection and the highlight.
  await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } });
  await expect(tid(page, "edge-panel")).toHaveCount(0);
  expect(await look(0)).toEqual(idle);

  // Selecting the other arrow moves the highlight.
  await edges.nth(1).click({ force: true });
  await expect(tid(page, "edge-label")).toHaveText("second → third");
  expect((await look(1)).stroke).toBe("rgb(37, 99, 235)");
  expect((await look(0)).stroke).toBe("rgb(51, 65, 85)");

  // Delete it from the panel; the other one with the keyboard. Both deletions reach the database.
  await tid(page, "edge-delete").click();
  await expect(edges).toHaveCount(1);
  await expect.poll(async () => (await draft())?.edges).toEqual([{ from: "first", to: "second" }]);
  await expect(tid(page, "edge-panel")).toHaveCount(0);
  await edges.nth(0).click({ force: true });
  await expect(tid(page, "edge-label")).toHaveText("first → second");
  await page.keyboard.press("Backspace");
  await expect(edges).toHaveCount(0);
  await expect.poll(async () => (await draft())?.edges).toEqual([]);
  // Selecting a node shows the node, not a connection.
  await flowNode(page, "first").click();
  await expect(tid(page, "node-id")).toHaveValue("first");
  await expect(tid(page, "edge-panel")).toHaveCount(0);
});

test("E9.9-1 the page says so when the server behind it is older", async ({ boot, page }) => {
  const srv = await boot();
  // A current server: no banner, and the model list loads.
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  await expect(tid(page, "stale-server")).toHaveCount(0);
  expect((await srv.api("GET", "/api/meta")).body.api).toBeGreaterThanOrEqual(9);

  // The same page against a server from before the model list existed: it has no API level and no /api/models.
  await page.route("**/api/meta", async (route) => {
    const res = await route.fetch();
    const { api: _api, ...old } = await res.json();
    await route.fulfill({ response: res, json: old });
  });
  await page.route("**/api/models*", (route) => route.fulfill({ status: 404, json: { error: "not found" } }));
  await page.reload();
  await expect(tid(page, "stale-server")).toContainText("The chief server that is running is older than this page.");
  await expect(tid(page, "stale-server")).toContainText("chief serve");
  await drop(page, "palette-agent", 320, 180);
  await expect(tid(page, "node-model")).toHaveAttribute("data-loaded", "true");
  await expect(tid(page, "node-model")).toHaveAttribute("data-count", "0");
  // Not an empty list that looks normal: the reason is shown next to the field.
  await expect(tid(page, "node-model-error")).toContainText("The model list could not be read from the chief server (not found)");
  await expect(tid(page, "node-model-error")).toContainText("restart chief serve");
});

test("E9.9-2 a node can use another agent CLI, and its model list follows", async ({ chief, boot, page }) => {
  const srv = await boot({ env: { CHIEF_CURSOR_BIN: FAKE_CURSOR } });
  await page.goto(srv.url + "/#/designer");
  const values = () => tid(page, "node-model").locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));

  await drop(page, "palette-agent", 320, 120);
  await tid(page, "node-id").fill("with-cursor");
  await tid(page, "node-prompt").fill("one");
  await expect(tid(page, "node-agent")).toHaveValue("");
  await expect(tid(page, "node-agent").locator("option")).toHaveText(["workflow’s (claude-code)", "claude-code", "codex", "cursor", "antigravity", "opencode", "hermes"]);
  await expect(tid(page, "node-model")).toHaveAttribute("data-count", "3");
  expect(await values()).toEqual(["", "opus", "sonnet", "haiku"]);
  await tid(page, "node-model").selectOption("opus");

  // Switching the node to Cursor: Cursor's models, and the Claude model no longer applies.
  await tid(page, "node-agent").selectOption("cursor");
  await expect(tid(page, "node-model")).toHaveAttribute("data-adapter", "cursor");
  await expect(tid(page, "node-model")).toHaveAttribute("data-count", "3");
  expect(await values()).toEqual(["", "auto", "gpt-5", "sonnet-4.5"]);
  await expect(tid(page, "node-model")).toHaveValue("");
  await tid(page, "node-model").selectOption("gpt-5");

  // Another node keeps the workflow's CLI.
  await drop(page, "palette-agent", 320, 380);
  await tid(page, "node-id").fill("with-claude");
  await tid(page, "node-prompt").fill("two");
  await expect(tid(page, "node-model")).toHaveAttribute("data-adapter", "claude-code");
  await tid(page, "node-model").selectOption("haiku");

  await wfTab(page);
  await tid(page, "wf-name").fill("mixed");
  await tid(page, "wf-base-dir").fill(chief.dir);
  await saved(page, "mixed", 1);
  const nodes = (await srv.api("GET", "/api/workflows/mixed")).body.definition.nodes;
  expect(nodes[0]).toMatchObject({ id: "with-cursor", agent: "cursor", model: "gpt-5" });
  expect(nodes[1]).toMatchObject({ id: "with-claude", model: "haiku" });
  expect(nodes[1].agent).toBeUndefined();
  // And that is what runs: each node is handed to its own CLI with its own model.
  const id = (await srv.api("POST", "/api/runs", { workflow: "mixed" })).body.run.id;
  await chief.until(async () => (await srv.api("GET", `/api/runs/${id}`)).body.run.status === "completed");
  expect(chief.calls().map((c) => [c.cli ?? "claude", c.argv[c.argv.indexOf("--model") + 1]])).toEqual([["cursor", "gpt-5"], ["claude", "haiku"]]);
});

test("E9.10-1 there is no Save button: a workflow built in the designer exists as soon as it is valid", async ({ chief, boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await expect(page.getByRole("button", { name: /save|validate/i })).toHaveCount(0);
  await expect(tid(page, "autosave-status")).toContainText("everything is saved automatically");

  await dropAgentWith(page, "slack", 320, 140);
  await tid(page, "node-id").fill("plan");
  await tid(page, "node-prompt").fill(`Plan the day ${fake({ output: { ok: true } })}`);
  await tid(page, "node-model").selectOption("sonnet");
  await wfTab(page);
  await tid(page, "wf-name").fill("auto");
  await tid(page, "wf-inputs").fill('{"who": "me"}');
  await tid(page, "wf-base-dir").fill(chief.dir);
  await saved(page, "auto", 1);
  await expect(page).toHaveURL(/#\/designer\/auto$/);
  const def = (await srv.api("GET", "/api/workflows/auto")).body.definition;
  expect(def).toMatchObject({ name: "auto", inputs: { who: "me" }, nodes: [{ id: "plan", model: "sonnet", mcp: ["slack"] }] });

  // Each further change, of any kind, is in the stored workflow shortly after it is made.
  const node = async () => (await srv.api("GET", "/api/workflows/auto")).body.definition.nodes[0];
  await stepTab(page);
  await tid(page, "node-model").selectOption("haiku");
  await expect.poll(async () => (await node()).model).toBe("haiku");
  await tid(page, "node-mcp-atlassian").check();
  await expect.poll(async () => (await node()).mcp).toEqual(["slack", "atlassian"]);
  await tid(page, "node-tools").selectOption("read-only");
  await expect.poll(async () => (await node()).tools).toBe("read-only");
  await wfTab(page);
  // A workflow-level change is stored the same way: no Save button, and nothing waits for one.
  await tid(page, "wf-inputs").fill('{"who": "you"}');
  await expect.poll(async () => (await srv.api("GET", "/api/workflows/auto")).body.definition.inputs).toEqual({ who: "you" });
  await saved(page, "auto", 1);

  // Run uses exactly what is on the canvas, with nothing to save first.
  await stepTab(page);
  await tid(page, "node-model").selectOption("opus");
  await tid(page, "btn-run").click();
  await expect(page).toHaveURL(/#\/runs\/1$/);
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect(chief.calls()[0].argv[chief.calls()[0].argv.indexOf("--model") + 1]).toBe("opus");

  // The Settings page has no Save button either.
  await tid(page, "nav-settings").click();
  await expect(tid(page, "setting-default-adapter")).toBeVisible();
  await expect(page.getByRole("button", { name: /save/i })).toHaveCount(0);
});

test("E9.10-2 typing a new name renames the workflow instead of creating copies", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: taken\nnodes:\n  - { id: z, type: agent, prompt: other }\n");
  const srv = await boot();
  const names = async () => (await srv.api("GET", "/api/workflows")).body.map((w: any) => w.name);
  await page.goto(srv.url + "/#/designer");
  await drop(page, "palette-agent", 320, 160);
  await tid(page, "node-prompt").fill("hello");
  await wfTab(page);
  await tid(page, "wf-base-dir").fill(chief.dir);
  // Typed slowly, one character at a time: every intermediate name is the same workflow.
  await tid(page, "wf-name").pressSequentially("alpha", { delay: 250 });
  await saved(page, "alpha", 1);
  expect(await names()).toEqual(["alpha", "taken"]);
  const run = (await srv.api("POST", "/api/runs", { workflow: "alpha" })).body.run.id;
  await chief.until(async () => (await srv.api("GET", `/api/runs/${run}`)).body.run.status === "completed");

  await tid(page, "wf-name").fill("beta");
  await saved(page, "beta", 1);
  await expect(page).toHaveURL(/#\/designer\/beta$/);
  expect(await names()).toEqual(["beta", "taken"]);
  // Its runs came along.
  expect((await srv.api("GET", "/api/runs?workflow=beta")).body.map((r: any) => r.id)).toEqual([run]);
  expect((await srv.api("GET", "/api/workflows/alpha")).status).toBe(404);

  // A name that belongs to another workflow is refused; nothing is overwritten.
  await tid(page, "wf-name").fill("taken");
  await blocked(page);
  await expect(tid(page, "designer-error")).toContainText('a workflow named "taken" already exists');
  expect(await names()).toEqual(["beta", "taken"]);
  expect((await srv.api("GET", "/api/workflows/taken")).body.definition.nodes[0].id).toBe("z");
  await tid(page, "wf-name").fill("gamma");
  await saved(page, "gamma", 1);
  expect(await names()).toEqual(["gamma", "taken"]);
});

test("E9.12-3 the designer palette lists every server the agent CLI has, even when the list arrives slowly", async ({ boot, page }) => {
  const srv = await boot({ env: { FAKE_CLAUDE_MCP_SLOW: "1" } });
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(tid(page, "palette-empty")).toHaveCount(0);
  // Connected servers first, then the ones that still need signing in.
  const rows = page.locator('[data-testid^="palette-mcp-"][data-status]');
  expect(await rows.evaluateAll((els) => els.map((e) => [e.getAttribute("data-testid")!.replace("palette-mcp-", ""), e.getAttribute("data-status")]))).toEqual([
    ["atlassian", "connected"], ["github-custom", "connected"], ["google-drive", "connected"], ["slack", "connected"], ["notion", "needs-auth"],
  ]);
  expect((await srv.api("GET", "/api/mcp")).body).toHaveLength(5);
  // And they are usable: an agent node can be given one in its panel.
  await dropAgentWith(page, "google-drive", 320, 180);
  await expect(tid(page, "node-mcp-google-drive")).toBeChecked();
});

test("E9.11-1 settings that need explaining have a help tooltip with an example", async ({ chief, boot, page }) => {
  // A workflow that uses an input, so the Runs page shows the inputs editor whose "?" this case asks about
  // (the editor only exists when there is something to fill in — 15.49).
  chief.importWorkflow("name: asked\ninputs: { who: nobody }\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'hi {{inputs.who}}' }\n");
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  const text = (id: string) => tid(page, `help-text-${id}`);

  // The working directory: optional, and what it is for.
  await wfTab(page);
  await expect(text("wf-base-dir")).toHaveCount(0);
  // The header is still settling while the page loads its lists (the "?" moves a little); hover again if it moved away.
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  await expect(async () => {
    await tid(page, "help-wf-base-dir").hover();
    await expect(text("wf-base-dir")).toContainText("Optional.", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(text("wf-base-dir")).toContainText("gives it its own folder");
  await expect(text("wf-base-dir")).toContainText("script paths are relative to it");
  await expect(text("wf-base-dir")).toContainText("Example");
  await expect(text("wf-base-dir").locator("code")).toHaveText("~/code/my-service");
  await page.mouse.move(5, 300);
  await expect(text("wf-base-dir")).toHaveCount(0);

  // A click opens and closes it, and does not put the cursor into the field next to it.
  await expect(async () => {
    if (!(await text("wf-inputs").isVisible())) await tid(page, "help-wf-inputs").click();
    await expect(text("wf-inputs").locator("code")).toContainText('"planner": { "prlink": "https://github.com/my-org/app/pull/42" }', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("help-wf-inputs");
  // It stays while pinned by the click, also when the pointer moves away; a second click lets it go.
  await page.mouse.move(5, 300);
  await expect(text("wf-inputs")).toBeVisible();
  await tid(page, "help-wf-inputs").click();
  await page.mouse.move(5, 300);
  await expect(text("wf-inputs")).toHaveCount(0);
  // Keyboard: tabbing onto it shows it, Escape hides it.
  // Agent CLI has no "?" (asked 2026-11-22: the label and the dropdown already say it), so the tab from Working
  // directory reaches its dropdown, and then the next "?" in the panel.
  await tid(page, "wf-base-dir").focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("wf-agent");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("help-wf-inputs");
  await expect(tid(page, "help-wf-agent")).toHaveCount(0);
  // The name has no "?" any more: its example is the placeholder and its rule is the line under it
  // (reported 2026-11-21). The fields that need more than a line keep theirs.
  await expect(tid(page, "help-wf-name")).toHaveCount(0);
  await expect(tid(page, "wf-name")).toHaveAttribute("placeholder", "daily-triage");
  for (const id of ["wf-base-dir"]) await expect(tid(page, `help-${id}`)).toBeVisible();

  // Node panel, for each kind of node. The tooltip is fully on screen even at the right edge of the side panel.
  const inViewport = async (id: string) => {
    // Short, because a bubble that has gone is a hover to repeat, not a wait: on a loaded runner the
    // page above it is still settling (the provider cards and the doctor fill in), which moves the "?"
    // out from under the pointer and closes the bubble it had opened. `shows` retries with a new hover.
    const box = await text(id).boundingBox({ timeout: 2000 });
    expect(box, `the tooltip for ${id} is open`).not.toBeNull();
    const size = page.viewportSize()!;
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);
  };
  const shows = async (id: string, part: string | RegExp) => {
    // The side panel can still be settling (the save status and the check result appear above the
    // fields a moment after a drop), which moves the "?" under the pointer; hover again if so. The
    // position is checked inside the retry too: the tooltip is only there while the pointer is on it.
    await expect(async () => {
      await tid(page, `help-${id}`).hover();
      await expect(text(id)).toContainText(part, { timeout: 1000 });
      await inViewport(id);
    }).toPass({ timeout: 15_000 });
    await page.mouse.move(5, 300);
  };
  await drop(page, "palette-agent", 300, 120);
  await shows("prompt", "What the agent should do");
  await shows("mcp", "Default: every server that CLI is connected to");
  await shows("model", "The list comes from the agent CLI itself");
  await shows("tools", "read-only");
  await shows("output-schema", '"summary": "string"');
  await shows("compensate-prompt", "Used only when you revert a run");
  // The step's Id needs no "?": its rule and the placeholder it appears in are printed under the field,
  // and they follow the field (reported 2026-11-21: "the hint text should follow the same standard").
  await expect(tid(page, "help-node-id")).toHaveCount(0);
  await expect(tid(page, "node-id").locator("xpath=../span[contains(@class,'text-slate-500')]")).toContainText("Lower-case letters, digits and dashes");
  await shows("agent", "Use a different agent CLI for this step");
  await shows("irreversible", "cannot be taken back");

  await drop(page, "palette-script", 300, 300);
  await shows("run", "scripts/summarise.py");
  await shows("sandbox-network", "no network access");
  await shows("sandbox-write", "~/reports");
  await shows("sandbox-env", "GITHUB_TOKEN");
  await shows("timeout", "90s");

  // Inside the canvas next to the sidebar at the default 1280 px window (the canvas is about 460 px wide there).
  await drop(page, "palette-gate", 380, 120);
  await shows("kind", "ask: you describe what to ask");
  await shows("gate-prompt", "At the gate an agent reads it with the previous step's result");
  await tid(page, "node-kind").selectOption("select");
  await shows("from", "{{nodes.plan.output.items}}");
  await shows("modes", "one-by-one");

  await drop(page, "palette-map", 380, 440);
  await shows("over", "{{item}}");
  await shows("max-parallel", "how many elements run at the same time");
  await shows("on-error", "continue: finish the others");

  // New-run form and Settings.
  await tid(page, "nav-runs").click();
  await shows("new-run-inputs", "The inputs for this run");
  await tid(page, "nav-settings").click();
  await shows("setting-workspace-dir", "one subfolder per workflow");
  // The output size limit's "?" is gone (E15.40-1): its hint under the field says it.
  // The path tooltip belongs to the card of the CLI that is open, and names THAT CLI's own program —
  // not a copy of the first CLI's (what they all used to say: task 15.12).
  await expect(tid(page, "providers")).toBeVisible();
  await page.waitForTimeout(1200); // the CLIs are looked for (one `--version` each)
  const BINARY: Record<string, string> = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent", antigravity: "agy", opencode: "opencode", hermes: "hermes" };
  for (const adapter of Object.keys(BINARY)) {
    await tid(page, `provider-${adapter}`).click();
    const id = `setting-path-${adapter}`;
    await tid(page, `help-${id}`).hover();
    await expect(text(id)).toBeVisible();
    await expect(text(id)).toContainText(BINARY[adapter]);
    if (adapter !== "claude-code") await expect(text(id)).not.toContainText("/opt/homebrew/bin/claude");
    await page.mouse.move(5, 300);
    await expect(text(id)).toHaveCount(0);
  }
  // Every field that needs more than its own hint has a "?" (E15.40-1 covers the two that do not).
  await page.mouse.move(5, 300);
});

test("E9.13-1 MCP servers are a status list, not draggable blocks", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  const slack = tid(page, "palette-mcp-slack");
  const agent = tid(page, "palette-agent");

  // A server row is not draggable and does not look like a block: no card border, no grab cursor, a status dot.
  await expect(slack).toHaveAttribute("draggable", "false");
  await expect(agent).toHaveAttribute("draggable", "true");
  const look = (el: Element) => { const cs = getComputedStyle(el); return { cursor: cs.cursor, border: cs.borderTopWidth, background: cs.backgroundColor, tag: el.tagName }; };
  const row = await slack.evaluate(look), block = await agent.evaluate(look);
  expect(row).toMatchObject({ cursor: "default", border: "0px", tag: "LI" });
  expect(block).toMatchObject({ cursor: "grab", border: "1px" });
  expect(row.background).not.toBe(block.background);
  await expect(slack.locator("span.rounded-full")).toHaveCount(1);
  // The blocks come first, and the list says what it is.
  expect((await agent.boundingBox())!.y).toBeLessThan((await slack.boundingBox())!.y);
  await expect(tid(page, "palette-mcp-list")).toContainText("Not blocks");

  // Dragging or double-clicking a server adds nothing.
  await slack.dragTo(tid(page, "canvas"), { targetPosition: { x: 300, y: 200 } }).catch(() => {});
  await slack.dblclick();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await expect(tid(page, "canvas-empty")).toBeVisible();

  // Connected servers are shown; the others are folded away with a count.
  await expect(tid(page, "palette-mcp-notion")).toBeHidden();
  await expect(tid(page, "palette-mcp-unavailable").locator("summary")).toHaveText("Not connected (1)");
  await tid(page, "palette-mcp-unavailable").locator("summary").click();
  await expect(tid(page, "palette-mcp-notion")).toBeVisible();
  await expect(tid(page, "palette-mcp-notion")).toContainText("needs auth");

  // Blocks still drag. The list marks the servers the selected node may use.
  await drop(page, "palette-agent", 320, 180);
  // A new agent node may use every connected server (not the one that needs signing in).
  await expect(slack).toHaveAttribute("data-used", "true");
  await expect(tid(page, "palette-mcp-atlassian")).toHaveAttribute("data-used", "true");
  await expect(tid(page, "palette-mcp-notion")).toHaveAttribute("data-used", "false");
  await tid(page, "node-mcp-all").uncheck();
  await expect(slack).toHaveAttribute("data-used", "false");
  await tid(page, "node-mcp-slack").check();
  await expect(slack).toHaveAttribute("data-used", "true");
  await expect(tid(page, "palette-mcp-atlassian")).toHaveAttribute("data-used", "false");
  await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } });
  await expect(slack).toHaveAttribute("data-used", "false");
  // What the list is, said in the line under its heading rather than in a tooltip beside it (asked 2026-11-22).
  await expect(tid(page, "help-mcp-list")).toHaveCount(0);
  await expect(tid(page, "palette-mcp-explained")).toContainText("Not blocks");
  expect((await srv.api("GET", "/api/mcp")).body).toHaveLength(5);
});

test("E9.14-2 the node panel: all connected servers by default, or only the ones ticked", async ({ chief, boot, page }) => {
  const srv = await boot();
  const stored = async () => (await srv.api("GET", "/api/workflows/scope")).body.definition.nodes[0];
  await page.goto(srv.url + "/#/designer");
  await drop(page, "palette-agent", 320, 160);
  await tid(page, "node-id").fill("helper");
  await tid(page, "node-prompt").fill("help me");
  await wfTab(page);
  await tid(page, "wf-name").fill("scope");
  await tid(page, "wf-base-dir").fill(chief.dir);
  await saved(page, "scope", 1);

  // Default: all connected servers, the agent decides. Nothing about MCP is stored on the node.
  await stepTab(page);
  await expect(tid(page, "node-mcp-all")).toBeChecked();
  await expect(tid(page, "side-panel")).toContainText("All connected servers (the agent decides which to use)");
  expect("mcp" in (await stored())).toBe(false);
  await srv.api("POST", "/api/runs", { workflow: "scope" });
  await chief.until(() => chief.calls().length === 1);
  const allowed = (i: number) => { const a = chief.calls()[i].argv; const out: string[] = []; for (let k = a.indexOf("--allowedTools") + 1; k > 0 && k < a.length && !a[k].startsWith("--"); k++) out.push(a[k]); return out.sort(); };
  expect(allowed(0)).toEqual(["mcp__claude_ai_Atlassian", "mcp__claude_ai_GitHub_Custom", "mcp__claude_ai_Google_Drive", "mcp__claude_ai_Slack"]);

  // Restricted to none, then to two.
  await tid(page, "node-mcp-all").uncheck();
  await expect(tid(page, "node-mcp")).toContainText("this node uses no MCP server");
  await expect.poll(async () => (await stored()).mcp).toEqual([]);
  await tid(page, "node-mcp-slack").check();
  await tid(page, "node-mcp-google-drive").check();
  await expect.poll(async () => (await stored()).mcp).toEqual(["slack", "google-drive"]);
  await expect(tid(page, "flow-node-helper")).toContainText("slack, google-drive");
  await expect(tid(page, "palette-mcp-slack")).toHaveAttribute("data-used", "true");
  await expect(tid(page, "palette-mcp-atlassian")).toHaveAttribute("data-used", "false");
  await saved(page, "scope");
  await srv.api("POST", "/api/runs", { workflow: "scope" });
  await chief.until(() => chief.calls().length === 2);
  expect(allowed(1)).toEqual(["mcp__claude_ai_Google_Drive", "mcp__claude_ai_Slack"]);

  // Back to all: the list is gone from the stored node again.
  await tid(page, "node-mcp-all").check();
  await expect(tid(page, "node-mcp")).toHaveCount(0);
  await expect.poll(async () => "mcp" in (await stored())).toBe(false);
  await expect(tid(page, "flow-node-helper")).toContainText("all MCP servers");
});

test("E9.15-1 the server list says which agent CLI is connected to which server", async ({ chief, boot, page }) => {
  // Codex, Cursor, Antigravity and OpenCode each with their own servers, next to Claude Code's.
  mkdirSync(chief.env.CODEX_HOME, { recursive: true });
  writeFileSync(join(chief.env.CODEX_HOME, "config.toml"), '[mcp_servers.github]\nurl = "https://api.githubcopilot.com/mcp"\n\n[mcp_servers.old_thing]\ncommand = "old"\nenabled = false\n');
  mkdirSync(chief.env.CURSOR_CONFIG_HOME, { recursive: true });
  writeFileSync(join(chief.env.CURSOR_CONFIG_HOME, "mcp.json"), JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } } }));
  writeFileSync(chief.env.FAKE_AGY_MCP, JSON.stringify({ mcpServers: { files: { command: "npx", args: ["files-mcp"] } } }));
  writeFileSync(chief.env.OPENCODE_CONFIG, JSON.stringify({ mcp: { context7: { type: "local", command: ["npx", "c7"] }, broken: { type: "remote", url: "https://x.invalid", fake_status: "failed" } } }));
  const srv = await boot({ env: { CHIEF_CODEX_BIN: FAKE_CODEX, CHIEF_CURSOR_BIN: FAKE_CURSOR, CHIEF_ANTIGRAVITY_BIN: FAKE_ANTIGRAVITY, CHIEF_OPENCODE_BIN: FAKE_OPENCODE } });
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  const rows = (agent: string) => tid(page, `palette-mcp-agent-${agent}`).locator("[data-status]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-testid")!.replace("palette-mcp-", ""), e.getAttribute("data-status"), e.getAttribute("data-agent")]));

  // One named group per agent, with that agent's servers.
  await expect(tid(page, "palette-mcp-agent-name-claude-code")).toHaveText("Claude Code");
  await expect(tid(page, "palette-mcp-agent-claude-code")).toContainText("4 connected");
  expect(await rows("claude-code")).toEqual([["atlassian", "connected", "claude-code"], ["github-custom", "connected", "claude-code"], ["google-drive", "connected", "claude-code"], ["slack", "connected", "claude-code"], ["notion", "needs-auth", "claude-code"]]);
  await expect(tid(page, "palette-mcp-agent-name-codex")).toHaveText("Codex");
  expect(await rows("codex")).toEqual([["github", "configured", "codex"], ["old-thing", "disabled", "codex"]]);
  await expect(tid(page, "palette-mcp-agent-name-cursor")).toHaveText("Cursor");
  expect(await rows("cursor")).toEqual([["linear", "configured", "cursor"]]);
  await expect(tid(page, "palette-mcp-agent-name-antigravity")).toHaveText("Antigravity");
  expect(await rows("antigravity")).toEqual([["files", "configured", "antigravity"]]);
  await expect(tid(page, "palette-mcp-agent-name-opencode")).toHaveText("OpenCode");
  // OpenCode reports a live status: a failed server is listed as not connected.
  expect(await rows("opencode")).toEqual([["context7", "connected", "opencode"], ["broken", "failed", "opencode"]]);
  // The groups are in a fixed order, and each row's tooltip names its agent.
  expect(await page.locator('[data-testid^="palette-mcp-agent-name-"]').allTextContents()).toEqual(["Claude Code", "Codex", "Cursor", "Antigravity", "OpenCode"]);
  await expect(tid(page, "palette-mcp-agent-cursor").locator('[data-testid="palette-mcp-linear"]')).toHaveAttribute("title", /linear \(Cursor\): configured/);

  // A node is offered, and marked against, the servers of the agent that runs it.
  const used = (agent: string) => tid(page, `palette-mcp-agent-${agent}`).locator('[data-used="true"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("palette-mcp-", "")));
  await drop(page, "palette-agent", 320, 160);
  await expect(tid(page, "side-panel")).toContainText("MCP servers this node may use (from claude-code)");
  expect(await used("claude-code")).toEqual(["atlassian", "github-custom", "google-drive", "slack"]);
  expect(await used("codex")).toEqual([]);
  await tid(page, "node-agent").selectOption("codex");
  await expect(tid(page, "side-panel")).toContainText("MCP servers this node may use (from codex)");
  expect(await used("claude-code")).toEqual([]);
  expect(await used("codex")).toEqual(["github"]);
  await tid(page, "node-mcp-all").uncheck();
  await expect(page.locator('[data-testid="node-mcp"] [role="checkbox"]')).toHaveCount(2);
  await expect(tid(page, "node-mcp-github")).toBeVisible();
  await expect(tid(page, "node-mcp-slack")).toHaveCount(0);
  await tid(page, "node-mcp-github").check();
  expect(await used("codex")).toEqual(["github"]);
  await tid(page, "node-agent").selectOption("cursor");
  await tid(page, "node-mcp-all").check();
  expect(await used("cursor")).toEqual(["linear"]);
  expect(await used("codex")).toEqual([]);
});

test("E9.15-2 an agent CLI that is not installed is shown as such", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
  await expect(tid(page, "palette-mcp-agent-name-claude-code")).toHaveText("Claude Code");
  await expect(tid(page, "palette-mcp-agent-codex")).toHaveText("Codex: no servers (not installed)");
  await expect(tid(page, "palette-mcp-agent-cursor")).toHaveText("Cursor: no servers (not installed)");
  await expect(tid(page, "palette-mcp-agent-antigravity")).toHaveText("Antigravity: no servers (not installed)");
  await expect(tid(page, "palette-mcp-agent-opencode")).toHaveText("OpenCode: no servers (not installed)");
  await expect(tid(page, "palette-mcp-agent-hermes")).toHaveText("Hermes: no servers (not installed)");
  expect((await srv.api("GET", "/api/mcp")).body.every((s: any) => s.adapter === "claude-code")).toBe(true);
});

test("E9.16-1 every node shows its input and output on the run page", async ({ chief, boot, page }) => {
  chief.file("double.py", "import json,sys\nd=json.load(sys.stdin)\nprint(json.dumps({'doubled': d['n'] * 2}))\n");
  chief.importWorkflow(`
name: io
nodes:
  - { id: summarise, type: agent, mcp: [], prompt: 'Summarise the incident for the on-call team. ${fake({ output: { summary: "Database failover at 03:12", count: 21 } })}' }
  - { id: double, type: script, run: double.py, input: { n: "{{nodes.summarise.output.count}}" } }
  - { id: confirm, type: gate, kind: approve, message: "Send this to the channel?", value: "{{nodes.summarise.output.summary}}" }
  - { id: each, type: map, over: [alpha, beta], node: { type: agent, mcp: [], prompt: 'handle {{item}} ${fake({ output: { handled: true } })}' } }
edges: [summarise -> double, double -> confirm, confirm -> each]
`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "io" });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("waiting gate");
  const row = (node: string, item = "") => page.locator(`[data-testid^="node-run-"][data-node-id="${node}"][data-item="${item}"]`);
  const idOf = async (node: string, item = "") => { await showStep(page, node); return (await row(node, item).getAttribute("data-testid"))!.replace("node-run-", ""); };

  // Agent: the prompt as it was sent, and the result, visible without opening anything.
  const a = await idOf("summarise");
  await expect(tid(page, `node-in-${a}`)).toContainText("Summarise the incident for the on-call team.");
  await expect(tid(page, `node-out-${a}`)).toContainText('"summary": "Database failover at 03:12"');
  await expect(tid(page, `node-io-${a}`)).toContainText("Input: prompt sent to the agent");
  // Script: what it received on stdin, and what it printed.
  const s = await idOf("double");
  await expect(tid(page, `node-in-${s}`)).toContainText('"n": 21');
  await expect(tid(page, `node-out-${s}`)).toContainText('"doubled": 42');
  await expect(tid(page, `node-io-${s}`)).toContainText("Input: sent to the script");
  // Gate: what you were asked; no output yet.
  const g = await idOf("confirm");
  await expect(tid(page, `node-in-${g}`)).toContainText("Send this to the channel?");
  await expect(tid(page, `node-in-${g}`)).toContainText("Database failover at 03:12");
  await expect(tid(page, `node-out-${g}`)).toHaveText("(waiting for your answer)");

  await tid(page, "gate-value").fill("Database failover at 03:12, resolved.");
  await tid(page, "gate-approve").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  await expect(tid(page, `node-out-${g}`)).toContainText('"value": "Database failover at 03:12, resolved."');
  // Map children each show their own item, in the map's own tab (a child has no tab of its own).
  await showStep(page, "each");
  const c0 = await idOf("each-item", "0"), c1 = await idOf("each-item", "1");
  await expect(tid(page, `node-in-${c0}`)).toContainText("handle alpha");
  await expect(tid(page, `node-in-${c1}`)).toContainText("handle beta");
  await expect(tid(page, `node-out-${c1}`)).toContainText('"handled": true');

  // The compact view is cut short; clicking the node shows the full input, the answer and the output.
  await showStep(page, "summarise");
  await expect(tid(page, `node-in-${a}`)).not.toContainText("Output contract");
  await tid(page, `node-io-${a}`).click();
  await expect(tid(page, "node-input")).toContainText("Output contract (required by the orchestrator running you)");
  await tid(page, "node-output-json").click();
  await expect(tid(page, "node-output")).toContainText('"count": 21');
  await showStep(page, "confirm");
  await row("confirm").click();
  await expect(tid(page, "node-answer")).toContainText('"decision": "approve"');

  // The same is in the API.
  const d = (await srv.api("GET", "/api/runs/1")).body;
  // `appended_at` is where the orchestrator's instructions begin inside the prompt (a number, so not pinned here).
  expect(d.node_runs[0].io).toMatchObject({ input_kind: "prompt", input: chief.calls()[0].prompt, answer: null, reply: "Done." });
  expect(typeof d.node_runs[0].io.appended_at).toBe("number");
  expect(JSON.parse(d.node_runs[1].io.input)).toEqual({ n: 21 });
  expect(d.node_runs[2].io.input_kind).toBe("gate_question");
  expect(JSON.parse(d.node_runs[2].io.answer)).toMatchObject({ decision: "approve" });
});

test("E9.17-3 a gate described in plain words: designer, generated form, picks reach the next step", async ({ chief, boot, page }) => {
  const items = [{ id: 1, title: "Add an index" }, { id: 2, title: "Drop a table" }, { id: 3, title: "Backfill a column" }];
  const form = {
    title: "Which changes go to the database?", description: "Pick the ones the executor should apply.", submit_label: "Send to the executor",
    fields: [
      { id: "selected", type: "choose-many", label: "Changes", required: true, options: items.map((i) => ({ label: i.title, detail: `change #${i.id}`, value: i })) },
      { id: "note", type: "long-text", label: "Note for the executor" },
      { id: "urgent", type: "yes-no", label: "Urgent?" },
    ],
  };
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await drop(page, "palette-agent", 300, 100);
  await tid(page, "node-id").fill("plan");
  await tid(page, "node-prompt").fill(`List the changes ${fake({ output: { items } })}`);

  // A new gate asks for an instruction, not for a form type.
  await drop(page, "palette-gate", 300, 280);
  await tid(page, "node-id").fill("review");
  await expect(tid(page, "node-kind")).toHaveValue("ask");
  await expect(tid(page, "side-panel")).toContainText("What should you be asked?");
  await expect(tid(page, "side-panel")).toContainText("An instruction, in plain words.");
  await expect(tid(page, "node-message")).toHaveCount(0);
  // The fixed forms say that their text is not an instruction.
  await tid(page, "node-kind").selectOption("input");
  await expect(tid(page, "side-panel")).toContainText("Text shown to you (not an instruction)");
  await expect(tid(page, "side-panel")).toContainText("To describe what should be asked, choose the kind “ask”.");
  await expect(tid(page, "node-gate-prompt")).toHaveCount(0);
  await tid(page, "node-kind").selectOption("ask");
  await tid(page, "node-gate-prompt").fill(`It should ask me to review the list and let me cherry pick which ones to be added to the database for the executor to do. ${fake({ output: form })}`);
  await expect(tid(page, "node-gate-model")).toHaveAttribute("data-loaded", "true");
  await tid(page, "node-gate-model").selectOption("haiku");

  await drop(page, "palette-map", 300, 460);
  await tid(page, "node-id").fill("execute");
  await tid(page, "node-over").fill("{{nodes.review.output.selected}}");
  await tid(page, "inner-prompt").fill("apply {{item.title}}; note={{nodes.review.output.note}}");
  for (const [from, to] of [["plan", "review"], ["review", "execute"]]) {
    const before = await page.locator(".react-flow__edge").count();
    await expect(async () => {
      await connect(page, from, to);
      await expect(page.locator(".react-flow__edge")).toHaveCount(before + 1, { timeout: 1500 });
    }).toPass({ timeout: 20_000 });
  }
  await wfTab(page);
  await tid(page, "wf-name").fill("cherry");
  await tid(page, "wf-base-dir").fill(chief.dir);
  await saved(page, "cherry", 1);
  expect((await srv.api("GET", "/api/workflows/cherry")).body.definition.nodes[1]).toMatchObject({ id: "review", type: "gate", kind: "ask", model: "haiku" });

  // Run: the form on the run page is the one that was worked out from the instruction.
  await tid(page, "btn-run").click();
  await expect(tid(page, "run-status")).toHaveText("waiting gate");
  await expect(tid(page, "gate-message")).toHaveText("Which changes go to the database?");
  await expect(tid(page, "gate-description")).toHaveText("Pick the ones the executor should apply.");
  await expect(tid(page, "gate-field-selected")).toContainText("Drop a table");
  await expect(tid(page, "gate-field-selected")).toContainText("change #2");
  await expect(tid(page, "gate-field-note")).toHaveAttribute("data-type", "long-text");
  await expect(tid(page, "gate-ask-submit")).toHaveText("Send to the executor");
  // A required question must be answered first.
  await expect(tid(page, "gate-ask-submit")).toBeDisabled();
  await tid(page, "gate-field-selected-0").check();
  await tid(page, "gate-field-selected-2").check();
  await tid(page, "gate-field-note-input").fill("index first, then the backfill");
  await tid(page, "gate-field-urgent-input").check();
  // What was filled in survives a refresh.
  await refresh(page);
  await expect(tid(page, "gate-field-selected-0")).toBeChecked();
  await expect(tid(page, "gate-field-selected-1")).not.toBeChecked();
  await expect(tid(page, "gate-field-selected-2")).toBeChecked();
  await expect(tid(page, "gate-field-note-input")).toHaveValue("index first, then the backfill");
  await expect(tid(page, "gate-field-urgent-input")).toBeChecked();
  await tid(page, "gate-ask-submit").click();
  await expect(tid(page, "run-status")).toHaveText("completed");

  const d = (await srv.api("GET", "/api/runs/1")).body;
  expect(d.node_runs.find((n: any) => n.node_id === "review").output).toMatchObject({ selected: [items[0], items[2]], unselected: [items[1]], note: "index first, then the backfill", urgent: true });
  expect(chief.calls().slice(2).map((c) => c.prompt.split("\n")[0])).toEqual(["apply Add an index; note=index first, then the backfill", "apply Backfill a column; note=index first, then the backfill"]);
  expect((await drafts(page, srv)).filter((k) => k.startsWith("gate:"))).toEqual([]);
});

test("E9.18-1 everything clickable shows the hand cursor", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: cur\nnodes:\n  - { id: g, type: gate, kind: approve, value: x }\n");
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "cur" });
  const cursor = (testid: string) => tid(page, testid).first().evaluate((el) => getComputedStyle(el).cursor);
  const cursorOf = (selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).cursor);

  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  await wfTab(page);
  for (const id of ["nav-runs", "nav-settings", "gates-badge", "btn-new", "btn-run", "btn-import", "wf-picker", "wf-agent"]) expect(await cursor(id), id).toBe("pointer");
  expect(await cursorOf('[data-testid="palette-mcp-unavailable"] summary')).toBe("pointer");
  // Not clickable now: "not allowed". Text fields and draggable blocks keep their own cursors.
  expect(await cursor("btn-export")).toBe("not-allowed");
  expect(await cursor("wf-name")).toBe("text");
  expect(await cursor("palette-agent")).toBe("grab");
  expect(await cursor("palette-mcp-slack")).toBe("default");
  await drop(page, "palette-agent", 320, 160);
  for (const id of ["node-delete", "node-mcp-all", "node-model", "node-tools", "node-irreversible", "help-prompt"]) expect(await cursor(id), id).toBe("pointer");
  expect(await cursorOf('label:has([data-testid="node-mcp-all"])')).toBe("pointer");
  expect(await cursor("node-prompt")).toBe("text");

  await tid(page, "nav-runs").click();
  for (const id of ["new-run-start", "new-run-workflow", "runs-filter", "run-row-1"]) expect(await cursor(id), id).toBe("pointer");
  await tid(page, "run-row-1").click();
  for (const id of ["btn-pause", "btn-cancel", "gate-approve", "gate-reject", "btn-revert", "revert-to", "replay-next", "replay-node"]) expect(await cursor(id), id).toBe("pointer");
  // Resume is not drawn while the run is going, rather than drawn and disabled (task 15.90).
  await expect(tid(page, "btn-resume")).toHaveCount(0);
  expect(await cursorOf('[data-testid="replay"] summary')).toBe("pointer");
  expect(await cursorOf('[data-testid^="replay-row-"]')).toBe("pointer");
  expect(await cursorOf('[data-testid^="node-run-"]')).toBe("pointer");

  await tid(page, "nav-settings").click();
  for (const id of ["btn-discover", "setting-default-adapter", "setting-notify"]) expect(await cursor(id), id).toBe("pointer");
});

test("E9.19-2 the panel says what a step knows about earlier steps, and the run page shows what was added", async ({ chief, boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await drop(page, "palette-agent", 300, 100);
  await tid(page, "node-id").fill("find");
  await tid(page, "node-prompt").fill(`Find my action items ${fake({ output: { action_items: [{ what: "Review PR 12" }] } })}`);
  await drop(page, "palette-agent", 300, 320);
  await tid(page, "node-id").fill("act");
  await tid(page, "node-prompt").fill("Do the first one.");
  // Default: the steps right before it. Nothing is stored for the default.
  await expect(tid(page, "node-context")).toHaveValue("previous");
  await expect(tid(page, "node-context").locator("option")).toHaveText(["the step before", "every earlier step", "nothing, just the prompt"]);
  await expect(async () => {
    await connect(page, "find", "act");
    await expect(page.locator(".react-flow__edge")).toHaveCount(1, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });
  await wfTab(page);
  await tid(page, "wf-name").fill("knows");
  await tid(page, "wf-base-dir").fill(chief.dir);
  await saved(page, "knows", 1);
  const act = async () => (await srv.api("GET", "/api/workflows/knows")).body.definition.nodes[1];
  expect("context" in (await act())).toBe(false);
  await flowNode(page, "act").click();
  await expect(async () => {
    await tid(page, "help-context").hover();
    await expect(tid(page, "help-text-context")).toContainText("Steps share results, not a conversation", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(tid(page, "help-text-context")).toContainText("can be any JSON");
  await page.mouse.move(5, 300);

  // Run it: on the run page the node shows the author's prompt; its details show the result that was added.
  await tid(page, "btn-run").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  await showStep(page, "act");
  const id = await page.locator('[data-testid^="node-run-"][data-node-id="act"]').getAttribute("data-testid").then((t) => t!.replace("node-run-", ""));
  await expect(tid(page, `node-in-${id}`)).toHaveText("Do the first one.");
  await tid(page, `node-io-${id}`).click();
  await expect(tid(page, "node-input")).toContainText("Results of earlier steps of this workflow");
  // The prompt exactly as sent is in the raw view (the formatted one turns ### into a heading).
  await tid(page, "node-input-raw").click();
  await expect(tid(page, "node-input")).toContainText('### Result of step "find"');
  await expect(tid(page, "node-input")).toContainText('"what": "Review PR 12"');

  // The other choices are stored.
  await page.goto(srv.url + "/#/designer/knows");
  await flowNode(page, "act").click();
  await tid(page, "node-context").selectOption("none");
  await expect.poll(async () => (await act()).context).toBe("none");
  await tid(page, "node-context").selectOption("all");
  await expect.poll(async () => (await act()).context).toBe("all");
  await tid(page, "node-context").selectOption("previous");
  await expect.poll(async () => "context" in (await act())).toBe(false);
});

test("E9.20-2 the run page shows the text a step wrote besides its result", async ({ chief, boot, page }) => {
  const prose = "## Todo list\n" + Array.from({ length: 8 }, (_, i) => `- T${i + 1}: task number ${i + 1}, link https://example.test/task/${i + 1}`).join("\n");
  const reply = `${prose}\n\n\`\`\`json\n{"status": "ok", "task_count": 8}\n\`\`\``;
  chief.importWorkflow(`name: prose\nnodes:\n  - { id: plan, type: agent, mcp: [], prompt: 'Plan ${fake({ text: reply })}' }\n  - { id: quick, type: agent, mcp: [], prompt: 'Quick' }\nedges: [plan -> quick]\n`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "prose" });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("completed");
  const id = async (node: string) => { await showStep(page, node); return (await page.locator(`[data-testid^="node-run-"][data-node-id="${node}"]`).getAttribute("data-testid"))!.replace("node-run-", ""); };
  const plan = await id("plan"), quick = await id("quick");

  // The node says there is more than its result, and how much.
  await showStep(page, "plan"); // `id()` left the view on the last step it named
  await expect(tid(page, `node-out-${plan}`)).toContainText('"task_count": 8');
  await expect(tid(page, `node-reply-note-${plan}`)).toContainText(`also wrote ${prose.length} characters of text besides its result`);
  await showStep(page, "quick");
  await expect(tid(page, `node-reply-note-${quick}`)).toHaveCount(0);
  await showStep(page, "plan");
  // The details show it in full, apart from the result that is passed on.
  await tid(page, `node-io-${plan}`).click();
  // Formatted by default (9.31), exactly as written in the raw view.
  await expect(tid(page, "node-reply").getByRole("heading", { name: "Todo list" })).toBeVisible();
  await expect(tid(page, "node-reply").locator("li")).toHaveCount(8);
  await tid(page, "node-reply-raw").click();
  await expect(tid(page, "node-reply")).toHaveText(prose);
  await tid(page, "node-output-json").click();
  await expect(tid(page, "node-output")).toContainText('"status": "ok"');
  // The next step received it.
  await showStep(page, "quick");
  await page.locator(`[data-testid="node-run-${quick}"]`).click();
  await tid(page, "node-input-raw").click();
  await expect(tid(page, "node-input")).toContainText('### What step "plan" wrote besides its result');
  await expect(tid(page, "node-input")).toContainText("T8: task number 8, link https://example.test/task/8");
});

test("E9.21-1 a node row shows that it can be opened and whether it is open", async ({ chief, boot, page }) => {
  chief.importWorkflow(`name: rows\nnodes:\n  - { id: planner, type: agent, mcp: [], prompt: 'Plan ${fake({ output: { ok: 1 } })}' }\n  - { id: worker, type: agent, mcp: [], prompt: 'Work ${fake({ output: { ok: 2 } })}' }\nedges: [planner -> worker]\n`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "rows" });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("completed");
  /**
   * The steps are tabs now (task 15.93), so one step's row is in the DOM at a time: a row is read by selecting its tab
   * first, and "the other row is untouched" becomes "the other tab's row is closed when you get to it" — which is the same
   * claim about the same state, read one panel at a time instead of side by side.
   */
  const rowOf = async (node: string) => { await showStep(page, node); return page.locator(`[data-testid^="node-run-"][data-node-id="${node}"]`); };
  const arrow = async (node: string) => (await rowOf(node)).locator('[data-testid^="node-arrow-"]');
  const bg = async (node: string) => (await rowOf(node)).evaluate((el) => getComputedStyle(el).backgroundColor);
  const edge = async (node: string) => (await rowOf(node)).evaluate((el) => getComputedStyle(el).borderLeftColor);

  // Closed: an arrow pointing right, the word "Details", marked as not expanded.
  await expect(await rowOf("planner")).toHaveAttribute("aria-expanded", "false");
  await expect(await arrow("planner")).toHaveText("▸");
  await expect(await rowOf("planner")).toContainText("Details");
  await expect(tid(page, "node-details")).toHaveCount(0);
  const closedBg = await bg("worker");
  const closedEdge = await edge("worker");
  expect(closedEdge).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

  // Open: the row is highlighted, the arrow points down, and the panel says whose details these are.
  await (await rowOf("planner")).click();
  await expect(await rowOf("planner")).toHaveAttribute("aria-expanded", "true");
  await expect(await arrow("planner")).toHaveText("▾");
  await expect(await rowOf("planner")).toContainText("Hide");
  await page.mouse.move(5, 5);
  expect(await bg("planner"), "the open row is highlighted").not.toBe(closedBg);
  // ... with a coloured bar on its left that a closed row does not have.
  expect(await edge("planner"), "the open row has the bar").not.toBe(closedEdge);
  await expect(tid(page, "node-details")).toHaveAttribute("data-for", "planner");
  await expect(tid(page, "node-details-title")).toHaveText("Details of planner (agent, completed)");
  await tid(page, "node-output-json").click();
  await expect(tid(page, "node-output")).toContainText('"ok": 1');

  // The other step is untouched: its own row is closed, with no highlight, when its tab is selected.
  await expect(await rowOf("worker")).toHaveAttribute("aria-expanded", "false");
  // Polled: a row's colour fades back, so one read can catch it at an alpha nobody chose.
  await expect.poll(() => bg("worker")).toBe(closedBg);
  await expect(tid(page, "node-details"), "and the open details did not follow it").toHaveCount(0);

  // Opening a row is per step: opening worker's leaves planner's closed, and only one set of details is on screen.
  await (await rowOf("worker")).click();
  await expect(await rowOf("worker")).toHaveAttribute("aria-expanded", "true");
  await expect(tid(page, "node-details")).toHaveCount(1);
  await expect(tid(page, "node-details-title")).toContainText("Details of worker");
  await expect(tid(page, "node-output")).toContainText('"ok": 2');
  // Reading planner's row means selecting planner's tab, which is its own panel: its row is closed there, and worker's
  // details did not follow the tab. (Selecting a tab closes the row it leaves, so this is also the reset a person sees.)
  await expect(await rowOf("planner")).toHaveAttribute("aria-expanded", "false");
  await expect(tid(page, "node-details")).toHaveCount(0);

  // "Hide details" closes it and removes the highlight, from worker's own tab.
  await (await rowOf("worker")).click();
  await expect(tid(page, "node-details")).toHaveCount(1);
  await tid(page, "node-details-hide").click();
  await expect(tid(page, "node-details")).toHaveCount(0);
  await expect(await rowOf("worker")).toHaveAttribute("aria-expanded", "false");
  await page.mouse.move(5, 5);
  await expect.poll(() => bg("worker")).toBe(closedBg);
});

test("E9.22-1 the pages fill a wide column next to the sidebar", async ({ chief, boot, page }) => {
  chief.importWorkflow(`name: wide\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'Go ${fake({ output: { ok: 1 } })}' }\n`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "wide" });
  const column = async () => {
    const el = tid(page, "page-column");
    await expect(el).toBeVisible();
    // The content box: the column without its side padding.
    return el.evaluate((n) => {
      const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
      return { left: r.left + parseFloat(cs.paddingLeft), right: r.right - parseFloat(cs.paddingRight), outer: r.width, mid: r.left + r.width / 2 };
    });
  };

  await page.setViewportSize({ width: 1600, height: 900 });
  for (const path of ["/#/runs", "/#/runs/1", "/#/settings"]) {
    await page.goto(srv.url + path);
    const c = await column();
    expect(c.right - c.left, path).toBeGreaterThan(1300);
  }

  // A very wide window: the column stops growing and stays in the middle of the space next to the sidebar.
  await page.setViewportSize({ width: 2400, height: 900 });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("completed");
  const side = (await tid(page, "sidenav").boundingBox())!;
  const c = await column();
  expect(c.outer).toBe(1760);
  expect(Math.abs(c.mid - (side.width + (2400 - side.width) / 2))).toBeLessThan(10);
});

test("E9.23-1 a sidebar on the left replaces the top bar", async ({ chief, boot, page }) => {
  chief.importWorkflow(`name: side\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'Go ${fake({ output: { ok: 1 } })}' }\n`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "side" });
  await page.setViewportSize({ width: 1400, height: 900 });
  const box = async (id: string) => (await tid(page, id).boundingBox())!;

  for (const [path, key] of [["/#/runs", "runs"], ["/#/runs/1", "runs"], ["/#/designer", "designer"], ["/#/settings", "settings"]] as const) {
    await page.goto(srv.url + path);
    await expect(tid(page, `page-${key}`)).toBeVisible();
    const side = await box("sidenav");
    // Full height at the left edge.
    expect(side.x, path).toBe(0);
    expect(side.y, path).toBe(0);
    expect(side.height, path).toBe(900);
    // Brand at the top, the items stacked under it.
    const brand = await box("brand"), runs = await box("nav-runs"), designer = await box("nav-designer"), settings = await box("nav-settings");
    expect(brand.y, path).toBeLessThan(runs.y);
    expect(runs.y, path).toBeLessThan(designer.y);
    expect(designer.y, path).toBeLessThan(settings.y);
    expect(Math.abs(runs.x - settings.x), path).toBeLessThan(1);
    for (const b of [brand, runs, designer, settings]) expect(b.x + b.width, path).toBeLessThanOrEqual(side.width);
    await expect(tid(page, `nav-${key}`)).toHaveAttribute("aria-current", "page");
    // The notification center is in the top right corner (9.47), in a slim bar above the page.
    const header = await box("app-header"), badge = await box("gates-badge");
    expect(header.y, path).toBe(0);
    expect(header.x, path).toBeGreaterThanOrEqual(side.width - 1);
    expect(badge.y + badge.height, path).toBeLessThanOrEqual(header.height);
    expect(1400 - (badge.x + badge.width), path).toBeLessThan(24);
    const main = await box(`page-${key}`);
    expect(main.x, path).toBeGreaterThanOrEqual(side.width - 1);
    expect(Math.abs(main.y - header.height), path).toBeLessThan(2);
  }

  // The designer canvas fills the rest of the window.
  await page.goto(srv.url + "/#/designer/side");
  const canvas = await box("canvas"), side = await box("sidenav");
  expect(canvas.x).toBeGreaterThanOrEqual(side.width - 1);
  expect(canvas.y + canvas.height).toBeGreaterThan(900 - 40);
});

const DONE_WF = `name: done\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'Go ${fake({ output: { ok: 1 } })}' }\n`;
const GATED_WF = "name: gated\nnodes:\n  - { id: g, type: gate, kind: approve, value: ship it }\n";
/** Start runs over the API, one after another, and wait until every one of them has stopped moving. */
async function makeRuns(srv: Server, workflows: string[]) {
  for (const workflow of workflows) await srv.api("POST", "/api/runs", { workflow });
  await expect.poll(async () => (await srv.api("GET", "/api/runs?limit=500")).body.every((r: any) => ["completed", "waiting_gate"].includes(r.status)), { timeout: 20_000 }).toBe(true);
}

test("E9.25-2 runs are deleted from the run list and from the run page, after a confirmation", async ({ chief, boot, page }) => {
  chief.importWorkflow(DONE_WF);
  chief.importWorkflow(GATED_WF);
  const srv = await boot();
  await makeRuns(srv, ["done", "done", "done", "gated"]);
  await page.goto(srv.url + "/#/runs");
  await expect(tid(page, "run-row-4")).toContainText("waiting gate");

  // An active run cannot be ticked; nothing ticked, nothing to delete.
  await expect(tid(page, "run-select-4")).toBeDisabled();
  await expect(tid(page, "runs-delete")).toBeDisabled();

  // The toolbar's delete is a bin, not a filled red bar, and each *finished* row has its own bin: one record can go
  // without ticking a checkbox and reaching for a toolbar (asked 2026-11-22).
  const bin = await tid(page, "runs-delete").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { border: cs.borderWidth, bg: cs.backgroundColor, glyph: !!el.querySelector("svg"), text: (el.textContent ?? "").trim() };
  });
  expect(bin.border).toBe("0px");
  expect(bin.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(bin.glyph, "a drawn bin, not the word Delete").toBe(true);
  expect(bin.text).toBe("");
  // A row bin only on a run that can be deleted: the one waiting at a gate has none.
  await expect(tid(page, "run-delete-1")).toBeVisible();
  await expect(tid(page, "run-delete-4"), "a run in flight is not a record yet").toHaveCount(0);

  // Tick one, ask, keep: nothing changes, and ticking did not open the run.
  await tid(page, "run-select-1").check();
  expect(page.url()).toContain("#/runs");
  await expect(tid(page, "runs-selected")).toHaveText("1 selected");
  await tid(page, "runs-delete").click();
  await expect(tid(page, "confirm-delete")).toContainText("Delete run #1?");
  await expect(tid(page, "confirm-delete")).toContainText("This cannot be undone.");
  await tid(page, "confirm-delete-keep").click();
  await expect(tid(page, "confirm-delete")).toHaveCount(0);
  await expect(tid(page, "run-row-1")).toBeVisible();

  // Tick every finished run on the page (not the active one), then leave one out, and delete.
  await tid(page, "runs-select-all").check();
  await expect(tid(page, "runs-selected")).toHaveText("3 selected");
  await expect(tid(page, "run-select-4")).not.toBeChecked();
  await tid(page, "run-select-3").uncheck();
  await tid(page, "runs-delete").click();
  await expect(tid(page, "confirm-delete")).toContainText("Delete 2 runs?");
  await tid(page, "confirm-delete-yes").click();
  await expect(tid(page, "confirm-delete")).toHaveCount(0);
  await expect(tid(page, "run-row-1")).toHaveCount(0);
  await expect(tid(page, "run-row-2")).toHaveCount(0);
  await expect(tid(page, "run-row-3")).toBeVisible();
  await expect(tid(page, "runs-selected")).toHaveCount(0);

  // From the run page: Delete is there for a finished run and takes you back to the list.
  await tid(page, "run-row-3").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  await tid(page, "btn-delete-run").click();
  await expect(tid(page, "confirm-delete")).toContainText("Delete run #3?");
  await tid(page, "confirm-delete-yes").click();
  await expect(page).toHaveURL(/#\/runs$/);
  await expect(tid(page, "run-panel")).toHaveCount(0);
  await expect(tid(page, "runs-table")).toBeVisible();
  await expect(tid(page, "run-row-3")).toHaveCount(0);
  expect((await srv.api("GET", "/api/runs/3")).status).toBe(404);

  // A row's own bin, on the list: one run, one confirmation naming it, and the list kept. It must not open the run on the
  // way — the row's own click would have, which is why the button stops the event.
  const created = await srv.api("POST", "/api/runs", { workflow: "done" });
  const fresh = created.body.run.id;
  await expect.poll(async () => (await srv.api("GET", `/api/runs/${fresh}`)).body.run?.status, { timeout: 20_000 }).toBe("completed");
  await page.reload();
  await tid(page, `run-delete-${fresh}`).click();
  await expect(tid(page, "confirm-delete")).toContainText(`Delete run #${fresh}?`);
  await tid(page, "confirm-delete-yes").click();
  await expect(tid(page, `run-row-${fresh}`)).toHaveCount(0);
  await expect(page, "the row's bin does not open the run").toHaveURL(/#\/runs$/);
  await expect(tid(page, "run-panel")).toHaveCount(0);
  await expect(tid(page, "run-row-4"), "the run that was not deleted is still there").toBeVisible();
  expect((await srv.api("GET", `/api/runs/${fresh}`)).status).toBe(404);

  // An active run has no Delete button.
  await tid(page, "run-row-4").click();
  await expect(tid(page, "run-status")).toHaveText("waiting gate");
  await expect(tid(page, "btn-delete-run")).toHaveCount(0);
});

test("E9.26-2 the run list is paged", async ({ chief, boot, page }) => {
  chief.importWorkflow(DONE_WF);
  chief.importWorkflow(`name: other\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'Go ${fake({ output: { ok: 2 } })}' }\n`);
  const srv = await boot();
  await makeRuns(srv, Array.from({ length: 30 }, (_, i) => ((i + 1) % 3 === 0 ? "other" : "done")));
  await page.goto(srv.url + "/#/runs");
  const rows = page.locator('[data-testid^="run-row-"]');

  await expect(tid(page, "runs-pager-range")).toHaveText("1–10 of 30");
  await expect(tid(page, "runs-pager-page")).toHaveText("Page 1 of 3");
  await expect(rows).toHaveCount(10);
  await expect(tid(page, "run-row-30")).toBeVisible();
  await expect(tid(page, "runs-pager-prev")).toBeDisabled();

  await tid(page, "runs-pager-next").click();
  await expect(tid(page, "runs-pager-range")).toHaveText("11–20 of 30");
  await expect(tid(page, "runs-pager-page")).toHaveText("Page 2 of 3");
  await expect(rows).toHaveCount(10);
  await tid(page, "runs-pager-next").click();
  await expect(tid(page, "runs-pager-range")).toHaveText("21–30 of 30");
  await expect(rows).toHaveCount(10);
  await expect(tid(page, "run-row-1")).toBeVisible();
  await expect(tid(page, "runs-pager-next")).toBeDisabled();
  await tid(page, "runs-pager-prev").click();
  await expect(tid(page, "runs-pager-range")).toHaveText("11–20 of 30");

  await tid(page, "runs-pager-size").selectOption("50");
  await expect(tid(page, "runs-pager-range")).toHaveText("1–30 of 30");
  await expect(rows).toHaveCount(30);
  await expect(tid(page, "runs-pager-page")).toHaveText("Page 1 of 1");
  await tid(page, "runs-pager-size").selectOption("10");

  // The filter starts again at page 1.
  await tid(page, "runs-pager-next").click();
  await expect(tid(page, "runs-pager-range")).toHaveText("11–20 of 30");
  await tid(page, "runs-filter").selectOption("other");
  await expect(tid(page, "runs-pager-range")).toHaveText("1–10 of 10");
  await expect(rows).toHaveCount(10);
  await tid(page, "runs-filter").selectOption("");
  await expect(tid(page, "runs-pager-range")).toHaveText("1–10 of 30");

  // Emptying the last page moves back one page.
  await tid(page, "runs-pager-next").click();
  await tid(page, "runs-pager-next").click();
  await expect(tid(page, "runs-pager-range")).toHaveText("21–30 of 30");
  await tid(page, "runs-select-all").check();
  await tid(page, "runs-delete").click();
  await tid(page, "confirm-delete-yes").click();
  await expect(tid(page, "runs-pager-range")).toHaveText("11–20 of 20");
  await expect(tid(page, "runs-pager-page")).toHaveText("Page 2 of 2");
  await expect(rows).toHaveCount(10);
});

test("E9.27-1 the settings page uses the full width", async ({ boot, page }) => {
  const srv = await boot();
  const content = () => tid(page, "page-column").evaluate((n) => {
    const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
    return { left: r.left + parseFloat(cs.paddingLeft), right: r.right - parseFloat(cs.paddingRight) };
  });
  const box = async (id: string) => (await tid(page, id).boundingBox())!;

  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(srv.url + "/#/settings");
  await expect(tid(page, "doctor-ok")).toBeVisible();
  let c = await content(), form = await box("settings-card"), env = await box("doctor-summary");
  expect(Math.abs(form.y - env.y)).toBeLessThan(2);
  expect(Math.abs(form.x - c.left)).toBeLessThan(2);
  expect(Math.abs(env.x + env.width - c.right)).toBeLessThan(2);
  expect(env.x).toBeGreaterThan(form.x + form.width);

  await page.setViewportSize({ width: 800, height: 900 });
  c = await content(); form = await box("settings-card"); env = await box("doctor-summary");
  expect(env.y).toBeGreaterThan(form.y + form.height);
  for (const b of [form, env]) {
    expect(Math.abs(b.x - c.left)).toBeLessThan(2);
    expect(Math.abs(b.x + b.width - c.right)).toBeLessThan(2);
  }
});

test("E9.28-1 the sidebar is the icon rail, on every page and after a reload", async ({ boot, page }) => {
  const srv = await boot();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(srv.url + "/#/runs");
  const width = async (id: string) => Math.round((await tid(page, id).boundingBox())!.width);
  // One state, not a choice (15.70): the 72 px icon column, every name under its icon, and no control to widen it —
  // a button for a state nobody wanted was removed on request ("remove this, let the left navbar not expandable").
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "true");
  await expect(tid(page, "nav-collapse"), "there is no expand control").toHaveCount(0);
  expect(await width("sidenav")).toBe(72);
  await expect(tid(page, "nav-runs-caption"), "the name is drawn, not only announced").toBeVisible();
  expect((await tid(page, "nav-runs-caption").boundingBox())!.height, "one line").toBeLessThan(16);
  await expect(tid(page, "brand")).toHaveText("chief");
  await expect(tid(page, "gates-badge")).toHaveAttribute("data-count", "0");

  // The same on every page, and the page keeps the rest of the window.
  for (const key of ["designer", "settings", "runs"]) {
    await tid(page, `nav-${key}`).click();
    await expect(tid(page, `page-${key}`)).toBeVisible();
    await expect(tid(page, `nav-${key}`)).toHaveAttribute("aria-current", "page");
    expect(await width("sidenav")).toBe(72);
    expect(await width(`page-${key}`), `${key} fills the rest`).toBeGreaterThan(1200);
  }

  // Nothing about it is remembered to disagree later: a reload draws the same rail.
  await page.reload();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "true");
  expect(await width("sidenav")).toBe(72);
});

test("E9.28-2 on a phone-sized window the sidebar becomes a menu and no page scrolls sideways", async ({ chief, boot, page }) => {
  chief.importWorkflow(DONE_WF);
  const srv = await boot();
  await makeRuns(srv, ["done"]);
  await page.setViewportSize({ width: 375, height: 800 });
  const side = async () => (await tid(page, "sidenav").boundingBox())!;
  const closed = () => expect.poll(async () => { const b = await side(); return b.x + b.width; }).toBeLessThanOrEqual(0);

  for (const [path, key] of [["/#/runs", "runs"], ["/#/runs/1", "runs"], ["/#/designer/done", "designer"], ["/#/settings", "settings"]] as const) {
    await page.goto(srv.url + path);
    await expect(tid(page, `page-${key}`)).toBeVisible();
    if (path === "/#/runs/1") await expect(tid(page, "run-status")).toHaveText("completed");
    await expect(tid(page, "mobile-bar")).toBeVisible();
    await expect(tid(page, "gates-badge-bar")).toHaveText("0 gates waiting");
    await closed();
    await expect(tid(page, "nav-collapse")).toBeHidden();
    // Neither the window nor the page area scrolls sideways.
    const overflow = await page.evaluate((k) => {
      const main = document.querySelector(`[data-testid="page-${k}"]`)!;
      return { doc: document.documentElement.scrollWidth, main: main.scrollWidth - main.clientWidth };
    }, key);
    expect(overflow.doc, path).toBeLessThanOrEqual(375);
    expect(overflow.main, path).toBeLessThanOrEqual(0);
  }

  // The designer stacks its blocks, canvas and panel.
  await page.goto(srv.url + "/#/designer/done");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  const [pal, canvas, panel] = [await tid(page, "palette").boundingBox(), await tid(page, "canvas").boundingBox(), await tid(page, "side-panel").boundingBox()];
  expect(canvas!.y).toBeGreaterThanOrEqual(pal!.y + pal!.height - 1);
  expect(panel!.y).toBeGreaterThanOrEqual(canvas!.y + canvas!.height - 1);
  // Each fills the page area (the window less its vertical scrollbar).
  const area = await tid(page, "page-designer").evaluate((n) => n.clientWidth);
  for (const b of [pal!, canvas!, panel!]) expect(Math.abs(b.width - area)).toBeLessThan(2);

  // The menu opens the navigation over the page; choosing a page closes it.
  await tid(page, "nav-menu").click();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-open", "true");
  await expect.poll(async () => (await side()).x).toBe(0);
  await expect(tid(page, "nav-backdrop")).toBeVisible();
  await expect(tid(page, "nav-runs")).toContainText("Runs");
  await tid(page, "nav-settings").click();
  await expect(tid(page, "page-settings")).toBeVisible();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-open", "false");
  await closed();

  // The close icon in its top right corner closes it; so do Escape and a click beside it.
  await tid(page, "nav-menu").click();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-open", "true");
  const close = (await tid(page, "nav-close").boundingBox())!, drawer = (await side());
  expect(close.y - drawer.y).toBeLessThan(24);
  expect(drawer.x + drawer.width - (close.x + close.width)).toBeLessThan(20);
  await tid(page, "nav-close").click();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-open", "false");
  await closed();
  await tid(page, "nav-menu").click();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-open", "true");
  await page.keyboard.press("Escape");
  await expect(tid(page, "sidenav")).toHaveAttribute("data-open", "false");
  await tid(page, "nav-menu").click();
  await expect(tid(page, "nav-backdrop")).toBeVisible();
  await tid(page, "nav-backdrop").click({ position: { x: 340, y: 400 } });
  await expect(tid(page, "nav-backdrop")).toHaveCount(0);
  await closed();
});

test("E9.29-1 a button shows a spinner instead of its label while its action is under way", async ({ chief, boot, page }) => {
  chief.importWorkflow(DONE_WF);
  const srv = await boot();
  await page.goto(srv.url + "/#/runs");
  await expect(tid(page, "new-run-workflow")).toHaveValue("done");
  const start = tid(page, "new-run-start");

  // A start that fails: the spinner, then the label again and the error.
  let release!: () => void;
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise<void>((r) => (release = r));
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "the server said no" }) });
  }, { times: 1 });
  const idle = (await start.boundingBox())!;
  await start.click();
  await expect(start).toHaveAttribute("aria-busy", "true");
  await expect(start).toBeDisabled();
  await expect(start.getByTestId("spinner")).toBeVisible();
  // The label is not painted while it spins. Asserted as the computed style, not as toBeHidden: the wrapper is
  // `display: contents` (15.46), so Playwright resolves it to its children and reports it visible while the
  // glyphs are in fact hidden.
  await expect(start.getByText("Start run")).toHaveCSS("visibility", "hidden");
  const busy = (await start.boundingBox())!;
  expect(Math.abs(busy.width - idle.width)).toBeLessThan(1);
  expect(Math.abs(busy.height - idle.height)).toBeLessThan(1);
  release();
  await expect(tid(page, "error")).toHaveText("the server said no");
  await expect(start).not.toHaveAttribute("aria-busy", /./);
  await expect(start.getByText("Start run")).not.toHaveCSS("visibility", "hidden");
  await expect(start.getByTestId("spinner")).toHaveCount(0);
  await expect(start).toBeEnabled();
  expect((await srv.api("GET", "/api/runs")).body).toHaveLength(0);

  // A slow start that works: a second click while it spins does nothing, and one run is started.
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise((r) => setTimeout(r, 800));
    await route.fallback();
  }, { times: 1 });
  await start.click();
  await expect(start.getByTestId("spinner")).toBeVisible();
  await start.click({ force: true }).catch(() => {});
  await expect(tid(page, "run-title")).toHaveText("Run #1 · done v1");
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect((await srv.api("GET", "/api/runs")).body).toHaveLength(1);

  // Refreshing the MCP servers in the settings.
  await page.route("**/api/mcp/refresh", async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.fallback(); }, { times: 1 });
  await tid(page, "nav-settings").click();
  const refresh = tid(page, "btn-discover");
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh.getByTestId("spinner")).toBeVisible();
  await expect(refresh).not.toHaveAttribute("aria-busy", /./, { timeout: 15_000 });
  await expect(refresh.getByText("Refresh MCP servers")).toBeVisible();

  // Deleting a run.
  await page.route("**/api/runs/delete", async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.fallback(); }, { times: 1 });
  await page.goto(srv.url + "/#/runs/1");
  await tid(page, "btn-delete-run").click();
  const yes = tid(page, "confirm-delete-yes");
  await yes.click();
  await expect(yes.getByTestId("spinner")).toBeVisible();
  await expect(tid(page, "confirm-delete-keep")).toBeDisabled();
  await expect(tid(page, "runs-table")).toBeVisible();
  await expect(tid(page, "runs-empty")).toBeVisible();
});

test("E9.30-1 the designer side panel is resized with a handle on its left edge", async ({ boot, page }) => {
  const srv = await boot();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  const width = async (id: string) => (await tid(page, id).boundingBox())!.width;
  const handle = tid(page, "panel-resize");
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute("role", "separator");
  expect(await width("side-panel")).toBe(384);
  const canvas0 = await width("canvas");

  /** Drag the handle by dx (negative is to the left, which widens the panel) and count the draft writes. */
  const drag = async (dx: number) => {
    let writes = 0;
    const count = (r: any) => { if (r.url().includes("/api/drafts/ui%3Adesigner-panel-width") && r.method() !== "GET") writes++; };
    page.on("request", count);
    const b = (await handle.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + 200);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + b.width / 2 + (dx * i) / 10, b.y + 200);
    await page.mouse.up();
    await page.waitForTimeout(150);
    page.off("request", count);
    return writes;
  };

  // Wider: the panel follows the handle, the canvas gives up the same width, and it is stored once.
  expect(await drag(-200)).toBe(1);
  expect(await width("side-panel")).toBe(584);
  expect(Math.abs(await width("canvas") - (canvas0 - 200))).toBeLessThan(2);
  await expect(handle).toHaveAttribute("aria-valuenow", "584");

  // It stops at 60 % of the window and at 320 px.
  await drag(-2000);
  expect(await width("side-panel")).toBe(960);
  await drag(2000);
  expect(await width("side-panel")).toBe(320);

  // Arrow keys move it in steps (larger with Shift); double-click restores the default.
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  expect(await width("side-panel")).toBe(336);
  await page.keyboard.press("Shift+ArrowLeft");
  expect(await width("side-panel")).toBe(400);
  await page.keyboard.press("ArrowRight");
  expect(await width("side-panel")).toBe(384);
  await drag(-100);
  expect(await width("side-panel")).toBe(484);
  await handle.dblclick();
  expect(await width("side-panel")).toBe(384);

  // Kept across a reload.
  await drag(-116);
  expect(await width("side-panel")).toBe(500);
  await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);
  await page.reload();
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  expect(await width("side-panel")).toBe(500);

  // Stacked on a narrow window: no handle, the panel is full width.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(handle).toBeHidden();
  const area = await tid(page, "page-designer").evaluate((n) => n.clientWidth);
  expect(Math.abs(await width("side-panel") - area)).toBeLessThan(2);
});

test("E9.31-1 recorded text on the run page is readable in full, with markdown formatted and raw one click away", async ({ chief, boot, page }) => {
  const prose = [
    "## Todo list",
    "",
    "- **T1**: review [PR 12](https://example.test/pr/12)",
    "- T2: reply on the thread",
    "",
    "| id | priority |",
    "|---|---|",
    "| T1 | high |",
    "",
    "Run `make check` first. <img src=x onerror=\"window.__xss = 1\"> <b>bold tag</b>",
  ].join("\n");
  const items = Array.from({ length: 80 }, (_, i) => ({ id: `T${i + 1}`, title: `a long task title number ${i + 1} `.repeat(4) }));
  const reply = `${prose}\n\n\`\`\`json\n${JSON.stringify({ status: "ok", items })}\n\`\`\``;
  const imported = chief.importWorkflow(["name: md", "nodes:", "  - id: plan", "    type: agent", "    mcp: []", "    prompt: |", "      ## Plan the day", "", "      - read Slack", `      - list the tasks ${fake({ text: reply })}`, "  - { id: ok, type: gate, kind: approve, value: go }", "edges: [plan -> ok]", ""].join("\n"));
  expect(imported.code, imported.stdout + imported.stderr).toBe(0);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "md" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("waiting gate");
  const id = async (node: string) => { await showStep(page, node); return (await page.locator(`[data-testid^="node-run-"][data-node-id="${node}"]`).getAttribute("data-testid"))!.replace("node-run-", ""); };
  const plan = await id("plan"), gate = await id("ok");

  // The row's preview says that there is more.
  await showStep(page, "plan"); // `id()` left the view on the gate
  await expect(tid(page, `node-out-${plan}`)).toHaveAttribute("data-clipped", "true");
  await expect(tid(page, `node-out-${plan}-more`)).toBeVisible();
  await tid(page, `node-io-${plan}`).click();

  // Formatted: heading, list, table, link to a new tab; HTML tags are not rendered.
  const reply$ = tid(page, "node-reply");
  await expect(reply$).toHaveAttribute("data-format", "formatted");
  await expect(reply$.getByRole("heading", { name: "Todo list" })).toBeVisible();
  await expect(reply$.locator("li")).toHaveCount(2);
  await expect(reply$.locator("strong")).toHaveText("T1");
  await expect(reply$.locator("table td").first()).toHaveText("T1");
  await expect(reply$.locator("code")).toHaveText("make check");
  const link = reply$.getByRole("link", { name: "PR 12" });
  await expect(link).toHaveAttribute("href", "https://example.test/pr/12");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(reply$.locator("img")).toHaveCount(0);
  await expect(reply$.locator("b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();

  // Raw markdown: exactly as recorded; and back.
  await tid(page, "node-reply-raw").click();
  await expect(reply$).toHaveAttribute("data-format", "raw");
  await expect(tid(page, "node-reply-raw")).toHaveAttribute("aria-pressed", "true");
  await expect(reply$).toHaveText(prose);
  await tid(page, "node-reply-formatted").click();
  await expect(reply$.getByRole("heading", { name: "Todo list" })).toBeVisible();

  // In the JSON view (the parsed view is E9.45-1): the output wraps (no sideways scrolling), shows part of the result, and all of it after Expand.
  await tid(page, "node-output-json").click();
  const out = tid(page, "node-output");
  await expect(out).toHaveAttribute("data-expanded", "false");
  const sizes = () => out.evaluate((n) => ({ sw: n.scrollWidth, cw: n.clientWidth, sh: n.scrollHeight, ch: n.clientHeight }));
  let z = await sizes();
  expect(z.sw).toBeLessThanOrEqual(z.cw);
  expect(z.sh).toBeGreaterThan(z.ch);
  await expect(tid(page, "node-output-more")).toBeVisible();
  await tid(page, "node-output-expand").click();
  await expect(out).toHaveAttribute("data-expanded", "true");
  z = await sizes();
  expect(z.sh).toBeLessThanOrEqual(z.ch + 1);
  await expect(out).toContainText('"id": "T80"');
  await expect(tid(page, "node-output-more")).toHaveCount(0);
  await tid(page, "node-output-expand").click();
  await expect(out).toHaveAttribute("data-expanded", "false");

  // The result is JSON: in the JSON view, a code block with names, text and numbers in colour; the characters are unchanged.
  await tid(page, "node-output-json").click();
  await expect(out).toHaveAttribute("data-lang", "json");
  await expect(out.locator('[data-json="key"]').first()).toHaveText('"status"');
  await expect(out.locator('[data-json="string"]').first()).toHaveText('"ok"');
  const colour = (kind: string) => out.locator(`[data-json="${kind}"]`).first().evaluate((n) => getComputedStyle(n).color);
  expect(await colour("key")).not.toBe(await colour("string"));
  expect(JSON.parse((await out.textContent())!).items).toHaveLength(80);
  // So is the preview on the row, and a json block inside formatted text is not affected by the switch.
  await expect(tid(page, "node-input")).not.toHaveAttribute("data-lang", "json");

  // Copy puts the full text on the clipboard.
  await tid(page, "node-output-copy").click();
  await expect(tid(page, "node-output-copy")).toHaveText("Copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(JSON.parse(copied).items).toHaveLength(80);

  // The prompt is markdown too: formatted, with the same switch.
  await expect(tid(page, "node-input").getByRole("heading", { name: "Plan the day" })).toBeVisible();
  await tid(page, "node-input-raw").click();
  await expect(tid(page, "node-input")).toContainText("## Plan the day");

  // A gate question is JSON: shown as it is, with no switch.
  await showStep(page, "ok");
  await page.locator(`[data-testid="node-run-${gate}"]`).click();
  await expect(tid(page, "node-input")).toHaveAttribute("data-format", "raw");
  await expect(tid(page, "node-input-raw")).toHaveCount(0);
  await expect(tid(page, "node-input")).toHaveAttribute("data-lang", "json");
  await expect(tid(page, "node-input").locator('[data-json="key"]').first()).toHaveText('"message"');
  // The row previews are coloured too (and the row is in the plan's own tab).
  await tid(page, "node-details-hide").click();
  await showStep(page, "plan");
  await expect(tid(page, `node-out-${plan}`).locator('[data-json="key"]').first()).toHaveText('"status"');
});

test("E9.32-2 the workspace directory setting is empty by default and shows the default", async ({ chief, boot, page }) => {
  const srv = await boot();
  const workspace = join(dirname(chief.home), "workspace");
  await page.goto(srv.url + "/#/settings");
  const field = tid(page, "setting-workspace-dir");
  await expect(field).toHaveValue("");
  await expect(field).toHaveAttribute("placeholder", workspace);
  await expect(page.getByText(`Empty: ${workspace}`)).toBeVisible();

  // A folder typed in is stored; cleared again, nothing is stored and the default applies.
  await field.fill("~/flows");
  await expect.poll(async () => (await srv.api("GET", "/api/settings")).body["workspace-dir"]).toBe("~/flows");
  await field.fill("");
  await expect.poll(async () => (await srv.api("GET", "/api/settings")).body["workspace-dir"] ?? null).toBeNull();
  expect((await srv.api("GET", "/api/meta")).body.workspace_dir).toBe(workspace);

  // The designer offers <default workspace>/<name> as a new workflow's folder.
  await tid(page, "nav-designer").click();
  await wfTab(page);
  await tid(page, "wf-name").fill("fresh-flow");
  await expect(tid(page, "wf-base-dir")).toHaveAttribute("placeholder", `${workspace}/fresh-flow`);
});

test("E9.34-2 the designer lists the MCP servers of the workflow's folder", async ({ chief, boot, page }) => {
  const a = join(chief.dir, "flows", "a"), b = join(chief.dir, "flows", "b");
  for (const d of [a, b]) mkdirSync(d, { recursive: true });
  writeFileSync(join(a, "fake-mcp-list.txt"), "localgit: https://example.test/mcp (HTTP) - ✔ Connected\n");
  for (const [dir, name] of [[a, "wa"], [b, "wb"]]) {
    writeFileSync(join(dir, `${name}.yaml`), `name: ${name}\nnodes:\n  - { id: x, type: agent, mcp: [], prompt: hi }\n`);
    const r = chief.run(["workflow", "import", join(dir, `${name}.yaml`), "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
  }
  const srv = await boot();

  await page.goto(srv.url + "/#/designer/wa");
  await expect(tid(page, "palette-mcp-folder")).toHaveText(`in ${a}`);
  await expect(tid(page, "palette-mcp-localgit")).toHaveAttribute("data-status", "connected");
  await expect(tid(page, "palette-mcp-github-custom")).toBeVisible();

  await page.goto(srv.url + "/#/designer/wb");
  await expect(tid(page, "palette-mcp-folder")).toHaveText(`in ${b}`);
  await expect(tid(page, "palette-mcp-github-custom")).toBeVisible();
  await expect(tid(page, "palette-mcp-localgit")).toHaveCount(0);

  // A new workflow: the default workspace's servers; typing A's folder shows A's.
  await newWorkflow(page, "fresh");
  await expect(tid(page, "palette-mcp-folder")).toHaveText(`in ${join(dirname(chief.home), "workspace", "fresh")}`);
  await expect(tid(page, "palette-mcp-localgit")).toHaveCount(0);
  await wfTab(page);
  await tid(page, "wf-base-dir").fill(a);
  await expect(tid(page, "palette-mcp-folder")).toHaveText(`in ${a}`);
  await expect(tid(page, "palette-mcp-localgit")).toBeVisible();
});

test("E9.36-1 a waiting gate is answered inside the row of its step", async ({ chief, boot, page }) => {
  chief.importWorkflow(`name: inline\nnodes:\n  - { id: plan, type: agent, mcp: [], prompt: 'Plan ${fake({ output: { ok: 1 } })}' }\n  - { id: check, type: gate, kind: input, message: Anything to change? }\nedges: [plan -> check]\n`);
  chief.importWorkflow(`name: costly\nbudget: { max-usd: 0.5 }\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { ok: 1 }, cost: 1 })}' }\n  - { id: b, type: agent, mcp: [], prompt: 'B ${fake({ output: { ok: 2 } })}' }\nedges: [a -> b]\n`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "inline" });
  await srv.api("POST", "/api/runs", { workflow: "costly" });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("waiting gate");
  const id = async (node: string) => { await showStep(page, node); return (await page.locator(`[data-testid^="node-run-"][data-node-id="${node}"]`).getAttribute("data-testid"))!.replace("node-run-", ""); };
  const check = await id("check");

  // The form is inside the gate step's own panel, below that step's row — and it is the only gate on the page.
  await showStep(page, "check");
  const form = tid(page, "timeline").locator('[data-reason="node"][data-kind="input"]');
  await expect(form).toBeVisible();
  await expect(tid(page, `node-gate-${check}`).locator("[data-reason]")).toHaveCount(1);
  await expect(page.locator("[data-reason]")).toHaveCount(1);
  const [f, g] = [(await form.boundingBox())!, (await tid(page, `node-run-${check}`).boundingBox())!];
  expect(f.y, "the form sits under its step's row").toBeGreaterThan(g.y);
  await expect(tid(page, `node-out-${check}`)).toHaveText("(waiting for your answer)");
  // The steps are tabs now, and the strip keeps the workflow's order (task 15.93): `plan` before `check`.
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="node-tab-"]')].map((t) => t.getAttribute("data-node-id")));
  expect(order).toEqual(["plan", "check"]);

  // The notice above the steps names the step and goes to the form.
  await expect(tid(page, "gate-notice")).toContainText("waiting for your answer at step check");
  expect((await tid(page, "gate-notice").boundingBox())!.y, "the notice is above the steps").toBeLessThan((await tid(page, "node-tabs").boundingBox())!.y);
  await tid(page, "gate-notice-go").click();
  await expect(form).toBeInViewport();

  // Answered: the form and the notice are gone.
  await tid(page, "gate-text").fill("all good");
  await tid(page, "gate-submit").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  await expect(page.locator("[data-reason]")).toHaveCount(0);
  await expect(tid(page, "gate-notice")).toHaveCount(0);

  // A budget stop belongs to no step: it is shown above the steps.
  await page.goto(srv.url + "/#/runs/2");
  const budget = page.locator('[data-reason="budget"]');
  await expect(budget).toBeVisible();
  await expect(tid(page, "timeline").locator('[data-reason="budget"]')).toHaveCount(0);
  expect((await budget.boundingBox())!.y).toBeLessThan((await tid(page, "timeline").boundingBox())!.y);
});

test("E9.37-1 a prompt can be refined by the agent CLI, and the author can go back to their own text", async ({ chief, boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await wfTab(page);
  await tid(page, "wf-name").fill("refined");
  await tid(page, "wf-base-dir").fill(chief.dir);
  await drop(page, "palette-agent", 300, 160);
  const prompt = tid(page, "node-prompt"), refine = tid(page, "node-prompt-refine");
  // The sparkle that says "an agent writes this" — what tells this button apart from one that only saves or
  // sends (asked for 2026-11-21).
  await expect(refine.locator("svg")).toHaveCount(1);

  // Nothing typed: nothing to refine.
  await expect(refine).toBeDisabled();
  await expect(refine).toHaveText("Refine with claude-code");

  // A rough prompt is rewritten in place. (The fake CLI replies with the text in its directive.)
  const rough = `sumarize slack msgs for {{inputs.who}} n list todos ${fake({ text: "Summarise the Slack messages for {{inputs.who}} and list the action items.", sleep_ms: 400, cost: 0.02 })}`;
  await prompt.fill(rough);
  await refine.click();
  await expect(refine).toHaveAttribute("aria-busy", "true");
  await expect(prompt).toHaveValue("Summarise the Slack messages for {{inputs.who}} and list the action items.");
  await expect(tid(page, "node-prompt-refined")).toContainText("Rewritten by claude-code");
  // The price of the rewrite is hidden with the other dollar figures (task 15.24).
  await expect(tid(page, "node-prompt-refined")).not.toContainText("$");
  // Saved like any other edit.
  await expect.poll(async () => (await srv.api("GET", "/api/workflows/refined")).body?.definition?.nodes?.[0]?.prompt).toBe("Summarise the Slack messages for {{inputs.who}} and list the action items.");

  // What the CLI was asked: the typed text, the rules, no servers and no tools.
  const call = chief.calls().at(-1)!;
  expect(call.prompt).toContain(`<prompt>\n${rough}\n</prompt>`);
  expect(call.prompt).toContain("Keep every template placeholder exactly as written");
  expect(call.prompt).toContain("Do not add requirements");
  expect(call.prompt).toContain("prompt of one step of an automated workflow");
  expect(call.argv).toContain("--strict-mcp-config");
  expect(call.argv.join(" ")).toContain("--disallowedTools");
  expect((await srv.api("GET", "/api/runs")).body).toEqual([]);

  // After a refresh the way back is still there, and it restores what was typed.
  await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);
  await page.reload();
  await page.locator(".react-flow__node").first().click();
  await expect(tid(page, "node-prompt-refined")).toBeVisible();
  await tid(page, "node-prompt-refine-undo").click();
  await expect(prompt).toHaveValue(rough);
  await expect(tid(page, "node-prompt-refined")).toHaveCount(0);

  // Refined again and kept: the offer goes away, the text stays.
  await refine.click();
  await expect(tid(page, "node-prompt-refined")).toBeVisible();
  await tid(page, "node-prompt-refine-keep").click();
  await expect(tid(page, "node-prompt-refined")).toHaveCount(0);
  await expect(prompt).toHaveValue("Summarise the Slack messages for {{inputs.who}} and list the action items.");

  // A failure is shown under the field and the text is unchanged.
  await prompt.fill(`broken ${fake({ error: true })}`);
  await refine.click();
  await expect(tid(page, "node-prompt-refine-error")).toContainText("could not refine the prompt");
  await expect(prompt).toHaveValue(`broken ${fake({ error: true })}`);
  expect((await srv.api("POST", "/api/prompts/refine", { text: "  " })).status).toBe(400);

  // An ask gate's instruction has the same button, and the CLI is told what the text is for.
  await drop(page, "palette-gate", 300, 380);
  await tid(page, "node-gate-prompt").fill(`ask me wich ones ${fake({ text: "Show the tasks and let me pick which ones to do." })}`);
  await tid(page, "node-gate-prompt-refine").click();
  await expect(tid(page, "node-gate-prompt")).toHaveValue("Show the tasks and let me pick which ones to do.");
  expect(chief.calls().at(-1)!.prompt).toContain("instruction for a checkpoint");
});

test("E9.38-1 the logo is the tab icon, sits next to the name in the sidebar, and heads the README", async ({ boot, page }) => {
  const srv = await boot();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(srv.url + "/#/runs");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/logo.svg");
  const res = await page.request.get(srv.url + "/logo.svg");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/svg+xml");
  // The file that is served is the one in the source tree (the build is not behind it).
  expect(await res.text()).toBe(readFileSync(join(ROOT_DIR, "packages/web/public/logo.svg"), "utf8"));

  const logo = tid(page, "brand-logo");
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((n: HTMLImageElement) => n.complete && n.naturalWidth > 0)).toBe(true);
  await expect(tid(page, "brand")).toHaveText("chief");
  // In the 72 px rail there is no room for the word beside the logo: it is clipped to a 1 px box for a screen
  // reader, and the logo is the brand a person sees (15.70 removed the state that had the room).
  const [l, name] = [(await logo.boundingBox())!, (await tid(page, "brand").getByText("chief").boundingBox())!];
  expect(name.width, "the word is not drawn in the rail").toBeLessThanOrEqual(1);
  expect(l.x, "the logo sits inside the rail").toBeLessThanOrEqual(72);
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "true");

  const readme = readFileSync(join(ROOT_DIR, "README.md"), "utf8");
  expect(readme.split("\n").slice(0, 6).join("\n")).toContain("packages/web/public/logo.svg");
});

test("E9.41-3 the designer clones the open workflow and opens the copy", async ({ chief, boot, page }) => {
  const srv = await boot();
  await srv.api("PUT", "/api/workflows/weekly", { base_dir: chief.dir, definition: {
    name: "weekly", inputs: { hours: 8 },
    nodes: [
      { id: "collect", type: "agent", mcp: [], prompt: "Collect the updates.", position: { x: 40, y: 40 } },
      { id: "review", type: "gate", kind: "approve", message: "Review", position: { x: 40, y: 200 } },
      { id: "publish", type: "agent", mcp: [], prompt: "Publish them.", position: { x: 40, y: 360 } },
    ],
    edges: [{ from: "collect", to: "review" }, { from: "review", to: "publish" }],
  } });

  // Nothing open: nothing to clone.
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  await expect(tid(page, "btn-clone")).toBeDisabled();

  await page.goto(srv.url + "/#/designer/weekly");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await page.route("**/api/workflows/weekly/clone", async (route) => { await new Promise((r) => setTimeout(r, 500)); await route.fallback(); }, { times: 1 });
  await tid(page, "btn-clone").click();
  await expect(tid(page, "btn-clone")).toHaveAttribute("aria-busy", "true");

  // The copy is open, with the same steps and arrows, and says where it came from.
  await expect(page).toHaveURL(/#\/designer\/weekly-copy$/);
  await wfTab(page);
  await expect(tid(page, "wf-name")).toHaveValue("weekly-copy");
  await expect(tid(page, "designer-note")).toContainText('Cloned "weekly" as "weekly-copy". Type a new name in the Name field to rename it.');
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(tid(page, "wf-picker").locator("option")).toContainText(["weekly", "weekly-copy"]);

  // Typing a name renames the copy; the original stays as it was.
  await wfTab(page);
  await tid(page, "wf-name").fill("weekly-short");
  await expect.poll(async () => (await srv.api("GET", "/api/workflows")).body.map((w: any) => w.name).sort()).toEqual(["weekly", "weekly-short"]);
  const orig = (await srv.api("GET", "/api/workflows/weekly")).body;
  expect(orig.version).toBe(1);
  expect(orig.definition.nodes.map((n: any) => n.id)).toEqual(["collect", "review", "publish"]);
});

test("E9.42-3 on the run page a failed step can be given another model, then the run resumes", async ({ chief, boot, page }) => {
  const err = "Prompt is too long: 251000 tokens > 200000 maximum context length";
  chief.importWorkflow(`name: big\nnodes:\n  - { id: plan, type: agent, mcp: [], prompt: 'PLAN ${fake({ output: { ok: 1 } })}' }\n  - { id: big, type: agent, mcp: [], model: sonnet, prompt: 'BIG ${fake({ by_start: [{ error: err }, { error: err }, { output: { done: true } }] })}' }\nedges: [plan -> big]\n`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "big" });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("failed");
  const id = async (node: string) => { await showStep(page, node); return (await page.locator(`[data-testid^="node-run-"][data-node-id="${node}"]`).last().getAttribute("data-testid"))!.replace("node-run-", ""); };
  const big = await id("big"), plan = await id("plan");

  // The failed step says what happened and what can be done.
  await showStep(page, "big"); // `id()` left the view on plan
  const help = tid(page, `node-failed-help-${big}`);
  await expect(help).toContainText("ran out of room in the model's context window");
  await expect(help).toContainText("only this step and the ones after it run again");
  await showStep(page, "plan");
  await expect(tid(page, `node-failed-help-${plan}`)).toHaveCount(0);
  await showStep(page, "big");
  await help.getByRole("button", { name: "Change its model" }).click();

  // Its details: the hint and a dropdown of the CLI's models, showing the step's current model.
  await expect(tid(page, "step-context-hint")).toBeVisible();
  const select = tid(page, "step-model-select");
  await expect(select).toHaveAttribute("data-loaded", "true");
  await expect(select).toHaveValue("sonnet");
  await expect(select.locator("option")).toContainText(["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
  await select.selectOption("opus");
  await expect.poll(async () => (await srv.api("GET", "/api/runs/1")).body.run.definition.nodes.find((n: any) => n.id === "big").model).toBe("opus");
  await expect(tid(page, "step-model-error")).toHaveCount(0);

  // Resume: the step runs again with the new model and the run completes.
  await tid(page, "btn-resume").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  const bigCalls = chief.calls().filter((c) => c.prompt.startsWith("BIG"));
  expect(bigCalls.at(-1)!.argv[bigCalls.at(-1)!.argv.indexOf("--model") + 1]).toBe("opus");
  expect(chief.calls().filter((c) => c.prompt.startsWith("PLAN"))).toHaveLength(1);
  // Nothing left to change: no model control on completed steps.
  await expect(tid(page, "step-model")).toHaveCount(0);
  await expect(page.locator('[data-testid^="node-failed-help-"]')).toHaveCount(0);
});

test("E9.43-3 on the run page the prompts of unfinished steps can be changed, then the run resumes", async ({ chief, boot, page }) => {
  chief.importWorkflow(`
name: edit
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { ok: 1 } })}' }
  - { id: b, type: agent, mcp: [], prompt: 'B-OLD ${fake({ error: "boom" })}' }
  - { id: c, type: agent, mcp: [], prompt: 'C-OLD ${fake({ output: { c: 1 } })}' }
edges: [a -> b, b -> c]
`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "edit" });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("failed");
  await showStep(page, "b");
  const bRow = page.locator('[data-testid^="node-run-"][data-node-id="b"]').last();
  const def = async (node: string) => (await srv.api("GET", "/api/runs/1")).body.run.definition.nodes.find((n: any) => n.id === node).prompt;

  // The failed step: its prompt in an editable field; typing saves it for the run.
  await bRow.click();
  const prompt = tid(page, "step-prompt");
  await expect(prompt).toHaveValue(/^B-OLD /);
  const bNew = `B-NEW ${fake({ output: { b: 2 } })}`;
  await prompt.fill(bNew);
  await expect.poll(() => def("b")).toBe(bNew);
  await expect(tid(page, "step-edit-status")).toContainText("Saved for this run.");

  // The step that has not started: a tab of its own (15.93), listed there and changed the same way.
  await tid(page, "node-tab-pending").click();
  await expect(tid(page, "not-started")).toContainText("c");
  await tid(page, "pending-step-c").getByRole("button").first().click();
  const cNew = `C-NEW ${fake({ output: { c: 2 } })}`;
  await tid(page, "pending-step-c").getByTestId("step-prompt").fill(cNew);
  // A refresh right after typing loses nothing.
  await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);
  await page.reload();
  await tid(page, "node-tab-pending").click(); // a reload opens the tab that needs attention, not this one
  await tid(page, "pending-step-c").getByRole("button").first().click();
  await expect(tid(page, "pending-step-c").getByTestId("step-prompt")).toHaveValue(cNew);
  await expect.poll(() => def("c")).toBe(cNew);

  // Resume: both are sent their new prompts and the run completes.
  await tid(page, "btn-resume").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect(chief.calls().map((c) => c.prompt.split(" ")[0])).toEqual(["A", "B-OLD", "B-OLD", "B-NEW", "C-NEW"]);
  await expect(tid(page, "not-started")).toHaveCount(0);
});

test("E9.44-2 a step stuck at its own question is changed from the run page with the workflow's newer prompt", async ({ chief, boot, page }) => {
  const oldPrompt = `WRITE-OLD ${fake({ needs_input: { question: "I cannot read the page. Paste it?", proposed: null } }, { output: { status: "declined" } })}`;
  const newPrompt = `WRITE-NEW ${fake({ output: { status: "done" } })}`;
  const srv = await boot();
  const def = (prompt: string) => ({ name: "stuck", nodes: [{ id: "write", type: "agent", mcp: [], prompt }], edges: [] });
  await srv.api("PUT", "/api/workflows/stuck", { base_dir: chief.dir, definition: def(oldPrompt) });
  await srv.api("POST", "/api/runs", { workflow: "stuck" });
  // Like run #24: the prompt is fixed in the designer while the run waits (the workflow becomes version 2).
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("waiting gate");
  await srv.api("PUT", "/api/workflows/stuck", { definition: def(newPrompt) });
  await page.reload();

  // The question box says what an answer does, and offers to change the step instead.
  await expect(tid(page, "gate-change-step")).toContainText("An answer goes into the step's current session");
  await tid(page, "gate-change-step").getByRole("button", { name: "Change this step instead" }).click();

  // The editor offers the workflow's newer prompt; using it withdraws the question and pauses the run.
  await expect(tid(page, "step-newer")).toContainText("version 2 has a different prompt");
  await tid(page, "step-use-newer").click();
  await expect(tid(page, "run-status")).toHaveText("paused");
  expect((await srv.api("GET", "/api/runs/1")).body.run.definition.nodes[0].prompt).toBe(newPrompt);
  await expect(page.locator('[data-reason="needs_input"]')).toHaveCount(0);

  // Resume: the step runs again with the new prompt and the run completes.
  await tid(page, "btn-resume").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  expect(chief.calls().map((c) => c.prompt.split(" ")[0])).toEqual(["WRITE-OLD", "WRITE-NEW"]);
});

test("E9.45-1 JSON on the run page is shown parsed by default, with a switch to the JSON text", async ({ chief, boot, page }) => {
  const result = {
    status: "ok",
    summary: "Line one of the summary.\nLine two, with a link: https://example.test/pr/12",
    count: 3,
    done: false,
    tasks: [{ id: "T1", title: "Review the PR", owner: { name: "Linh" } }, { id: "T2", title: "Reply to Keith" }],
  };
  chief.importWorkflow(`name: parsed\nnodes:\n  - { id: plan, type: agent, mcp: [], prompt: 'Plan ${fake({ output: result })}' }\n  - { id: ok, type: gate, kind: approve, value: "{{nodes.plan.output.tasks}}", message: Go? }\nedges: [plan -> ok]\n`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "parsed" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("waiting gate");
  await showStep(page, "plan");
  await page.locator('[data-testid^="node-run-"][data-node-id="plan"]').click();
  const out = tid(page, "node-output");

  // Parsed by default: names beside values, numbered items, real line breaks, a clickable link, folding.
  await expect(out).toHaveAttribute("data-view", "parsed");
  await expect(tid(page, "node-output-parsed")).toHaveAttribute("aria-pressed", "true");
  const summary = out.locator('[data-json-field="summary"] [data-json="text"]');
  await expect(summary).toHaveText("Line one of the summary.\nLine two, with a link: https://example.test/pr/12");
  expect(await out.innerText()).not.toContain("\\n");
  const link = summary.getByRole("link", { name: "https://example.test/pr/12" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(out.locator('[data-json-field="count"] [data-json="number"]')).toHaveText("3");
  await expect(out.locator('[data-json-field="done"] [data-json="word"]')).toHaveText("false");
  const tasks = out.locator('[data-json-field="tasks"]');
  await expect(tasks.locator("summary").first()).toHaveText("2 items");
  await expect(tasks.locator('[data-json-tree="list"] > div > dt')).toHaveText(["1.", "2."]);
  await expect(tasks.locator('[data-json-field="owner"] [data-json-field="name"]')).toContainText("Linh");
  await tasks.locator("summary").first().click();
  await expect(tasks.locator('[data-json-tree="list"]')).toBeHidden();

  // Copy copies the JSON text, not the tree.
  await tid(page, "node-output-copy").click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toMatchObject(result);

  // The JSON view: the JSON text with its escapes; the choice is remembered across a reload.
  await tid(page, "node-output-json").click();
  await expect(out).toHaveAttribute("data-view", "json");
  await expect(out).toContainText('"summary": "Line one of the summary.\\nLine two');
  await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);
  await page.reload();
  await showStep(page, "plan");
  await page.locator('[data-testid^="node-run-"][data-node-id="plan"]').click();
  await expect(tid(page, "node-output")).toHaveAttribute("data-view", "json");
  await tid(page, "node-output-parsed").click();

  // A gate question is JSON too, and is shown the same way.
  await showStep(page, "ok");
  await page.locator('[data-testid^="node-run-"][data-node-id="ok"]').click();
  await expect(tid(page, "node-input")).toHaveAttribute("data-view", "parsed");
  await expect(tid(page, "node-input").locator('[data-json-field="message"] [data-json="text"]')).toHaveText("Go?");
});

test("E9.45-2 JSON cut off by the size limit is shown as text, without a Parsed view", async ({ chief, boot, page }) => {
  chief.run(["settings", "set", "output-size-limit", "400"]);
  chief.importWorkflow(`name: big\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { blob: "word ".repeat(400) } })}' }\n  - { id: b, type: agent, mcp: [], prompt: 'B ${fake({ output: { ok: 1 } })}' }\nedges: [a -> b]\n`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "big" });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("completed");
  await showStep(page, "b");
  await page.locator('[data-testid^="node-run-"][data-node-id="b"]').click();
  await tid(page, "node-input-raw").click();
  await expect(tid(page, "node-input")).toContainText("truncated by chief");
  await expect(tid(page, "node-input-parsed")).toHaveCount(0);
});

test("E9.46-1 the designer bar has the workflow dropdown, New workflow and Clone; New workflow slides in from the right", async ({ chief, boot, page }) => {
  const srv = await boot();
  for (const n of ["alpha", "beta"]) await srv.api("PUT", `/api/workflows/${n}`, { base_dir: chief.dir, definition: { name: n, nodes: [{ id: "a", type: "agent", mcp: [], prompt: "hi" }], edges: [] } });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");

  // The bar: the dropdown of existing workflows, with New workflow beside it, and Clone on the right; plus
  // Run, Import and Export between them (since 9.59), so that they are in reach with the side panel closed.
  const bar = tid(page, "designer-bar");
  await expect(bar.locator("[data-testid]")).toHaveCount(7);
  for (const id of ["wf-picker", "wf-actions", "btn-run", "btn-import", "btn-export", "btn-new", "btn-clone"]) await expect(bar.getByTestId(id)).toHaveCount(1);
  await expect(tid(page, "wf-picker").locator("option:not([disabled])")).toHaveText(["alpha", "beta"]);
  await expect(tid(page, "wf-picker").locator("option:checked")).toHaveText("Choose a workflow…");
  const [b, picker, nw, clone] = [(await bar.boundingBox())!, (await tid(page, "wf-picker").boundingBox())!, (await tid(page, "btn-new").boundingBox())!, (await tid(page, "btn-clone").boundingBox())!];
  expect(picker.x - b.x).toBeLessThan(120);
  expect(b.x + b.width - (clone.x + clone.width)).toBeLessThan(24);
  // New workflow sits with the picker, not among the row's other buttons: "which workflow am I in" and
  // "start a new one" are the same question, and a button fourth in a row of five is where nobody looks
  // for the way in (reported 2026-11-21).
  expect(nw.x, "New workflow is next to the picker").toBeLessThan(b.x + b.width / 2);
  await expect(tid(page, "btn-new")).toContainText("New workflow");
  await expect(tid(page, "btn-new").locator("svg")).toHaveCount(1);
  // One row: the bar is in the app's top row, left of the notification bell; nothing else sits above the canvas.
  await expect(tid(page, "app-header").getByTestId("designer-bar")).toBeVisible();
  const [header, bell] = [(await tid(page, "app-header").boundingBox())!, (await tid(page, "gates-badge").boundingBox())!];
  expect(clone.x + clone.width).toBeLessThanOrEqual(bell.x);
  expect(Math.abs((picker.y + picker.height / 2) - (bell.y + bell.height / 2))).toBeLessThan(4);
  expect(Math.abs((await tid(page, "palette").boundingBox())!.y - (header.y + header.height))).toBeLessThan(2);
  // The workflow's settings, Run and YAML are in the side panel. The budget fields are not while
  // budgets are hidden (task 15.24).
  await wfTab(page);
  for (const id of ["wf-name", "wf-base-dir", "wf-agent", "wf-inputs"]) await expect(tid(page, "wf-settings").getByTestId(id)).toBeVisible();
  for (const id of ["wf-warn", "wf-max"]) await expect(tid(page, "wf-settings").getByTestId(id)).toHaveCount(0);
  // Run and YAML are in the bar, in reach also when the side panel is closed.
  for (const id of ["btn-run", "btn-import", "btn-export"]) await expect(tid(page, "designer-bar").getByTestId(id)).toBeVisible();

  // New workflow: a panel at the right edge.
  await tid(page, "btn-new").click();
  const panel = tid(page, "new-wf-panel");
  await expect(panel).toBeVisible();
  await expect.poll(async () => { const p = (await panel.boundingBox())!; return Math.round(p.x + p.width); }).toBe(1400);
  await expect(tid(page, "new-wf-backdrop")).toBeVisible();
  const create = tid(page, "new-wf-create");
  await expect(create).toBeDisabled();
  await tid(page, "new-wf-name").fill("Bad Name");
  await expect(tid(page, "new-wf-problem")).toContainText("lower-case letters");
  await tid(page, "new-wf-name").fill("alpha");
  await expect(tid(page, "new-wf-problem")).toContainText('"alpha" already exists');
  await expect(create).toBeDisabled();

  // Escape closes it; what was typed is kept, also across a refresh.
  await tid(page, "new-wf-name").fill("weekly-report");
  await tid(page, "new-wf-agent").selectOption("claude-code");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);
  await page.reload();
  await tid(page, "btn-new").click();
  await expect(tid(page, "new-wf-name")).toHaveValue("weekly-report");
  await expect(tid(page, "new-wf-agent")).toHaveValue("claude-code");
  // Run inputs are not asked for here: a run gives its values when it starts.
  await expect(tid(page, "new-wf-inputs")).toHaveCount(0);

  // Create: an empty canvas with those settings, not saved until it has a step.
  await tid(page, "new-wf-base-dir").fill(chief.dir);
  await create.click();
  await expect(panel).toHaveCount(0);
  await wfTab(page);
  await expect(tid(page, "wf-name")).toHaveValue("weekly-report");
  await expect(tid(page, "wf-agent")).toHaveValue("claude-code");
  await expect(tid(page, "wf-picker").locator("option:checked")).toHaveText("weekly-report (new, not saved yet)");
  await expect(tid(page, "designer-note")).toContainText('New workflow "weekly-report"');
  expect((await srv.api("GET", "/api/workflows")).body.map((w: any) => w.name)).toEqual(["alpha", "beta"]);
  await drop(page, "palette-agent", 300, 160);
  await tid(page, "node-prompt").fill("Write the weekly report.");
  await expect(tid(page, "wf-picker")).toHaveValue("weekly-report");
  const saved = (await srv.api("GET", "/api/workflows/weekly-report")).body;
  expect(saved).toMatchObject({ base_dir: chief.dir, definition: { name: "weekly-report", agent: "claude-code" } });
  expect(saved.definition.inputs ?? {}).toEqual({});

  // Import YAML instead.
  await tid(page, "btn-new").click();
  await tid(page, "new-wf-import").click();
  await expect(tid(page, "new-wf-panel")).toHaveCount(0);
  await expect(tid(page, "import-modal")).toBeVisible();

  // A narrow window has no top row with a bell: the bar is shown above the designer instead.
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(tid(page, "designer-bar")).toBeVisible();
  await expect(tid(page, "app-header")).toBeHidden();
  await expect(tid(page, "page-designer").getByTestId("designer-bar")).toBeVisible();
  await expect(tid(page, "btn-new")).toBeVisible();
});

test("E9.47-1 the notification center is a bell in the top right corner that lists what is waiting", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: g1\nnodes:\n  - { id: check, type: gate, kind: approve, value: go, message: Ship the release? }\n");
  chief.importWorkflow("name: g2\nnodes:\n  - { id: pick, type: gate, kind: input, message: Anything to add? }\n");
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "g1" });
  await srv.api("POST", "/api/runs", { workflow: "g2" });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(srv.url + "/#/settings");

  // Top right, above the page; the sidebar has no badge.
  const bell = tid(page, "gates-badge");
  await expect(bell).toHaveAttribute("data-count", "2");
  await expect(bell).toHaveText("2 gates waiting");
  const [bb, header] = [(await bell.boundingBox())!, (await tid(page, "app-header").boundingBox())!];
  expect(bb.y).toBeLessThan(header.y + header.height);
  expect(1400 - (bb.x + bb.width)).toBeLessThan(24);
  await expect(tid(page, "sidenav").getByTestId("gates-badge")).toHaveCount(0);

  // The list: both gates, with run, step and question; Escape and a click outside close it.
  await bell.click();
  const list = tid(page, "notifications");
  await expect(list.locator('[data-testid^="notification-"]')).toHaveCount(2);
  await expect(list).toContainText("Run #1");
  await expect(list).toContainText("check");
  await expect(list).toContainText("Ship the release?");
  await expect(list).toContainText("Anything to add?");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await bell.click();
  await page.mouse.click(700, 500);
  await expect(list).toHaveCount(0);

  // An item opens its run and closes the list.
  await bell.click();
  await list.getByText("Anything to add?").click();
  await expect(tid(page, "run-title")).toContainText("Run #2");
  await expect(list).toHaveCount(0);
  // The run's panel is as high as the window and lies over the bell: it is closed before the bell is used again.
  await tid(page, "run-panel-close").click();

  // Nothing waiting.
  for (const g of (await srv.api("GET", "/api/gates")).body) await srv.api("POST", `/api/gates/${g.id}/answer`, { answer: g.kind === "approve" ? { decision: "approve" } : { text: "no" } });
  await expect(bell).toHaveAttribute("data-count", "0");
  await bell.click();
  await expect(tid(page, "notifications-empty")).toHaveText("Nothing is waiting for you.");

  // A narrow window keeps the gates in its own top bar.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(tid(page, "app-header")).toBeHidden();
  await expect(tid(page, "gates-badge-bar")).toBeVisible();
});

test("E9.50-1 the building blocks share one tooltip, on the column's heading, that can be scanned", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  // One "?" for the four kinds (reported 2026-11-21: four bubbles in a 224 px column was a column of
  // question marks, and each one described the others too).
  for (const kind of ["agent", "script", "gate", "map"]) await expect(tid(page, `help-block-${kind}`), `${kind} has its own "?"`).toHaveCount(0);
  const one = tid(page, "help-blocks");
  await expect(one).toBeVisible();
  await expect(async () => {
    if (!(await tid(page, "help-text-blocks").isVisible())) await one.click();
    await expect(tid(page, "help-text-blocks")).toContainText("Drag one onto the canvas", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  // It says what each of the four kinds is, and keeps the example (its shape is E15.47-1's subject).
  for (const part of ["Agent", "Script", "Gate", "Map"]) await expect(tid(page, "help-text-blocks")).toContainText(part);
  await expect(tid(page, "help-text-blocks")).toContainText("Example");
  await expect(tid(page, "help-example-blocks")).toContainText("filter-owned.py");
  await page.keyboard.press("Escape");
  await expect(tid(page, "help-text-blocks")).toHaveCount(0);
  // The "?" explains; it does not add a block.
  await one.dblclick();
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await expect(tid(page, "canvas-empty")).toBeVisible();
});

test("E9.51-1 the designer's side panel has a Workflow tab and a Step tab that follows the selection", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: tabs\nnodes:\n  - { id: plan, type: agent, mcp: [], prompt: 'PLAN' }\n  - { id: act, type: agent, mcp: [], prompt: 'ACT' }\nedges: [plan -> act]\n");
  const srv = await boot();
  await page.goto(srv.url + "/#/designer/tabs");
  await expect(tid(page, "flow-node-plan")).toBeVisible();

  // Nothing selected: the workflow's settings; the step's fields are not in the panel at all.
  await expect(tid(page, "tab-workflow")).toHaveAttribute("aria-selected", "true");
  await expect(tid(page, "wf-name")).toHaveValue("tabs");
  await expect(tid(page, "node-panel")).toHaveCount(0);
  // Run, YAML and the save status stay above the tabs on either tab.
  await expect(tid(page, "btn-run")).toBeVisible();

  // Selecting a step opens its tab, named after it, at the top of the panel: no scrolling past the settings.
  await flowNode(page, "plan").click();
  await expect(tid(page, "tab-step")).toHaveAttribute("aria-selected", "true");
  await expect(tid(page, "tab-step")).toHaveText("Step: plan");
  await expect(tid(page, "node-prompt")).toHaveValue("PLAN");
  await expect(tid(page, "node-prompt")).toBeInViewport();
  await expect(tid(page, "wf-name")).toHaveCount(0);
  await expect(tid(page, "btn-run")).toBeVisible();
  // Both boxes in one measurement: the validation card above the tabs arrives a moment after the page
  // (109 px at once), and two separate round trips can land on either side of it, which reads as a gap
  // of 205 px that neither layout has (CI found exactly that). One `evaluate` is one layout.
  const gap = await page.evaluate(() => {
    const box = (testid: string) => document.querySelector(`[data-testid="${testid}"]`)!.getBoundingClientRect();
    return box("node-id").top - box("panel-tabs").bottom;
  });
  expect(gap).toBeLessThan(120);

  // The Workflow tab is one click away and keeps the step selected; going back shows the step again.
  await tid(page, "tab-workflow").click();
  await expect(tid(page, "wf-name")).toBeVisible();
  await expect(tid(page, "tab-step")).toHaveText("Step: plan");
  await tid(page, "tab-step").click();
  await expect(tid(page, "node-id")).toHaveValue("plan");
  // So does a click on the step itself, although it is selected already.
  await tid(page, "tab-workflow").click();
  await flowNode(page, "plan").click();
  await expect(tid(page, "node-id")).toHaveValue("plan");

  // Another step, a connection, and nothing: the tab follows.
  await flowNode(page, "act").click();
  await expect(tid(page, "tab-step")).toHaveText("Step: act");
  await page.locator(".react-flow__edge").first().dispatchEvent("click");
  await expect(tid(page, "tab-step")).toHaveText("Connection");
  await expect(tid(page, "edge-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await tid(page, "canvas").click({ position: { x: 20, y: 20 } });
  await expect(tid(page, "tab-workflow")).toHaveAttribute("aria-selected", "true");
  await expect(tid(page, "wf-name")).toBeVisible();
  await tid(page, "tab-step").click();
  await expect(tid(page, "panel-empty")).toContainText("Select a node to edit it");
});

test("E9.52-1 the workflow's inputs are one JSON with a section per block, shown again when it is run", async ({ chief, boot, page }) => {
  chief.importWorkflow(`
name: by-block
nodes:
  - { id: planner, type: agent, mcp: [], prompt: 'Plan {{inputs.planner.prlink}} ${fake({ output: { steps: 2 } })}' }
  - { id: runner, type: agent, mcp: [], prompt: 'Run in mode {{inputs.runner.mode}} ${fake({ output: { ok: true } })}' }
edges: [planner -> runner]
`);
  const srv = await boot();
  await page.goto(srv.url + "/#/designer/by-block");
  await expect(tid(page, "flow-node-planner")).toBeVisible();

  // The Workflow tab: one JSON for all blocks; a section per block id is added on request.
  await wfTab(page);
  await tid(page, "wf-inputs-by-block").click();
  await expect.poll(async () => JSON.parse(await tid(page, "wf-inputs").inputValue())).toEqual({ planner: {}, runner: {} });
  await tid(page, "wf-inputs").fill('{"planner": {"prlink": "https://x/pull/1"}, "runner": {"mode": "dry"}}');
  await expect.poll(async () => (await srv.api("GET", "/api/workflows/by-block")).body.definition.inputs).toEqual({ planner: { prlink: "https://x/pull/1" }, runner: { mode: "dry" } });
  // Its tooltip shows that structure.
  await tid(page, "help-wf-inputs").click();
  await expect(tid(page, "help-text-wf-inputs")).toContainText("one section per block");
  await expect(tid(page, "help-text-wf-inputs").locator("code")).toContainText('"runner"');
  await page.keyboard.press("Escape");

  // Run starts at once with that JSON, no dialog in between: each block reads its own section.
  await tid(page, "btn-run").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  await expect(tid(page, "start-run")).toHaveCount(0);
  expect(chief.calls()[0].prompt).toContain("Plan https://x/pull/1");
  expect(chief.calls()[1].prompt).toContain("Run in mode dry");
});

test("E9.53-1 JSON is typed in a code editor: colours, line numbers, indenting keys, Format and the place of an error", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: editor\nnodes:\n  - { id: planner, type: agent, mcp: [], prompt: 'PLAN {{inputs.prlink}}' }\n");
  const srv = await boot();
  await page.goto(srv.url + "/#/designer/editor");
  await expect(tid(page, "flow-node-planner")).toBeVisible();
  await wfTab(page);
  const box = tid(page, "wf-inputs"), code = tid(page, "wf-inputs-code");

  // Typing: a bracket closes itself, Enter between the pair indents, Tab indents; the text is still a plain text box's value.
  await box.fill("");
  await box.click();
  await page.keyboard.type("{");
  await expect(box).toHaveValue("{}");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("{\n  \n}");
  await page.keyboard.type('"planner": 1');
  await expect(box).toHaveValue('{\n  "planner": 1\n}');
  await expect(code).toHaveAttribute("data-valid", "true");
  // Colours and line numbers.
  await expect(code.locator('[data-json="key"]')).toHaveText('"planner"');
  await expect(code.locator('[data-json="number"]')).toHaveText("1");
  await expect(code).toContainText("3");
  await expect.poll(async () => (await srv.api("GET", "/api/workflows/editor")).body.definition.inputs).toEqual({ planner: 1 });

  // A syntax error is marked and says where; the workflow keeps its last valid inputs.
  await box.fill('{\n  "planner": {,\n}');
  await expect(code).toHaveAttribute("data-valid", "false");
  await expect(tid(page, "wf-inputs-problem")).toContainText("line 2");
  expect((await srv.api("GET", "/api/workflows/editor")).body.definition.inputs).toEqual({ planner: 1 });

  // Format lays compact JSON out, one field per line.
  await box.fill('{"planner":{"prlink":"x"},"runner":{}}');
  await tid(page, "wf-inputs-format").click();
  await expect(box).toHaveValue('{\n  "planner": {\n    "prlink": "x"\n  },\n  "runner": {}\n}');

  // The same editor is used for a block's output schema and for a run's inputs on the Runs page.
  await flowNode(page, "planner").click();
  await expect(tid(page, "node-output-schema-code")).toBeVisible();
  await page.goto(srv.url + "/#/runs");
  await expect(tid(page, "new-run-inputs-code")).toBeVisible();
});

test("E9.54-1 a gate's panel shows the output of its kind and how a later step reads it", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: gated\nnodes:\n  - { id: plan, type: agent, mcp: [], prompt: 'PLAN' }\n  - { id: decide, type: gate, kind: input, options: [approve, comment] }\nedges: [plan -> decide]\n");
  const srv = await boot();
  await page.goto(srv.url + "/#/designer/gated");
  await flowNode(page, "decide").click();
  const out = tid(page, "gate-output");
  await expect(out).toHaveAttribute("data-kind", "input");
  await expect(tid(page, "gate-output-shape")).toHaveText('{ "text": "…", "option": "…" }');
  // The references use the gate's own id, ready to copy into a prompt.
  await expect(tid(page, "gate-output-ref-option")).toHaveText("{{nodes.decide.output.option}}");
  await expect(tid(page, "gate-output-ref-text")).toHaveText("{{nodes.decide.output.text}}");
  // Each kind has its own shape.
  await tid(page, "node-kind").selectOption("approve");
  await expect(tid(page, "gate-output-shape")).toContainText('"approved": true');
  await expect(out).toContainText("a rejection cancels the run");
  await tid(page, "node-kind").selectOption("select");
  await expect(tid(page, "gate-output-ref-selected")).toHaveText("{{nodes.decide.output.selected}}");
  await tid(page, "node-kind").selectOption("ask");
  await expect(out).toContainText("use one of the fixed forms");
  // The "?" explains that a gate's output is not something to define.
  await tid(page, "help-gate-output").click();
  await expect(tid(page, "help-text-gate-output")).toContainText("fixed by the gate's kind");
});

test("E9.55-1 a tooltip near the bottom of the window opens upwards and stays fully on the page", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: low\nnodes:\n  - { id: plan, type: agent, mcp: [], prompt: 'PLAN' }\n");
  const srv = await boot();
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto(srv.url + "/#/designer/low");
  await flowNode(page, "plan").click();
  // The output schema's "?" is low in the panel: scroll it to the bottom edge of the window.
  const help = tid(page, "help-output-schema");
  await help.evaluate((el) => el.scrollIntoView({ block: "end" }));
  await help.click();
  const tip = tid(page, "help-text-output-schema");
  await expect(tip).toContainText("{{nodes.<id>.output}}");
  const box = (await tip.boundingBox())!, at = (await help.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(520);
  expect(box.y + box.height).toBeLessThanOrEqual(at.y + 1);
  // A tooltip with room below still opens below its "?". (The workflow name's "?" this used to borrow is gone:
  // the label carries the convention and the placeholder shows an example — E15.41-1. Model is the first "?"
  // in the step panel, so it has the panel's whole height below it.)
  await page.keyboard.press("Escape");
  // The bubble takes the roomier side, so a "?" high on the page still opens below it: the flip upwards is
  // a response to the edge, not the default. The building blocks' "?" sits at the top of the palette.
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  await tid(page, "help-blocks").click();
  const below = (await tid(page, "help-text-blocks").boundingBox())!, q = (await tid(page, "help-blocks").boundingBox())!;
  expect(below.y).toBeGreaterThanOrEqual(q.y + q.height);
  expect(below.y + below.height).toBeLessThanOrEqual(900);
});

test("E9.58-1 resuming a stopped run uses the prompt that was fixed in the designer since it started, and says so", async ({ chief, boot, page }) => {
  const wf = (second: string) => `name: fixme\nnodes:\n  - { id: first, type: agent, mcp: [], prompt: 'FIRST ${fake({ output: { ok: 1 } })}' }\n  - { id: second, type: agent, mcp: [], prompt: '${second}' }\nedges: [first -> second]\n`;
  chief.importWorkflow(wf(`BROKEN ${fake({ error: "boom" })}`));
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "fixme" });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("failed");
  await expect(tid(page, "run-outdated")).toHaveCount(0);

  // The prompt is fixed in the workflow (a new version): the run does not change by itself, and says so.
  // The page is not reloaded: it notices by itself.
  chief.importWorkflow(wf(`FIXED ${fake({ output: { ok: 2 } })}`));
  const notice = tid(page, "run-outdated");
  await expect(notice).toContainText("second");
  await expect(notice).toContainText("Resume will use the new version");
  // The run's own version can be kept instead, and the choice can be taken back.
  await tid(page, "run-keep-own").click();
  await expect(notice).toContainText("as it was when this run started");
  await tid(page, "run-keep-own").click();
  await expect(notice).toContainText("Resume will use the new version");
  // Fix the prompt, press Resume: nothing else is needed.
  await tid(page, "btn-resume").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
  // Only the unfinished step ran again, with the new prompt; the completed one kept its result.
  const prompts = chief.calls().map((c) => c.prompt);
  expect(prompts.filter((p) => p.includes("FIRST"))).toHaveLength(1);
  expect(prompts.at(-1)).toContain("FIXED");
});

test("E9.59-1 on a laptop-sized window the designer gives the canvas the room: icon sidebar, block rail, panel on demand", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: roomy\nnodes:\n  - { id: plan, type: agent, mcp: [], prompt: 'PLAN' }\n  - { id: act, type: agent, mcp: [], prompt: 'ACT' }\nedges: [plan -> act]\n");
  const srv = await boot({ compact: true });
  const width = async (id: string) => Math.round((await tid(page, id).boundingBox())!.width);

  // A large window: the blocks column and the panel are open (the rail is icons at every size, 15.70).
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto(srv.url + "/#/designer/roomy");
  await expect(tid(page, "flow-node-plan")).toBeVisible();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "true");
  await expect(tid(page, "palette")).toHaveAttribute("data-full", "true");
  await expect(tid(page, "wf-name")).toBeVisible();
  const wideCanvas = await width("canvas");

  // A 14-inch laptop: the sidebar is icons, the blocks a rail, the panel closed; the canvas has most of the window.
  await page.setViewportSize({ width: 1512, height: 860 });
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "true");
  await expect(tid(page, "palette")).toHaveAttribute("data-full", "false");
  await expect(tid(page, "side-panel")).toBeHidden();
  await expect.poll(() => width("canvas")).toBeGreaterThan(1250);
  expect(await width("canvas")).toBeGreaterThan(wideCanvas);
  // Run, YAML and the state of the autosave are in the top bar, so nothing is out of reach.
  for (const id of ["btn-run", "btn-import", "btn-export", "btn-new", "btn-clone"]) await expect(tid(page, "designer-bar").getByTestId(id)).toBeVisible();
  await expect(tid(page, "designer-status")).toContainText("Saved");
  // The rail still has the four blocks to drag, and the number of servers.
  for (const id of ["palette-agent", "palette-script", "palette-gate", "palette-map"]) await expect(tid(page, id)).toBeVisible();
  await expect(tid(page, "palette-servers-count")).not.toHaveText("…");

  // Selecting a step brings its panel; clicking the empty canvas takes it away again.
  await flowNode(page, "plan").click();
  await expect(tid(page, "node-prompt")).toHaveValue("PLAN");
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 } });
  await expect(tid(page, "side-panel")).toBeHidden();
  // Opened by hand it stays, with the workflow's settings, also after a reload; closed by hand it stays closed.
  await tid(page, "panel-toggle").click();
  await expect(tid(page, "wf-name")).toHaveValue("roomy");
  await refresh(page);
  await expect(tid(page, "wf-name")).toHaveValue("roomy");
  await tid(page, "panel-toggle").click();
  await expect(tid(page, "side-panel")).toBeHidden();
  // The rail opens to the full column with the server list, and closes again.
  await tid(page, "palette-servers").click();
  await expect(tid(page, "palette-mcp-list")).toBeVisible();
  await tid(page, "palette-toggle").click();
  await expect(tid(page, "palette-mcp-list")).toBeHidden();
  // Something wrong opens the panel by itself: an emptied prompt is shown where it can be read.
  await flowNode(page, "act").click();
  await tid(page, "node-prompt").fill("");
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 } });
  await expect(tid(page, "validation-errors")).toBeVisible();
  await expect(tid(page, "designer-status")).toContainText("Not runnable yet");
  // The other pages draw the same rail (one state, 15.70).
  await tid(page, "nav-runs").click();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "true");
});

test("E9.60-1 a run opens in a panel over the run list, with its own address, keys and a full page", async ({ chief, boot, page }) => {
  chief.importWorkflow(`name: one\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { n: 1 } })}' }\n`);
  const srv = await boot();
  for (let i = 0; i < 3; i++) await srv.api("POST", "/api/runs", { workflow: "one" });
  await page.goto(srv.url + "/#/runs");
  await expect(tid(page, "run-row-3")).toBeVisible();
  await expect(tid(page, "run-panel")).toHaveCount(0);
  const tableWidth = Math.round((await tid(page, "runs-table").boundingBox())!.width);

  // A click on a row opens that run beside the list: the list stays, the row is marked, the address is the run's.
  await tid(page, "run-row-2").click();
  await expect(page).toHaveURL(/#\/runs\/2$/);
  const panel = tid(page, "run-panel");
  await expect(panel.getByTestId("run-title")).toContainText("Run #2");
  await expect(panel.getByTestId("run-status")).toHaveText("completed");
  await expect(tid(page, "run-row-2")).toHaveAttribute("data-open", "true");
  await expect(tid(page, "run-row-3")).toBeVisible();
  await expect(tid(page, "run-row-1")).toBeVisible();
  // The panel starts at the top of the run, and takes about two thirds of the window.
  await expect(panel.getByTestId("run-title")).toBeInViewport();
  const box = (await panel.boundingBox())!, win = page.viewportSize()!;
  expect(box.width / win.width).toBeGreaterThan(0.55);
  expect(box.x + box.width).toBeGreaterThanOrEqual(win.width - 1);
  // The run page is all there: the diagram, the steps, the replay.
  await expect(panel.getByTestId("run-diagram")).toBeVisible();
  await expect(panel.getByTestId("timeline")).toBeVisible();

  // Another row, the arrow keys and the buttons change the run without leaving the list.
  // The list keeps its layout under the panel (all its columns, the same width). Nothing is dimmed: there is no backdrop,
  // the panel is as high as the window, and a row left of the panel opens that run.
  // Seven: Run, Workflow, Status, Tokens, Created and the per-row bin's column — plus Cost while cost is shown (15.24, and
  // the bin's column arrived with 15.96). What this asserts is that the panel does not take columns away from the list beside it.
  const columns = await tid(page, "runs-table").locator("thead th").count();
  expect(columns, "the header is all there").toBeGreaterThanOrEqual(6);
  expect(Math.round((await tid(page, "runs-table").boundingBox())!.width)).toBe(tableWidth);
  await expect(tid(page, "run-panel-backdrop")).toHaveCount(0);
  expect((await panel.boundingBox())!.y).toBe(0);
  expect((await panel.boundingBox())!.height).toBeGreaterThanOrEqual(win.height - 1);
  // It came in sliding from the right.
  await expect(panel).toHaveClass(/slide-in-right/);
  await tid(page, "run-row-3").click({ position: { x: 70, y: 12 } });
  await expect(panel.getByTestId("run-title")).toContainText("Run #3");
  await tid(page, "run-row-2").click({ position: { x: 70, y: 12 } });
  await expect(panel.getByTestId("run-title")).toContainText("Run #2");
  await tid(page, "run-panel-prev").click();
  await expect(panel.getByTestId("run-title")).toContainText("Run #3");
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(/#\/runs\/2$/);
  await tid(page, "run-panel-next").click();
  await expect(panel.getByTestId("run-title")).toContainText("Run #1");
  await expect(tid(page, "run-panel-next")).toBeDisabled();
  await tid(page, "run-panel-prev").click();
  await expect(page).toHaveURL(/#\/runs\/2$/);
  // The address opens the same thing after a reload.
  await page.reload();
  await expect(tid(page, "run-panel").getByTestId("run-title")).toContainText("Run #2");
  await expect(tid(page, "run-row-2")).toHaveAttribute("data-open", "true");

  // Escape and the close button close it: it slides out to the right, then it is gone; the list is as it was.
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/#\/runs$/);
  await expect(tid(page, "run-panel")).toHaveCount(0);
  await tid(page, "run-row-1").click();
  // The ✕ is a glyph, not a fourth bordered control in the panel's strip: prev, next and "Open full page" are actions,
  // and a dismissal beside them read as one more of them (asked 2026-11-22: "this should be a text or icon button only").
  const closeLook = await tid(page, "run-panel-close").evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { border: cs.borderWidth, bg: cs.backgroundColor, shadow: cs.boxShadow, w: Math.round(r.width), h: Math.round(r.height), glyph: !!el.querySelector("svg"), text: (el.textContent ?? "").trim() };
  });
  expect(closeLook.border).toBe("0px");
  expect(closeLook.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(closeLook.shadow).toBe("none");
  expect(closeLook.glyph, "drawn, not a ✕ character").toBe(true);
  expect(closeLook.text).toBe("");
  expect(closeLook.w).toBeGreaterThanOrEqual(32);
  expect(closeLook.h).toBeGreaterThanOrEqual(32);

  // The whole strip is navigation, so none of the four controls is a box: the two arrows are drawn glyphs, "Open full
  // page" is a word, and the ✕ is a glyph (asked 2026-11-22, three times on this row).
  const strip = await page.evaluate(() => ["run-panel-prev", "run-panel-next", "run-panel-full"].map((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)!;
    const cs = getComputedStyle(el);
    return { id, border: cs.borderTopWidth, bg: cs.backgroundColor, shadow: cs.boxShadow, glyph: !!el.querySelector("svg"), text: (el.textContent ?? "").trim() };
  }));
  for (const c of strip) {
    expect(c.border, `${c.id} has no border`).toBe("0px");
    expect(c.bg, `${c.id} has no fill`).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(c.shadow, `${c.id} has no shadow`).toBe("none");
  }
  // The arrows are drawn, not `↑`/`↓` characters: those render small and thin at text size.
  const [prev, next, full] = strip;
  expect(prev.glyph && prev.text === "", "prev is a drawn arrow").toBe(true);
  expect(next.glyph && next.text === "", "next is a drawn arrow").toBe(true);
  expect(full.glyph, "full page is a word, not a glyph").toBe(false);
  expect(full.text).toBe("Open full page");

  await page.evaluate(() => {
    (window as any).__slidOut = false;
    new MutationObserver(() => { if (document.querySelector('[data-testid="run-panel"].slide-out-right')) (window as any).__slidOut = true; }).observe(document.body, { subtree: true, attributes: true, childList: true });
  });
  await tid(page, "run-panel-close").click();
  await expect(tid(page, "run-panel")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__slidOut)).toBe(true);

  // Open full page: the run alone, with the way back; a narrow window shows the run alone too.
  await tid(page, "run-row-1").click();
  await tid(page, "run-panel-full").click();
  await expect(page).toHaveURL(/#\/runs\/1\/full$/);
  await expect(tid(page, "run-panel")).toHaveCount(0);
  await expect(tid(page, "runs-table")).toHaveCount(0);
  await expect(tid(page, "run-title")).toContainText("Run #1");
  await page.getByRole("link", { name: "← All runs" }).click();
  await expect(tid(page, "runs-table")).toBeVisible();
  await page.setViewportSize({ width: 800, height: 900 });
  await tid(page, "run-row-3").click();
  await expect(tid(page, "run-title")).toContainText("Run #3");
  await expect(tid(page, "run-panel")).toHaveCount(0);
  await expect(tid(page, "runs-table")).toHaveCount(0);
});

test("E9.61-3 Run again on a run starts a new run with the same inputs and opens it", async ({ chief, boot, page }) => {
  chief.importWorkflow(`name: once\ninputs: { who: team }\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'hello {{inputs.who}} ${fake({ output: { ok: true } })}' }\n`);
  const srv = await boot();
  await srv.api("POST", "/api/runs", { workflow: "once", inputs: { who: "everyone" } });
  await page.goto(srv.url + "/#/runs/1");
  await expect(tid(page, "run-status")).toHaveText("completed");
  await tid(page, "btn-rerun").click();
  // The new run is opened; it ran with the same inputs; the first run is still in the list.
  await expect(page).toHaveURL(/#\/runs\/2$/);
  await expect(tid(page, "run-title")).toContainText("Run #2");
  await expect(tid(page, "run-status")).toHaveText("completed");
  await expect(tid(page, "run-inputs-json")).toContainText('"who": "everyone"');
  await expect(tid(page, "run-row-1")).toHaveCount(1);
  await expect(tid(page, "run-row-2")).toHaveAttribute("data-open", "true");
  expect(chief.calls()[1].prompt).toContain("hello everyone");
});

/**
 * Two affordances in the designer, both reported 2026-11-21 as "you cannot tell this exists":
 *
 *  * with the panel collapsed on a narrow window, the only trace of it was a bare « — a chevron with no
 *    label, which reads as decoration until a dropped block opens the panel by itself;
 *  * the MCP server list put every server of every CLI in one column with no way to fold a group, so a
 *    CLI with thirty servers made the column unreadable (the reporter's had ten).
 */
test("E9.70-1 the collapsed panel says it is a panel, and each CLI's server group folds", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: afford\nnodes:\n  - { id: only, type: agent, mcp: [], prompt: 'ONLY' }\n");
  const srv = await boot({ compact: true });
  try {
    // Narrow enough that the panel starts collapsed.
    await page.setViewportSize({ width: 1512, height: 860 });
    await page.goto(srv.url + "/#/designer/afford");
    await expect(tid(page, "flow-node-only")).toBeVisible();
    await expect(tid(page, "side-panel")).toBeHidden();

    // The strip is a labelled control, not a chevron: it has a name a person can read and a screen reader
    // can announce, and pressing it is what brings the panel back.
    const strip = tid(page, "side-panel-closed");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("Panel");
    const toggle = strip.getByTestId("panel-toggle");
    await expect(toggle).toHaveAttribute("title", /Show the panel/);
    // And it looks like a control: a bordered tab standing on a tinted strip, with a drawn chevron, that
    // fills in on hover. Reported twice — first as a bare `«`, then as a labelled button still too pale to
    // notice at 26 px wide.
    const look = await toggle.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { w: el.getBoundingClientRect().width, border: parseFloat(cs.borderTopWidth), bg: cs.backgroundColor, stripBg: getComputedStyle(el.parentElement!).backgroundColor };
    });
    expect(look.border, "a border, so it reads as a tab and not as the window's edge").toBeGreaterThan(0);
    expect(look.bg, "a surface of its own, not the strip's").not.toBe(look.stripBg);
    expect(look.w, "wide enough to hold a chevron and a word").toBeGreaterThan(20);
    await expect(toggle.locator("svg, .caret"), "the chevron is drawn, not a text glyph").toHaveCount(1);
    const restingBg = await toggle.evaluate((el) => getComputedStyle(el).backgroundColor);
    await toggle.hover();
    await expect.poll(() => toggle.evaluate((el) => getComputedStyle(el).backgroundColor), "hover answers").not.toBe(restingBg);
    await page.mouse.move(5, 300);
    await toggle.click();
    await expect(tid(page, "side-panel")).toBeVisible();
    // The chevron that hides it again is a glyph on the panel itself, not a third button competing with the tabs: no
    // border, no fill, no shadow (asked 2026-11-22: "this can be a text/icon button instead").
    const chevron = tid(page, "side-panel").getByTestId("panel-toggle");
    const chrome = await chevron.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderTopWidth, bg: cs.backgroundColor, shadow: cs.boxShadow };
    });
    expect(chrome.border, "a glyph, not a bordered button").toBe("0px");
    expect(chrome.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(chrome.shadow).toBe("none");
    // Drawn, not a `»` character: a text chevron at 14 px read small and thin beside the app's real icons, which is why
    // its box looked oversized at the same time (asked 2026-11-22: "make this slightly bigger"). 32 px box, 16 px glyph.
    await expect(chevron.locator("svg"), "the chevron is drawn, not a text glyph").toHaveCount(1);
    await expect(chevron).toHaveText("");
    const chevronBox = await chevron.evaluate((el) => ({ w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), svg: Math.round(el.querySelector("svg")!.getBoundingClientRect().width) }));
    expect(chevronBox.h, `the panel's handle is ${chevronBox.h} px tall`).toBeGreaterThanOrEqual(32);
    expect(chevronBox.w).toBeGreaterThanOrEqual(32);
    expect(chevronBox.svg).toBeGreaterThanOrEqual(16);
    await chevron.click();
    await expect(tid(page, "side-panel")).toBeHidden();

    // The server list lives behind the rail's count in this layout. In the 72 px rail the old one-line "14 MCP servers"
    // was clipped mid-word, so it is the count over a caption now, and it must fit inside its own box (reported
    // 2026-11-22).
    const servers = tid(page, "palette-servers");
    const railFit = await servers.evaluate((el) => ({ scrollW: el.scrollWidth, clientW: el.clientWidth, w: el.getBoundingClientRect().width }));
    expect(railFit.scrollW, `"${await servers.innerText()}" overflows its ${Math.round(railFit.w)} px box`).toBeLessThanOrEqual(railFit.clientW + 1);
    await expect(tid(page, "palette-servers-count")).toHaveText(/^\d+$/);
    // The same for the two chevrons that fold the column: glyphs, with no box of their own.
    const paletteToggle = await tid(page, "palette-toggle").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderTopWidth, bg: cs.backgroundColor, svg: !!el.querySelector("svg"), text: el.textContent ?? "" };
    });
    expect(paletteToggle.border).toBe("0px");
    expect(paletteToggle.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    // The same drawn chevron, and the same 32 px box, as the handle that hides the panel.
    expect(paletteToggle.svg, "the column's chevron is drawn too").toBe(true);
    expect(paletteToggle.text).toBe("");
    await servers.click();
    await expect(tid(page, "palette-mcp-list")).toBeVisible();
    // One group per CLI, each a fold. Open by default so the column still says at a glance what is
    // connected; shutting one hides its rows and leaves the count on the header.
    const group = tid(page, "palette-mcp-group-claude-code");
    await expect(group).toHaveAttribute("open", "");
    const rows = group.locator("[data-status]");
    const before = await rows.count();
    expect(before).toBeGreaterThan(0);
    // The caret is what says "this folds": `list-none` had removed the browser's marker, so a header that
    // folds looked like one that does not. It turns when open, and the fold survives a re-render (the list
    // refreshes as the CLIs are looked for; a fixed `open` prop re-opened a group the user had shut).
    const caret = group.locator(":scope > summary .caret");
    const turned = (el: Element) => /matrix\(0,\s*1,\s*-1,\s*0/.test(getComputedStyle(el).transform);
    await expect.poll(() => caret.evaluate(turned)).toBe(true);
    await group.locator(":scope > summary").click();
    await expect(group).not.toHaveAttribute("open", "");
    await expect.poll(() => caret.evaluate(turned)).toBe(false);
    expect(await rows.count()).toBe(before); // still in the DOM, just folded: no re-fetch, no lost rows
    await expect(group.locator(":scope > summary")).toContainText("Claude Code");
    await expect(group.locator(":scope > summary")).toContainText(/connected|set up/);
    // Still shut after the page has done other work (a settings poll, a re-render).
    await page.waitForTimeout(1200);
    await expect(group).not.toHaveAttribute("open", "");
    await group.locator(":scope > summary").click();
    await expect(group).toHaveAttribute("open", "");
    await expect.poll(() => caret.evaluate(turned)).toBe(true);
  } finally {
    await srv.stop();
  }
});


/**
 * Task 15.40: a field that explains itself does not get a "?".
 *
 * The default agent CLI and the output size limit each print their explanation under the field, and each
 * also carried a **?** whose tooltip said the same sentence again (reported 2026-11-21: "this tool tip is
 * not necessary", "not necessary to have this"). The rule this case encodes: a "?" is for an explanation the
 * field has no room for — the CLI paths, the workspace directory, the font size — not a second copy of one
 * already on the page.
 */
test("E15.40-1 a settings field with its own hint carries no tooltip, and one without keeps it", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/settings");
  await expect(page.getByTestId("settings-card")).toBeVisible();

  // The two that repeated themselves: no "?", and the explanation still on the page.
  for (const id of ["setting-default-adapter", "setting-output-size-limit"]) {
    await expect(page.getByTestId(`help-${id}`), `${id} has no "?"`).toHaveCount(0);
  }
  await expect(page.locator("label", { has: page.getByTestId("setting-default-adapter") })).toContainText("when it does not choose one");
  await expect(page.locator("label", { has: page.getByTestId("setting-output-size-limit") })).toContainText("truncated in prompts");

  // The ones that need the room keep theirs — a workspace directory with an example of what it means, and
  // the font size, which changes every page.
  // The text size went the same way later the same day: its hint says it applies to the whole app, which is
  // all a "?" was adding. The workspace directory keeps one — it needs to show what a path means.
  await expect(page.getByTestId("help-setting-font-size")).toHaveCount(0);
  await expect(page.locator("label", { has: page.getByTestId("setting-font-size") })).toContainText("Applies to the whole app");
  await expect(page.getByTestId("help-setting-workspace-dir")).toBeVisible();
});

/**
 * Task 15.41, in one place: the five things the designer showed without saying, reported 2026-11-21.
 * Each is also reached from the case that owns its behaviour (E9.70-1 for the fold, E9.50-1 for the block
 * tooltip, E9.46-1 for the bar, E9.11-1 for the settings); this case is the one the task owns, so the task
 * and the plan keep agreeing, and it reads the changes together as a person sees them.
 */
test("E15.41-1 the designer's affordances say what they are: a caret that turns, one block tooltip, no name tooltip, a visible New workflow, four aligned fields", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: afford\nnodes:\n  - { id: only, type: agent, mcp: [], prompt: 'ONLY' }\n");
  const srv = await boot();
  try {
    await page.setViewportSize({ width: 1512, height: 900 });
    await page.goto(srv.url + "/#/designer/afford");
    await expect(tid(page, "flow-node-only")).toBeVisible();

    // 1. One "?" for the four blocks, on the column's heading; none on the blocks themselves.
    await expect(tid(page, "help-blocks")).toBeVisible();
    for (const kind of ["agent", "script", "gate", "map"]) await expect(tid(page, `help-block-${kind}`)).toHaveCount(0);

    // 2. The server group's caret turns, and the group's fold is React's (it survives a re-render).
    // In the compact layout the list is behind the rail's count; in the full one it is already open.
    if (await tid(page, "palette-servers").isVisible()) await tid(page, "palette-servers").click();
    const group = tid(page, "palette-mcp-group-claude-code");
    await expect(group).toBeVisible();
    const caret = group.locator(":scope > summary .caret");
    await expect(caret).toHaveCount(1);
    const turned = (el: Element) => /matrix\(0,\s*1,\s*-1,\s*0/.test(getComputedStyle(el).transform);
    await expect.poll(() => caret.evaluate(turned)).toBe(true);
    await group.locator(":scope > summary").click();
    await expect(group).not.toHaveAttribute("open", "");
    await expect.poll(() => caret.evaluate(turned)).toBe(false);

    // 3. The workflow's name needs no "?": the example is in the box and the rule is under it.
    await expect(tid(page, "help-wf-name")).toHaveCount(0);
    await expect(tid(page, "wf-name")).toHaveAttribute("placeholder", "daily-triage");
    await expect(page.locator("label", { has: tid(page, "wf-name") })).toContainText("Lower-case letters, digits and dashes");

    // 4. New workflow is beside the picker, marked with a plus.
    const bar = (await tid(page, "designer-bar").boundingBox())!;
    const nw = (await tid(page, "btn-new").boundingBox())!;
    expect(nw.x, "New workflow sits with the picker").toBeLessThan(bar.x + bar.width / 2);
    await expect(tid(page, "btn-new").locator("svg")).toHaveCount(1);

    // 5. The step's four fields are one word each, so they sit on one line and their rows line up.
    await tid(page, "flow-node-only").click();
    for (const label of ["Context", "Agent CLI", "Model", "Tools"]) {
      await expect(tid(page, "side-panel").locator("label", { hasText: new RegExp(`^${label}`) }).first(), label).toBeVisible();
    }
    const heights = await tid(page, "side-panel").locator("select").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(new Set(heights).size, "the selects share one height").toBe(1);
  } finally {
    await srv.stop();
  }
});

/**
 * Task 15.42: two controls that did not look like themselves.
 *
 * Refine is the only action in the step panel that spends an agent call, and it sat beside buttons that only
 * save or send; it carries a sparkle now. The Id field said "lower-case kebab-case" and put the actual rule
 * in a "?", which is the reverse of where a rule belongs.
 */
test("E15.42-1 the Refine button carries the AI mark, and the step's Id explains itself under the field", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: marks\nnodes:\n  - { id: write-it, type: agent, mcp: [], prompt: 'WRITE' }\n");
  const srv = await boot();
  try {
    await page.goto(srv.url + "/#/designer/marks");
    await expect(tid(page, "flow-node-write-it")).toBeVisible();
    await tid(page, "flow-node-write-it").click();
    await expect(tid(page, "side-panel")).toBeVisible();

    // The sparkle: an `svg` on the button, and the button still says what it will do.
    const refine = tid(page, "node-prompt-refine");
    await expect(refine).toBeVisible();
    await expect(refine.locator("svg")).toHaveCount(1);
    await expect(refine).toContainText("Refine with");
    // The icon and the label share one line, and the button is one line tall. `AsyncButton` wraps its
    // children in a span, and as a plain span that span was not a flex container: the two stacked and the
    // button was 42 px tall for one short line (reported 2026-11-21).
    const icon = (await refine.locator("svg").boundingBox())!;
    const whole = (await refine.boundingBox())!;
    expect(whole.height, "one line tall").toBeLessThan(34);
    // Vertically centred on that line, not above the text: same centre, within a pixel.
    const iconMid = icon.y + icon.height / 2, buttonMid = whole.y + whole.height / 2;
    expect(Math.abs(iconMid - buttonMid), "the icon is on the text's line").toBeLessThan(1.5);
    // It is the prompt's refine, not a generic one: the title names the agent it would ask.
    await expect(refine).toHaveAttribute("title", /rewrite this text/);

    // The Id: no "?", and the rule plus this field's placeholders under it.
    await expect(tid(page, "help-node-id")).toHaveCount(0);
    const hint = tid(page, "node-id").locator("xpath=../span[contains(@class,'text-slate-500')]");
    await expect(hint).toContainText("Lower-case letters, digits and dashes");
    await expect(hint).toContainText("{{nodes.write-it.output}}");
    await expect(hint).toContainText("{{nodes.write-it.output.<field>}}");
  } finally {
    await srv.stop();
  }
});



/**
 * Task 15.43: thin scrollbars.
 *
 * Nothing styled them before, so every scrolling box got the platform's: about 15 px wide with an opaque
 * track and arrow gutter, which takes a sixth of the designer's 224 px block column (reported 2026-11-21:
 * "this scrolling bar is thick").
 *
 * The assertion is on the properties, not on a measured gutter: headless Chromium on macOS draws overlay
 * scrollbars, so the box's width minus its client width is 1 px whatever the style says. `scrollbar-width`
 * and `scrollbar-color` are exactly what a *classic* scrollbar obeys, which is the case that was reported.
 */
test("E15.43-1 every scrolling box asks for a thin, translucent scrollbar that is visible in both themes", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: sb\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'A' }\n");
  const srv = await boot();
  try {
    await page.goto(srv.url + "/#/designer/sb");
    await expect(tid(page, "flow-node-a")).toBeVisible();
    const bar = (id: string) => tid(page, id).evaluate((el) => {
      const cs = getComputedStyle(el);
      return { width: cs.scrollbarWidth, color: cs.scrollbarColor };
    });
    // The designer's block column is the tightest box in the app and the one that was reported.
    const light = await bar("palette");
    expect(light.width, "thin, not the platform's 15 px").toBe("thin");
    // A colour, and a transparent track: `rgb(…) rgba(0, 0, 0, 0)`.
    expect(light.color).toMatch(/^(color\(srgb .*\)|rgba?\(.*\))\s+(rgba\(0, 0, 0, 0\)|transparent)$/);
    // The same rule reaches the boxes a person scrolls most: the run record and the assistant.
    expect((await bar("canvas")).width).toBe("thin");

    // Dark: the thumb keeps a colour of its own instead of disappearing into the surface.
    await srv.api("PUT", "/api/settings", { theme: "dark" });
    await page.reload();
    await expect(tid(page, "palette")).toBeVisible();
    const dark = await bar("palette");
    expect(dark.width).toBe("thin");
    expect(dark.color).not.toBe(light.color);
    expect(dark.color).toMatch(/^(color\(srgb .*\)|rgba?\(.*\))\s+(rgba\(0, 0, 0, 0\)|transparent)$/);
  } finally {
    await srv.stop();
  }
});

/**
 * Task 15.44: a labelled way back to the workflow.
 *
 * Panning the canvas far off leaves an empty grid with no way to tell the workflow is still there — the
 * library's fit-view button was a pair of brackets with no label, which is the one control a person needs
 * at that moment (asked for 2026-11-21: "can we have a back to center icon to go back to the center of the
 * canvas if a user moves the canvas too far").
 */
test("E15.44-1 one labelled button brings a workflow that was panned off screen back into view", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: far\nnodes:\n  - { id: near, type: agent, mcp: [], prompt: 'A' }\n  - { id: other, type: agent, mcp: [], prompt: 'B' }\nedges: [near -> other]\n");
  const srv = await boot();
  try {
    await page.setViewportSize({ width: 1400, height: 860 });
    await page.goto(srv.url + "/#/designer/far");
    const node = tid(page, "flow-node-near");
    await expect(node).toBeVisible();

    // It is a named control, not a glyph: a title and an accessible name say what it does.
    const fit = tid(page, "canvas-fit");
    await expect(fit).toBeVisible();
    await expect(fit).toHaveAttribute("title", "Fit the whole workflow in the canvas");
    await expect(fit).toHaveAttribute("aria-label", "Fit the whole workflow in the canvas");
    // The library's unlabelled duplicate is gone, so there is one button for this and not two.
    await expect(page.locator(".react-flow__controls-fitview")).toHaveCount(0);

    // Pan it far away: the node is still mounted but no longer on screen.
    const canvas = (await tid(page, "canvas").boundingBox())!;
    // From the top-right of the canvas: the bottom-left corner holds the zoom controls, where a mousedown
    // does nothing, and a drag that starts on a node moves the node rather than the canvas.
    const from = { x: canvas.x + canvas.width - 60, y: canvas.y + 40 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 1800, from.y - 1200, { steps: 20 });
    await page.mouse.up();
    const away = async () => {
      const box = await node.boundingBox();
      return !box || box.x + box.width < canvas.x || box.y + box.height < canvas.y || box.x > canvas.x + canvas.width || box.y > canvas.y + canvas.height;
    };
    await expect.poll(away, { timeout: 5000 }).toBe(true);

    // The button brings it back inside the canvas.
    await fit.click();
    await expect.poll(async () => {
      const box = await node.boundingBox();
      return !!box && box.x >= canvas.x && box.y >= canvas.y && box.x + box.width <= canvas.x + canvas.width + 1 && box.y + box.height <= canvas.y + canvas.height + 1;
    }, { timeout: 5000 }).toBe(true);
  } finally {
    await srv.stop();
  }
});



/**
 * Task 15.45: a tooltip a person can read.
 *
 * chief bot's "?" opened a bubble with three sections — a 1,300-character paragraph, a use case and an
 * example — which was taller than half the window and reported as *"way too much, no one would read this
 * long instruction"* (2026-11-21). The text was cut to two sentences and the use case dropped; the examples
 * stay, because they are what a person copies.
 */
test("E15.75-1 chief bot's header has no \"?\", because the panel is the explanation", async ({ boot, page }) => {
  // The header carried a "?" whose tooltip summarised the panel — three sections of prose about a place the person is
  // already standing in. 15.45 cut it to two sentences; asked 2026-11-22, the control itself went: "remove this".
  const srv = await boot();
  try {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(srv.url + "/#/designer");
    await page.getByTestId("nav-assistant").click();
    const panel = page.getByTestId("assistant-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("help-assistant"), "no \"?\" in the panel's header").toHaveCount(0);
    await expect(panel.getByTestId("help-text-assistant")).toHaveCount(0);
    // What replaced it is the real thing: the reach it works with, and its past conversations — readable, not described.
    await expect(page.getByTestId("assistant-reach")).toBeVisible();
    await expect(page.getByTestId("assistant-history")).toBeVisible();
  } finally {
    await srv.stop();
  }
});


/**
 * Task 15.46: an async button keeps the layout it was given.
 *
 * `AsyncButton` hides its contents while it spins by wrapping them in a span. As a plain span that wrapper
 * was not a flex container, so a button declared `inline-flex` with an icon stacked the icon above the text
 * — the Refine button was 42 px tall for one short line (reported 2026-11-21: "the icon and the text should
 * be inline instead of a new line"). This case is on the component, so any later async button with an icon
 * is covered by the same check.
 */
test("E15.46-1 an AsyncButton with an icon and a label keeps them on one line, and still hides them while busy", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: btn\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'WRITE' }\n");
  const srv = await boot();
  try {
    await page.goto(srv.url + "/#/designer/btn");
    await expect(tid(page, "flow-node-a")).toBeVisible();

    // The button that was reported: an icon and a label, on one line, centred on each other.
    await tid(page, "flow-node-a").click();
    const refine = tid(page, "node-prompt-refine");
    await expect(refine).toBeVisible();
    await refine.scrollIntoViewIfNeeded();
    const whole = (await refine.boundingBox())!;
    expect(whole.height, "one line tall, not two").toBeLessThan(34);
    // The panel slides in, so a measurement taken mid-animation carries its travel (it read 107 px on a
    // loaded CI runner). Poll: the assertion is as strict, it just waits for the layout to settle.
    await expect.poll(async () => {
      const icon = (await refine.locator("svg").boundingBox())!;
      const now = (await refine.boundingBox())!;
      return Math.abs((icon.y + icon.height / 2) - (now.y + now.height / 2));
    }, { message: "the icon is centred on the button's one line", timeout: 8000 }).toBeLessThan(1.5);

    // The wrapper carries the layout rather than imposing one: `contents` has no box of its own.
    expect(await refine.locator("span").first().evaluate((el) => getComputedStyle(el).display)).toBe("contents");

    // And it still does its job: while the action runs the contents are hidden and a spinner is drawn in
    // their place, without the button changing size (the spinner is absolutely positioned inside it).
    await page.route("**/api/prompts/refine", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    const before = whole.height;
    await refine.click();
    await expect(refine).toHaveAttribute("aria-busy", "true");
    expect(await refine.locator("span").first().evaluate((el) => getComputedStyle(el).visibility), "contents hidden").toBe("hidden");
    await expect(refine.getByTestId("spinner"), "a spinner stands in for the hidden contents").toBeVisible();
    expect((await refine.boundingBox())!.height, "the button does not jump while busy").toBeCloseTo(before, 0);
  } finally {
    await srv.stop();
  }
});

test("E15.47-1 a tooltip is scanned, not read: short lines, rendered as lines", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  // The four blocks were once one 1,249-character paragraph in this bubble, reported as "too clunky and
  // poorly arranged, it's impossible to read for humans" — so the shape is asserted, not only the words.
  const shape = async (id: string) => {
    if (!(await tid(page, `help-text-${id}`).isVisible())) await tid(page, `help-${id}`).click();
    const out = await tid(page, `help-text-${id}`).evaluate((el) => {
      const text = el.querySelector("span")!;
      return {
        raw: text.textContent!,
        whiteSpace: getComputedStyle(text).whiteSpace,
        lines: text.textContent!.split("\n"),
        scrolls: el.scrollHeight > el.clientHeight + 1,
      };
    });
    await page.keyboard.press("Escape");
    return out;
  };
  const scannable = (id: string, got: { raw: string; whiteSpace: string; lines: string[]; scrolls: boolean }) => {
    expect(got.whiteSpace, `${id}: the line breaks are rendered, not collapsed`).toBe("pre-line");
    expect(got.lines.length, `${id}: at most six lines`).toBeLessThanOrEqual(6);
    expect(got.raw.length, `${id}: under 420 characters in a 320 px bubble`).toBeLessThan(420);
    for (const line of got.lines) expect(line.length, `${id}: "${line}" is short enough to read`).toBeLessThan(120);
    expect(got.scrolls, `${id}: the whole tooltip fits, nothing to scroll`).toBe(false);
    for (const line of got.lines) expect(line, `${id}: no semicolon-chained sentence`).not.toMatch(/;\s/);
  };

  scannable("blocks", await shape("blocks"));
  // One line per kind, so a list of four things reads as four things.
  const blocks = await shape("blocks");
  for (const part of ["Agent —", "Script —", "Gate —", "Map —"]) expect(blocks.lines.join("\n")).toContain(part);

  // The same disease was in the step panel: a paragraph each, on the screen a person is in.
  await tid(page, "palette-agent").dragTo(tid(page, "canvas"));
  for (const id of ["context", "output-schema"]) {
    await tid(page, `help-${id}`).evaluate((el) => el.scrollIntoView({ block: "center" }));
    scannable(id, await shape(id));
  }
});

test("E15.49-1 the Start run card is one line, and only shows an inputs editor when there is something to fill in", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: takes-inputs\ninputs: { who: nobody }\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'hello {{inputs.who}}' }\n");
  chief.importWorkflow("name: takes-none\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'PLAIN' }\n");
  const srv = await boot();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(srv.url + "/#/runs");
  const card = tid(page, "new-run");
  await expect(card).toBeVisible();

  // The card says what it is, and the button that starts a run is on the workflow's own line, next to it
  // (reported 2026-11-21: "this entire block looks ugly" — it was a JSON box with the button under a select).
  await expect(card).toContainText("Start a run");
  const row = async () => {
    const pick = (await tid(page, "new-run-workflow").boundingBox())!, start = (await tid(page, "new-run-start").boundingBox())!;
    return { sameLine: Math.abs((pick.y + pick.height) - (start.y + start.height)) <= 4, before: start.x > pick.x + pick.width, card: (await card.boundingBox())! };
  };

  // A workflow that uses no inputs has nothing to type: no editor, and the card is a single line.
  await tid(page, "new-run-workflow").selectOption("takes-none");
  await expect(tid(page, "new-run-inputs-block")).toHaveCount(0);
  await expect(tid(page, "new-run-inputs")).toHaveCount(0);
  const plain = await row();
  expect(plain.sameLine, "the button sits on the select's line").toBe(true);
  expect(plain.before, "the button is next to the workflow, not under it").toBe(true);
  expect(plain.card.height, "no editor, so a short card").toBeLessThan(130);

  // A workflow that uses one does: the editor is there, still the only way in (9.48 removed the input list).
  await tid(page, "new-run-workflow").selectOption("takes-inputs");
  await expect(tid(page, "new-run-inputs")).toBeVisible();
  // The inputs are **in the box**, not a placeholder (15.116): the shape is what a run is filled into, and the workflow's
  // own default is already in it — this workflow defaults `who` to "nobody", so that is what the box starts with.
  await expect(tid(page, "new-run-inputs")).toHaveValue(/"who": "nobody"/);
  await expect(tid(page, "new-run-inputs-refs")).toHaveCount(0);
  await expect(tid(page, "new-run-inputs-template")).toHaveCount(0);
  const withBox = await row();
  expect(withBox.sameLine, "the button keeps its line").toBe(true);
  expect(withBox.card.height, "the editor is below the line, not beside the button").toBeGreaterThan(plain.card.height);

  // A draft typed under one workflow stays visible under another, so it is never sent while invisible.
  await tid(page, "new-run-inputs").fill('{"who": "team"}');
  await tid(page, "new-run-workflow").selectOption("takes-none");
  await expect(tid(page, "new-run-inputs")).toBeVisible();
  await expect(tid(page, "new-run-inputs")).toHaveValue('{"who": "team"}');

  // 375 px: no sideways scrolling, and the button still fits.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(tid(page, "new-run-start")).toBeInViewport();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "the page does not scroll sideways at 375 px").toBeLessThanOrEqual(0);
});

test("E15.116-1 the inputs are given as JSON to fill in, with the workflow's defaults, and follow the workflow", async ({ chief, page }) => {
  // Reported 2026-11-23: *"when i wanna add the parameters for the JSON input before i run the workflow, the given scheme is
  // just a placeholder, and I'm not able to use it directly, and i will have to manually input the json data, which is
  // super tedious"*. The shape was a grey sample behind an empty box, so a nested object meant typing keys, braces and all.
  // It is real text now: the shape, with the workflow's own default where it has one, so only what the workflow leaves
  // open is left to type.
  chief.importWorkflow("name: nested\ninputs:\n  collect-evidence:\n    colleague_name: ''\n    relationship: peer\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'about {{inputs.collect-evidence.colleague_name}} as {{inputs.collect-evidence.relationship}}' }\n");
  chief.importWorkflow("name: plain\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'x' }\n");
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${srv.url}/#/runs`);
    const box = tid(page, "new-run-inputs");
    await expect(box).toBeVisible();
    // Real JSON in the box — the whole nested shape — with the default already filled in and the open field blank.
    await expect(box).toHaveValue(/"collect-evidence"/);
    await expect(box).toHaveValue(/"relationship": "peer"/);
    await expect(box).toHaveValue(/"colleague_name": ""/);
    expect(JSON.parse(await box.inputValue())).toEqual({ "collect-evidence": { colleague_name: "", relationship: "peer" } });

    // It is editable as it stands: filling one value is the whole job, and the run is refused only for the blank.
    await box.fill(JSON.stringify({ "collect-evidence": { colleague_name: "Dana", relationship: "peer" } }, null, 2));
    await tid(page, "new-run-start").click();
    await expect(tid(page, "run-status")).toHaveText("completed", { timeout: 30_000 });
    expect(chief.calls()[0].prompt).toContain("about Dana");

    // After a run the box is the shape again, not empty: the next run is filled into the same shape.
    await page.goto(`${srv.url}/#/runs`);
    await expect(box).toHaveValue(/"relationship": "peer"/);
    await expect(box).not.toHaveValue(/Dana/);

    // Switching to another workflow gives that workflow's shape, and back again gives the first one's.
    await tid(page, "new-run-workflow").selectOption("plain");
    await expect(tid(page, "new-run-inputs-block")).toHaveCount(0);
    await tid(page, "new-run-workflow").selectOption("nested");
    await expect(box).toHaveValue(/"relationship": "peer"/);

    // Text the person typed is theirs: changing the workflow does not throw it away.
    await box.fill('{"collect-evidence": {"colleague_name": "Sam", "relationship": "manager"}}');
    await tid(page, "new-run-workflow").selectOption("plain");
    await tid(page, "new-run-workflow").selectOption("nested");
    await expect(box).toHaveValue(/Sam/);

    // And "Fill in the shape" is always there to get back to it.
    await tid(page, "new-run-inputs-shape").click();
    await expect(box).toHaveValue(/"colleague_name": ""/);
    await expect(box).toHaveValue(/"relationship": "peer"/);
  } finally {
    await srv.stop();
  }
});

test("E15.55-1 Settings › MCP servers lists them read-only and shows each CLI's own add command", async ({ chief, boot, page }) => {
  chief.importWorkflow("name: mcp\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'HI' }\n");
  const srv = await boot();
  await page.goto(srv.url + "/#/settings");
  const section = tid(page, "settings-mcp");
  await expect(section).toBeVisible();

  // It sits outside the settings grid, immediately after it, and had a margin below but none above — the one place on
  // the page where two cards touched (reported 2026-11-22: "why there's no space between this block and the section
  // above?"). It now separates from the grid the way every other card does.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const join = await page.evaluate(() => {
    const mcp = document.querySelector('[data-testid="settings-mcp"]')!;
    const grid = mcp.previousElementSibling!;
    const bottoms = [...grid.children].map((c) => c.getBoundingClientRect().bottom);
    const box = mcp.getBoundingClientRect();
    const above = mcp.previousElementSibling && getComputedStyle(mcp);
    return { gap: Math.round(box.top - Math.max(...bottoms)), marginTop: above ? above.marginTop : null };
  });
  expect(join.gap, "the section is separated from the grid above it").toBeGreaterThanOrEqual(16);
  expect(join.marginTop).not.toBe("0px");

  // It says, before anything else, what it is: a reading, whose one way to add a server is that CLI's own command.
  await expect(section).toContainText("chief reads these; adding one runs the CLI's own command");
  // And it is honest about the folder: the same CLI has different servers in different folders.
  await expect(tid(page, "settings-mcp-folder")).not.toHaveCount(0);

  // Every CLI chief knows has a card, including one that is not installed: "why is Codex not here?" is a
  // question the list answers (its `data-why` says so rather than showing an empty list with no reason).
  for (const agent of ["claude-code", "codex", "cursor", "antigravity", "opencode", "hermes"]) {
    await expect(tid(page, `settings-mcp-agent-${agent}`), agent).toBeVisible();
  }

  // A server row is a reading: no field of its own on any row. The only editable thing in the section is the CLI's
  // own command box, one per card (15.56) — not a form that rebuilds the command the guide already prints.
  await expect(page.locator('[data-testid^="settings-mcp-server-"] input, [data-testid^="settings-mcp-server-"] textarea'), "a row has no field").toHaveCount(0);
  await expect(tid(page, "settings-mcp-command-claude-code")).toBeVisible();

  // The guide is the CLI's own syntax, per CLI, and it distinguishes "a command" from "a file":
  await tid(page, "settings-mcp-how-summary-claude-code").click();
  await expect(tid(page, "settings-mcp-add-claude-code-0")).toContainText("claude mcp add");
  await expect(tid(page, "settings-mcp-where-claude-code")).toContainText("claude mcp");
  // Cursor has no add command at all, and the card must not pretend otherwise: it shows mcp.json.
  await tid(page, "settings-mcp-how-summary-cursor").click();
  await expect(tid(page, "settings-mcp-add-cursor-snippet")).toContainText("mcpServers");
  await expect(tid(page, "settings-mcp-note-cursor")).toContainText("cannot add one");
  // Codex is a config file, so its card is a TOML block.
  await tid(page, "settings-mcp-how-summary-codex").click();
  await expect(tid(page, "settings-mcp-add-codex-snippet")).toContainText("[mcp_servers.");

  // Copy puts the exact line on the clipboard — the point of the section is that it can be pasted.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await tid(page, "settings-mcp-add-claude-code-0-copy").click();
  await expect(tid(page, "settings-mcp-add-claude-code-0-copy")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("claude mcp add");

  // Refresh is the one thing it does do: ask the CLIs again and say what each answered.
  await tid(page, "btn-discover").click();
  await expect(tid(page, "settings-note")).toContainText("claude-code:", { timeout: 30_000 });
});

test("E15.56-1 an MCP command is run from a box you can edit, and its output is shown as it arrives", async ({ chief, boot, page }) => {
  // This was a form with Action / Transport / Command / Arguments / Environment / Headers — it rebuilt the command the
  // guide below already printed, and showed nothing back. Reported 2026-11-21: "the form is so ugly, can you just allow
  // me to run the `claude mcp add …` commands directly … and see the stdio print messages inline?"
  const fake = join(chief.dir, "mcp-cli.sh");
  writeFileSync(fake, [
    "#!/bin/sh",
    'echo "starting $3"',
    'echo "a warning on stderr" >&2',
    `echo "added"`,
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  const srv = await boot({ env: { CHIEF_CLAUDE_BIN: fake } });
  await page.goto(srv.url + "/#/settings");
  // The CLIs with a command get the box; the others do not.
  await expect(tid(page, "settings-mcp-command-claude-code")).toBeVisible();
  await expect(tid(page, "settings-mcp-command-antigravity")).toBeVisible();
  await expect(tid(page, "settings-mcp-command-codex")).toHaveCount(0);
  await expect(tid(page, "settings-mcp-command-cursor")).toHaveCount(0);

  // It arrives filled with the CLI's own command and the values left as placeholders to type over.
  const line = tid(page, "mcp-command-line-claude-code");
  await expect(line).toHaveValue(/mcp add --transport stdio <name> -- npx -y <package>/);

  // Type the name and the package in place, then Run: the output appears inline, stdout and stderr both.
  await line.fill(`${fake} mcp add --transport stdio slack -- npx -y @modelcontextprotocol/server-slack`);
  await tid(page, "mcp-command-run-claude-code").click();
  const out = tid(page, "mcp-output");
  await expect(out).toContainText("starting --transport", { timeout: 20_000 });
  await expect(out).toContainText("a warning on stderr");
  await expect(tid(page, "mcp-output-ok"), "it says how it ended").toContainText("exit 0");

  // The box runs this CLI's own command and nothing else: not another program, not another subcommand, not a pipe.
  const refused = async (cmd: string) => {
    await line.fill(cmd);
    const r = await srv.api("POST", "/api/mcp/command", { adapter: "claude-code", command: cmd });
    return { status: r.status, error: String(r.body.error ?? "") };
  };
  expect((await refused("rm -rf /tmp/x")).status).toBeGreaterThanOrEqual(400);
  expect((await refused("rm -rf /tmp/x")).error).toMatch(/own program/);
  expect((await refused(`${fake} auth login`)).error).toMatch(/mcp command/);
  expect((await refused(`${fake} mcp list | rm -rf /`)).error).toMatch(/no meaning here/);
});

test("E15.57-1 sign-in is offered only where a server is not connected, sign-out where it is, and the CLI's own name is used", async ({ chief, boot, page }) => {
  // The server's state decides which control a row offers, so the two states come from a list this case owns. Taking
  // `.first()` of the real list made it about whichever row sorted first, and that row is an account connector with no
  // control at all. `.mcp.json` gives each a definition, which is what makes it a server of the CLI's own config.
  // `.mcp.json` is what makes a listed server one of the CLI's own configuration rather than an account connector. It is
  // written where discovery reads it — the workspace — as well as in the run folder, since the page discovers from both.
  const defs = JSON.stringify({ mcpServers: { alpha: { command: "npx", args: ["alpha"] }, beta: { command: "npx", args: ["beta"] } } });
  chief.file(".mcp.json", defs);
  const workspace = join(dirname(chief.home), "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, ".mcp.json"), defs);
  const list = chief.file("mcp-list.txt", [
    "alpha: npx -y alpha - ✔ Connected",
    "beta: npx -y beta - ! Needs authentication",
  ].join("\n"));
  const srv = await boot({ env: { FAKE_CLAUDE_MCP_LIST: list } });
  await page.goto(srv.url + "/#/settings");

  // One control, chosen by state — never both (reported 2026-11-21: "sign in should only be available for
  // the MCP that still not authenticated, for the already connected ones, it should be logout").
  await expect(tid(page, "settings-mcp-server-claude-code-alpha")).toHaveAttribute("data-status", "connected");
  await expect(tid(page, "mcp-auth-start-claude-code-alpha")).toHaveText("Sign out");
  await expect(tid(page, "settings-mcp-server-claude-code-beta")).toHaveAttribute("data-status", "needs-auth");
  const signIn = tid(page, "mcp-auth-start-claude-code-beta");
  await expect(signIn).toHaveText("Authenticate");
  const name = "beta";

  // The flows are faked at the API so no real account is touched.
  const posted: any[] = [];
  await page.route("**/api/mcp/auth", async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "f1", adapter: "claude-code", name, action: "login", mode: "url", status: "starting", command: "claude mcp login claude.ai Google Docs --no-browser", url: null, output: "", error: null }) });
  });
  let polls = 0;
  await page.route("**/api/mcp/auth/f1", async (route) => {
    if (route.request().method() === "POST") {
      posted.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "f1", status: "done", url: "https://example.com/authorize?x=1", mode: "url", error: null }) });
      return;
    }
    polls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "f1", status: "waiting_redirect", url: "https://example.com/authorize?x=1", mode: "url", error: null, command: "claude mcp login claude.ai Google Docs --no-browser" }) });
  });

  if (await signIn.count()) {
    await signIn.click();
    // The page sends the server it knows (the slug); the server translates it to the CLI's own name, which
    // is what the request carries here only because the fixture answered with the command.
    expect(posted[0]).toMatchObject({ adapter: "claude-code", action: "login", name });
    await expect(tid(page, `mcp-auth-link-claude-code-${name}`)).toHaveAttribute("href", "https://example.com/authorize?x=1");
    // The command is readable while it runs, so a sign-in that touches credentials is not magic.
    await expect(tid(page, `mcp-auth-cmd-claude-code-${name}`)).toContainText("claude mcp login");
    await expect.poll(() => polls).toBeGreaterThan(0);
    await tid(page, `mcp-auth-redirect-claude-code-${name}`).fill("http://localhost:1/cb?code=SECRET");
    await tid(page, `mcp-auth-answer-claude-code-${name}`).click();
    expect(posted[1]).toEqual({ redirect: "http://localhost:1/cb?code=SECRET" });
    await expect(tid(page, `mcp-auth-result-claude-code-${name}`)).toHaveAttribute("data-status", "done");
    // The code is never persisted anywhere the page can read back.
    const drafts = await srv.api("GET", "/api/drafts?prefix=");
    expect(JSON.stringify(drafts.body)).not.toContain("SECRET");
  }

  // A CLI that cannot sign out shows no Log out: Cursor's only command is `disable`, a different act
  // (found 2026-11-21: offering it as "logout" would quietly disable the server instead).
  const meta = (await srv.api("GET", "/api/meta")).body;
  expect(meta.mcp_auth).toContain("cursor");
  expect(meta.mcp_logout).not.toContain("cursor");
});

test("E15.60-1 a connector row shows its status and nothing else: no control, and no claim about signing in", async ({ chief, boot, page }) => {
  // Reported 2026-11-21: every row of the Claude Code card said "signed in from Claude", next to statuses reading
  // "needs sign-in" — 693 of that machine's 694 rows are account connectors, and the remark was written for the one
  // row it belonged to. A connector is a separate MCP connection, authenticated with its own service, and the CLI
  // has no command for it, so chief must not pretend to have one.
  //
  // The list is the case's own, so the connector states are known and nothing has to be written behind discovery.
  // `github` is the CLI's own server, so it needs a definition to be scoped as configuration rather than as a connector.
  const defs = JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } } });
  chief.file(".mcp.json", defs);
  const workspace = join(dirname(chief.home), "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, ".mcp.json"), defs);
  const list = chief.file("mcp-list.txt", [
    "claude.ai Google Docs: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication",
    "claude.ai Atlassian: https://mcp.atlassian.com/v1/mcp - ✔ Connected",
    "github: npx -y @modelcontextprotocol/server-github - ✘ Failed to connect",
  ].join("\n"));
  const srv = await boot({ env: { FAKE_CLAUDE_MCP_LIST: list } });
  try {
    await page.goto(srv.url + "/#/settings");
    await expect(tid(page, "settings-mcp-agent-claude-code")).toBeVisible();

    // Neither connector offers a control — not even the connected one, whose sign-out chief cannot perform either.
    for (const name of ["google-docs", "atlassian"]) {
      const row = page.locator(`[data-testid="settings-mcp-server-claude-code-${name}"]`);
      await expect(row, name).toBeVisible();
      await expect(row.locator("button"), `${name} has no control`).toHaveCount(0);
      await expect(row, `${name} claims nothing about sign-in`).not.toContainText("signed in from Claude");
    }
    // The status is still there — that is the useful part of the row.
    // The status says what is actually missing: the connection's authentication, not an account to log in to. Said this
  // way after being corrected (2026-11-21): "the sign in is not to sign in into claude's account, it's to
  // authenticate the MCP connection or sign out of the mcp connection".
    await expect(page.locator('[data-testid="settings-mcp-server-claude-code-google-docs"]')).toContainText("needs authentication");

    // Said once, on the card, rather than 54 times on the rows — and it is not a dead end: the one place a
    // person can act on these is the account's own connector page, so the card links there. Reported 2026-11-21:
    // "there's no sign in/sign out action i can perform" — true of the rows, and no help without this.
    await expect(tid(page, "settings-mcp-connectors-claude-code")).toContainText("are MCP connections your Claude Code account provides");
    await expect(tid(page, "settings-mcp-connectors-claude-code")).toContainText("authenticated separately");
    await expect(tid(page, "settings-mcp-connectors-claude-code")).toContainText("cannot do that for one of them");
    const link = tid(page, "settings-mcp-connectors-link-claude-code");
    await expect(link).toHaveAttribute("href", "https://claude.ai/customize/connectors");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toContainText("claude.ai");

    // The CLI's own server is the one that gets a control.
    await expect(page.locator('[data-testid="settings-mcp-server-claude-code-github"] button').first()).toHaveText(/Authenticate/);
  } finally { await srv.stop(); }
});

test("E15.64-1 the CLI's own command is editable in place, runs on demand, and its output appears as it arrives", async ({ chief, boot, page }) => {
  // The form 15.56 shipped rebuilt the command the guide already printed and showed nothing back (reported 2026-11-21).
  const fake = join(chief.dir, "mcp-cli.sh");
  writeFileSync(fake, ["#!/bin/sh", 'echo "starting $3"', 'echo "a warning on stderr" >&2', "echo added", "exit 0", ""].join("\n"), { mode: 0o755 });
  const srv = await boot({ env: { CHIEF_CLAUDE_BIN: fake } });
  await page.goto(srv.url + "/#/settings");
  const box = tid(page, "settings-mcp-command-claude-code");
  await expect(box).toBeVisible();

  // Filled with the CLI's own command, the values left as placeholders to type over.
  const line = tid(page, "mcp-command-line-claude-code");
  await expect(line).toHaveValue(/mcp add --transport stdio <name> -- npx -y <package>/);
  await expect(box).toContainText("no shell, no variables, no pipes");

  // Type the name and package in place, Run, and read the output — stdout and stderr, both inline.
  await line.fill(`${fake} mcp add --transport stdio slack -- npx -y @modelcontextprotocol/server-slack`);
  await tid(page, "mcp-command-run-claude-code").click();
  const out = tid(page, "mcp-output");
  await expect(out).toContainText("starting --transport", { timeout: 20_000 });
  await expect(out).toContainText("a warning on stderr");
  await expect(tid(page, "mcp-output-ok"), "it says how it ended").toContainText("exit 0");

  // The box runs this CLI's own command and nothing else.
  const refuse = async (cmd: string) => (await srv.api("POST", "/api/mcp/command", { adapter: "claude-code", command: cmd })).body.error ?? "";
  expect(await refuse("rm -rf /tmp/x")).toMatch(/own program/);
  expect(await refuse(`${fake} auth login`)).toMatch(/mcp command/);
  expect(await refuse(`${fake} mcp list | rm -rf /`)).toMatch(/no meaning here/);
});

test("E15.45-1 the panel is usable without a tooltip: its reach and history are the controls", async ({ boot, page }) => {
  // 15.45 cut the header's tooltip from three sections to two sentences; 15.75 removed the control. What makes the panel
  // self-explanatory is that what it can reach and where its conversations are, are both on screen.
  const srv = await boot();
  try {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(srv.url + "/#/runs");
    await page.getByTestId("nav-assistant").click();
    await expect(page.getByTestId("assistant-panel")).toBeVisible();
    // One line, not four controls: what it may reach, the folder, and where to change it (task 15.87).
    await expect(page.getByTestId("assistant-reach")).toContainText("read-only");
    await expect(page.getByTestId("assistant-folder")).toContainText("in ");
    await expect(page.getByTestId("assistant-settings-link")).toHaveAttribute("href", "#/settings");
    await expect(page.getByTestId("assistant-tools")).toHaveCount(0);
    await expect(page.getByTestId("assistant-model")).toHaveCount(0);
    await expect(page.getByTestId("assistant-history")).toBeVisible();
  } finally {
    await srv.stop();
  }
});

test("E15.77-1 the MCP list explains itself in a line, not in a tooltip beside its heading", async ({ boot, page }) => {
  // The "?" repeated the sentence printed under the heading, which is the duplication 15.40 removed from settings (asked
  // 2026-11-22: "remove this").
  const srv = await boot();
  try {
    await page.goto(srv.url + "/#/designer");
    await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
    await expect(tid(page, "help-mcp-list"), "no \"?\" on the heading").toHaveCount(0);
    await expect(tid(page, "help-text-mcp-list")).toHaveCount(0);
    const line = tid(page, "palette-mcp-explained");
    await expect(line).toBeVisible();
    await expect(line).toContainText("Not blocks");
  } finally {
    await srv.stop();
  }
});

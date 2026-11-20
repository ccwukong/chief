import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, fake, FAKE_ANTIGRAVITY, FAKE_CODEX, FAKE_CURSOR, FAKE_OPENCODE, ROOMY_LAYOUT_KEYS, ROOT_DIR, test as base, type Server, roomyLayout } from "../helpers";

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
  await refresh(page);
  await expect(tid(page, "draft-notice")).toContainText("Your latest changes were restored.");
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
  await expect(tid(page, "draft-notice")).toHaveCount(0);
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
  await expect(tid(page, "draft-notice")).toBeVisible();
  await expect(tid(page, "flow-node-gate")).toBeVisible();
  await flowNode(page, "plan").click();
  await expect(tid(page, "node-prompt")).toHaveValue("");
  await blocked(page);
  const kept = (await srv.api("GET", "/api/workflows/drafted")).body.definition;
  expect(kept.nodes).toHaveLength(1);
  expect(kept.nodes[0].prompt).toContain("Second line that must not be lost.");

  // "Back to the last valid version" drops the working copy.
  await tid(page, "draft-discard").click();
  await expect(tid(page, "flow-node-gate")).toHaveCount(0);
  await flowNode(page, "plan").click();
  await expect(tid(page, "node-prompt")).toHaveValue(/Second line that must not be lost/);
  expect(await drafts(page, srv)).toEqual([]);
  await saved(page, "drafted", 1);
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
  await expect(tid(page, "new-run-inputs")).toHaveValue("");

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
    await expect(tid(second, "draft-notice")).toBeVisible();
    await expect(tid(second, "flow-node-draft-node")).toBeVisible();
    await flowNode(second, "draft-node").click();
    await expect(tid(second, "node-prompt")).toHaveValue("Typed in the first browser.");
    // Discarding it there removes it for everyone.
    await tid(second, "draft-discard").click();
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
  await expect(tid(page, "draft-notice")).toBeVisible();
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
  await expect(tid(page, "node-agent").locator("option")).toHaveText(["workflow’s (claude-code)", "claude-code", "codex", "cursor", "antigravity", "opencode"]);
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

test("E9.11-1 settings that need explaining have a help tooltip with an example", async ({ boot, page }) => {
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
  await expect(text("wf-base-dir")).toContainText("Leave it empty and the workflow gets its own folder");
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
  await tid(page, "wf-base-dir").focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("help-wf-agent");
  await expect(text("wf-agent")).toContainText("one workflow can use different accounts");
  await page.keyboard.press("Escape");
  await expect(text("wf-agent")).toHaveCount(0);
  for (const id of ["wf-name", "wf-base-dir", "wf-agent"]) await expect(tid(page, `help-${id}`)).toBeVisible();

  // Node panel, for each kind of node. The tooltip is fully on screen even at the right edge of the side panel.
  const inViewport = async (id: string) => {
    const box = (await text(id).boundingBox())!;
    const size = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(size.width);
  };
  const shows = async (id: string, part: string | RegExp) => {
    // The side panel can still be settling (the save status and the check result appear above the
    // fields a moment after a drop), which moves the "?" under the pointer; hover again if so.
    await expect(async () => {
      await tid(page, `help-${id}`).hover();
      await expect(text(id)).toContainText(part, { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    await inViewport(id);
    await page.mouse.move(5, 300);
  };
  await drop(page, "palette-agent", 300, 120);
  await shows("prompt", "What the agent should do");
  await shows("mcp", "By default it may use every server your agent CLI is connected to");
  await shows("model", "The list comes from the agent CLI itself");
  await shows("tools", "read-only");
  await shows("output-schema", '"summary": "string"');
  await shows("compensate-prompt", "Used only when you revert a run");
  await shows("node-id", "{{nodes.plan.output.summary}}");
  await shows("agent", "Use a different agent CLI for this one step");
  await shows("irreversible", "cannot be taken back");

  await drop(page, "palette-script", 300, 300);
  await shows("run", "scripts/summarise.py");
  await shows("sandbox-network", "no network access");
  await shows("sandbox-write", "~/reports");
  await shows("sandbox-env", "GITHUB_TOKEN");
  await shows("timeout", "90s");

  // Inside the canvas next to the sidebar at the default 1280 px window (the canvas is about 460 px wide there).
  await drop(page, "palette-gate", 380, 120);
  await shows("kind", "ask: you describe in plain words what you want to be asked");
  await shows("gate-prompt", "It is an instruction");
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
  await shows("setting-output-size-limit", "the stored result stays complete");
  // The path tooltip belongs to the card of the CLI that is open, and names THAT CLI's own program —
  // not a copy of the first CLI's (what they all used to say: task 15.12).
  await expect(tid(page, "providers")).toBeVisible();
  await page.waitForTimeout(1200); // the CLIs are looked for (one `--version` each)
  const BINARY: Record<string, string> = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent", antigravity: "agy", opencode: "opencode" };
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
  // The default adapter's tooltip lists every value it accepts, not only the first one.
  await tid(page, "help-setting-default-adapter").hover();
  for (const a of Object.keys(BINARY)) await expect(text("setting-default-adapter")).toContainText(a);
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
  // The help explains it.
  await expect(async () => {
    await tid(page, "help-mcp-list").hover();
    await expect(tid(page, "help-text-mcp-list")).toContainText("This is a status list, not something to drag.", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
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
  await expect(page.locator('[data-testid="node-mcp"] input')).toHaveCount(2);
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
  const idOf = async (node: string, item = "") => (await row(node, item).getAttribute("data-testid"))!.replace("node-run-", "");

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
  // Map children each show their own item.
  const c0 = await idOf("each-item", "0"), c1 = await idOf("each-item", "1");
  await expect(tid(page, `node-in-${c0}`)).toContainText("handle alpha");
  await expect(tid(page, `node-in-${c1}`)).toContainText("handle beta");
  await expect(tid(page, `node-out-${c1}`)).toContainText('"handled": true');

  // The compact view is cut short; clicking the node shows the full input, the answer and the output.
  await expect(tid(page, `node-in-${a}`)).not.toContainText("Output contract");
  await tid(page, `node-io-${a}`).click();
  await expect(tid(page, "node-input")).toContainText("Output contract (required by the orchestrator running you)");
  await tid(page, "node-output-json").click();
  await expect(tid(page, "node-output")).toContainText('"count": 21');
  await row("confirm").click();
  await expect(tid(page, "node-answer")).toContainText('"decision": "approve"');

  // The same is in the API.
  const d = (await srv.api("GET", "/api/runs/1")).body;
  expect(d.node_runs[0].io).toEqual({ input_kind: "prompt", input: chief.calls()[0].prompt, answer: null, reply: "Done." });
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
  for (const id of ["nav-runs", "nav-settings", "gates-badge", "btn-new", "btn-run", "btn-import", "wf-picker", "wf-agent", "help-wf-name"]) expect(await cursor(id), id).toBe("pointer");
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
  expect(await cursor("btn-resume")).toBe("not-allowed");
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
  await expect(tid(page, "node-context").locator("option")).toHaveText(["the steps right before it", "every earlier step", "nothing (only what the prompt says)"]);
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
    await expect(tid(page, "help-text-context")).toContainText("steps do not share a conversation", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(tid(page, "help-text-context")).toContainText("can be any JSON");
  await page.mouse.move(5, 300);

  // Run it: on the run page the node shows the author's prompt; its details show the result that was added.
  await tid(page, "btn-run").click();
  await expect(tid(page, "run-status")).toHaveText("completed");
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
  const id = async (node: string) => (await page.locator(`[data-testid^="node-run-"][data-node-id="${node}"]`).getAttribute("data-testid"))!.replace("node-run-", "");
  const plan = await id("plan"), quick = await id("quick");

  // The node says there is more than its result, and how much.
  await expect(tid(page, `node-out-${plan}`)).toContainText('"task_count": 8');
  await expect(tid(page, `node-reply-note-${plan}`)).toContainText(`also wrote ${prose.length} characters of text besides its result`);
  await expect(tid(page, `node-reply-note-${quick}`)).toHaveCount(0);
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
  const row = (node: string) => page.locator(`[data-testid^="node-run-"][data-node-id="${node}"]`);
  const arrow = (node: string) => row(node).locator('[data-testid^="node-arrow-"]');
  const bg = (node: string) => row(node).evaluate((el) => getComputedStyle(el).backgroundColor);
  const edge = (node: string) => row(node).evaluate((el) => getComputedStyle(el).borderLeftColor);

  // Closed: an arrow pointing right, the word "Details", marked as not expanded.
  await expect(row("planner")).toHaveAttribute("aria-expanded", "false");
  await expect(arrow("planner")).toHaveText("▸");
  await expect(row("planner")).toContainText("Details");
  await expect(tid(page, "node-details")).toHaveCount(0);
  const closedBg = await bg("worker");

  // Open: the row is highlighted, the arrow points down, and the panel says whose details these are.
  await row("planner").click();
  await expect(row("planner")).toHaveAttribute("aria-expanded", "true");
  await expect(arrow("planner")).toHaveText("▾");
  await expect(row("planner")).toContainText("Hide");
  await page.mouse.move(5, 5);
  expect(await bg("planner")).not.toBe(closedBg);
  // ... with a coloured bar on its left that the closed row does not have.
  expect(await edge("planner")).not.toBe(await edge("worker"));
  expect(await edge("worker")).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  await expect(tid(page, "node-details")).toHaveAttribute("data-for", "planner");
  await expect(tid(page, "node-details-title")).toHaveText("Details of planner (agent, completed)");
  await tid(page, "node-output-json").click();
  await expect(tid(page, "node-output")).toContainText('"ok": 1');
  // The other row is untouched.
  await expect(row("worker")).toHaveAttribute("aria-expanded", "false");
  expect(await bg("worker")).toBe(closedBg);

  // Opening another row moves the highlight; only one is open.
  await row("worker").click();
  await expect(row("worker")).toHaveAttribute("aria-expanded", "true");
  await expect(row("planner")).toHaveAttribute("aria-expanded", "false");
  await expect(arrow("planner")).toHaveText("▸");
  await expect(tid(page, "node-details")).toHaveCount(1);
  await expect(tid(page, "node-details-title")).toContainText("Details of worker");
  await expect(tid(page, "node-output")).toContainText('"ok": 2');

  // "Hide details" closes it and removes the highlight.
  await tid(page, "node-details-hide").click();
  await expect(tid(page, "node-details")).toHaveCount(0);
  await expect(row("worker")).toHaveAttribute("aria-expanded", "false");
  await page.mouse.move(5, 5);
  expect(await bg("worker")).toBe(closedBg);
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

  await expect(tid(page, "runs-pager-range")).toHaveText("1–25 of 30");
  await expect(tid(page, "runs-pager-page")).toHaveText("Page 1 of 2");
  await expect(rows).toHaveCount(25);
  await expect(tid(page, "run-row-30")).toBeVisible();
  await expect(tid(page, "runs-pager-prev")).toBeDisabled();

  await tid(page, "runs-pager-next").click();
  await expect(tid(page, "runs-pager-range")).toHaveText("26–30 of 30");
  await expect(rows).toHaveCount(5);
  await expect(tid(page, "run-row-1")).toBeVisible();
  await expect(tid(page, "runs-pager-next")).toBeDisabled();
  await tid(page, "runs-pager-prev").click();
  await expect(tid(page, "runs-pager-range")).toHaveText("1–25 of 30");

  await tid(page, "runs-pager-size").selectOption("50");
  await expect(tid(page, "runs-pager-range")).toHaveText("1–30 of 30");
  await expect(rows).toHaveCount(30);
  await expect(tid(page, "runs-pager-page")).toHaveText("Page 1 of 1");
  await tid(page, "runs-pager-size").selectOption("25");

  // The filter starts again at page 1.
  await tid(page, "runs-pager-next").click();
  await expect(tid(page, "runs-pager-range")).toHaveText("26–30 of 30");
  await tid(page, "runs-filter").selectOption("other");
  await expect(tid(page, "runs-pager-range")).toHaveText("1–10 of 10");
  await expect(rows).toHaveCount(10);
  await tid(page, "runs-filter").selectOption("");
  await expect(tid(page, "runs-pager-range")).toHaveText("1–25 of 30");

  // Emptying the last page moves back one page.
  await tid(page, "runs-pager-next").click();
  await expect(tid(page, "runs-pager-range")).toHaveText("26–30 of 30");
  await tid(page, "runs-select-all").check();
  await tid(page, "runs-delete").click();
  await tid(page, "confirm-delete-yes").click();
  await expect(tid(page, "runs-pager-range")).toHaveText("1–25 of 25");
  await expect(tid(page, "runs-pager-page")).toHaveText("Page 1 of 1");
  await expect(rows).toHaveCount(25);
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

test("E9.28-1 the sidebar collapses to icons and stays collapsed after a reload", async ({ boot, page }) => {
  const srv = await boot();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(srv.url + "/#/runs");
  const width = async (id: string) => (await tid(page, id).boundingBox())!.width;
  const mainX = async (key: string) => (await tid(page, `page-${key}`).boundingBox())!.x;
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "false");
  const wide = await width("sidenav"), mainWide = await mainX("runs");
  await expect(tid(page, "nav-collapse")).toHaveAttribute("aria-expanded", "true");
  // An icon button, no words, in the top right corner of the sidebar, above the navigation.
  const toggle = tid(page, "nav-collapse");
  await expect(toggle).toHaveText("");
  await expect(toggle).toHaveAttribute("aria-label", "Collapse the sidebar");
  await expect(toggle.locator("svg")).toHaveCount(1);
  const [tb, sb, rb] = [(await toggle.boundingBox())!, (await tid(page, "sidenav").boundingBox())!, (await tid(page, "nav-runs").boundingBox())!];
  expect(tb.y + tb.height).toBeLessThanOrEqual(rb.y);
  expect(tb.y - sb.y).toBeLessThan(24);
  expect(sb.x + sb.width - (tb.x + tb.width)).toBeLessThan(20);
  expect(tb.x).toBeGreaterThan(sb.x + sb.width / 2);

  const saved = page.waitForResponse((r) => r.url().includes("/api/drafts") && r.request().method() !== "GET");
  await tid(page, "nav-collapse").click();
  await saved;
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "true");
  await expect.poll(() => width("sidenav")).toBe(64);
  // Icons only: the names are tooltips, the gates badge keeps its count.
  await expect(tid(page, "nav-runs")).toHaveAttribute("title", "Runs");
  await expect(tid(page, "nav-designer")).toHaveAttribute("title", "Designer");
  expect(await width("nav-runs")).toBeLessThan(48);
  await expect(tid(page, "gates-badge")).toHaveAttribute("title", "0 gates waiting");
  await expect(tid(page, "gates-badge")).toHaveAttribute("data-count", "0");
  await expect(tid(page, "nav-collapse")).toHaveAttribute("aria-expanded", "false");
  await expect(tid(page, "nav-collapse")).toHaveAttribute("aria-label", "Expand the sidebar");
  // Still at the top, above the navigation.
  expect((await tid(page, "nav-collapse").boundingBox())!.y + 1).toBeLessThan((await tid(page, "nav-runs").boundingBox())!.y);
  // The page widens into the space.
  expect(await mainX("runs")).toBeLessThan(mainWide - 100);

  // Kept across a reload and on every page.
  await page.reload();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "true");
  for (const key of ["designer", "settings", "runs"]) {
    await tid(page, `nav-${key}`).click();
    await expect(tid(page, `page-${key}`)).toBeVisible();
    await expect(tid(page, `nav-${key}`)).toHaveAttribute("aria-current", "page");
    expect(await width("sidenav")).toBe(64);
  }

  await tid(page, "nav-collapse").click();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "false");
  await expect.poll(() => width("sidenav")).toBe(wide);
  await expect(tid(page, "nav-runs")).not.toHaveAttribute("title", /./);
  expect(await width("nav-runs")).toBeGreaterThan(120);
  await expect(tid(page, "brand")).toHaveText("chief");
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
  await expect(start.getByText("Start run")).toBeHidden();
  const busy = (await start.boundingBox())!;
  expect(Math.abs(busy.width - idle.width)).toBeLessThan(1);
  expect(Math.abs(busy.height - idle.height)).toBeLessThan(1);
  release();
  await expect(tid(page, "error")).toHaveText("the server said no");
  await expect(start).not.toHaveAttribute("aria-busy", /./);
  await expect(start.getByText("Start run")).toBeVisible();
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
  const id = async (node: string) => (await page.locator(`[data-testid^="node-run-"][data-node-id="${node}"]`).getAttribute("data-testid"))!.replace("node-run-", "");
  const plan = await id("plan"), gate = await id("ok");

  // The row's preview says that there is more.
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
  await page.locator(`[data-testid="node-run-${gate}"]`).click();
  await expect(tid(page, "node-input")).toHaveAttribute("data-format", "raw");
  await expect(tid(page, "node-input-raw")).toHaveCount(0);
  await expect(tid(page, "node-input")).toHaveAttribute("data-lang", "json");
  await expect(tid(page, "node-input").locator('[data-json="key"]').first()).toHaveText('"message"');
  // The row previews are coloured too.
  await tid(page, "node-details-hide").click();
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
  const id = async (node: string) => (await page.locator(`[data-testid^="node-run-"][data-node-id="${node}"]`).getAttribute("data-testid"))!.replace("node-run-", "");
  const plan = await id("plan"), check = await id("check");

  // The form is inside the gate step's row: in the list of steps, below the step before it.
  const form = tid(page, "timeline").locator('[data-reason="node"][data-kind="input"]');
  await expect(form).toBeVisible();
  await expect(tid(page, `node-gate-${check}`).locator("[data-reason]")).toHaveCount(1);
  await expect(page.locator("[data-reason]")).toHaveCount(1);
  const [f, g, p] = [(await form.boundingBox())!, (await tid(page, `node-run-${check}`).boundingBox())!, (await tid(page, `node-run-${plan}`).boundingBox())!];
  expect(f.y).toBeGreaterThan(g.y);
  expect(g.y).toBeGreaterThan(p.y);
  await expect(tid(page, `node-out-${check}`)).toHaveText("(waiting for your answer)");

  // The notice above the steps names the step and goes to the form.
  await expect(tid(page, "gate-notice")).toContainText("waiting for your answer at step check");
  expect((await tid(page, "gate-notice").boundingBox())!.y).toBeLessThan(p.y);
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
  const [l, name] = [(await logo.boundingBox())!, (await tid(page, "brand").getByText("chief").boundingBox())!];
  expect(l.x + l.width).toBeLessThanOrEqual(name.x);
  await tid(page, "nav-collapse").click();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "true");
  await expect(logo).toBeVisible();

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
  const id = async (node: string) => (await page.locator(`[data-testid^="node-run-"][data-node-id="${node}"]`).last().getAttribute("data-testid"))!.replace("node-run-", "");
  const big = await id("big"), plan = await id("plan");

  // The failed step says what happened and what can be done.
  const help = tid(page, `node-failed-help-${big}`);
  await expect(help).toContainText("ran out of room in the model's context window");
  await expect(help).toContainText("only this step and the ones after it run again");
  await expect(tid(page, `node-failed-help-${plan}`)).toHaveCount(0);
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

  // The step that has not started: listed, and changed the same way.
  await expect(tid(page, "not-started")).toContainText("c");
  await tid(page, "pending-step-c").getByRole("button").first().click();
  const cNew = `C-NEW ${fake({ output: { c: 2 } })}`;
  await tid(page, "pending-step-c").getByTestId("step-prompt").fill(cNew);
  // A refresh right after typing loses nothing.
  await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);
  await page.reload();
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
  await page.locator('[data-testid^="node-run-"][data-node-id="plan"]').click();
  await expect(tid(page, "node-output")).toHaveAttribute("data-view", "json");
  await tid(page, "node-output-parsed").click();

  // A gate question is JSON too, and is shown the same way.
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

  // The bar: the dropdown of existing workflows on the left, New workflow and Clone on the right; nothing else.
  const bar = tid(page, "designer-bar");
  // (and, since 9.59, Run, Import and Export between them, so that they are in reach with the side panel closed)
  await expect(bar.locator("[data-testid]")).toHaveCount(7);
  for (const id of ["wf-picker", "wf-actions", "btn-run", "btn-import", "btn-export", "btn-new", "btn-clone"]) await expect(bar.getByTestId(id)).toHaveCount(1);
  await expect(tid(page, "wf-picker").locator("option:not([disabled])")).toHaveText(["alpha", "beta"]);
  await expect(tid(page, "wf-picker").locator("option:checked")).toHaveText("Choose a workflow…");
  const [b, picker, nw, clone] = [(await bar.boundingBox())!, (await tid(page, "wf-picker").boundingBox())!, (await tid(page, "btn-new").boundingBox())!, (await tid(page, "btn-clone").boundingBox())!];
  expect(picker.x - b.x).toBeLessThan(120);
  expect(b.x + b.width - (clone.x + clone.width)).toBeLessThan(24);
  expect(nw.x).toBeGreaterThan(b.x + b.width / 2);
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

test("E9.50-1 every building block has a tooltip that says how it works", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
  const expected: Record<string, string[]> = {
    agent: ["Runs your agent CLI once with the prompt you write", "given the results of the steps whose arrows point to it"],
    script: ["in a sandbox", "JSON on its stdin"],
    gate: ["waits for you", "Your answer is the gate's result", "an input gate with options never does"],
    map: ["for every item of a list", "{{item}} is the current item"],
  };
  for (const [kind, texts] of Object.entries(expected)) {
    await expect(async () => {
      if (!(await tid(page, `help-text-block-${kind}`).isVisible())) await tid(page, `help-block-${kind}`).click();
      await expect(tid(page, `help-text-block-${kind}`)).toContainText(texts[0], { timeout: 1000 });
    }).toPass({ timeout: 15_000 });
    for (const t of texts) await expect(tid(page, `help-text-block-${kind}`)).toContainText(t);
    await expect(tid(page, `help-text-block-${kind}`)).toContainText("Example");
    // A use case from a real workflow makes it concrete.
    await expect(tid(page, `help-use-block-${kind}`)).toContainText({ agent: "You want a pull request reviewed", script: "only want the ones in files you own", gate: "you want the last word", map: "three today, eight tomorrow" }[kind]!);
    await page.keyboard.press("Escape");
    await expect(tid(page, `help-text-block-${kind}`)).toHaveCount(0);
  }
  // The "?" explains; it does not add a block, not even on a double-click (which adds one anywhere else on the entry).
  await tid(page, "help-block-agent").dblclick();
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
  const tabs = (await tid(page, "panel-tabs").boundingBox())!, id = (await tid(page, "node-id").boundingBox())!;
  expect(id.y - (tabs.y + tabs.height)).toBeLessThan(120);

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
  chief.importWorkflow("name: editor\nnodes:\n  - { id: planner, type: agent, mcp: [], prompt: 'PLAN' }\n");
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
  // A tooltip with room below still opens below its "?".
  await page.keyboard.press("Escape");
  await wfTab(page);
  await tid(page, "help-wf-name").click();
  const below = (await tid(page, "help-text-wf-name").boundingBox())!, q = (await tid(page, "help-wf-name").boundingBox())!;
  expect(below.y).toBeGreaterThanOrEqual(q.y + q.height);
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

  // A large window: everything open, as before.
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto(srv.url + "/#/designer/roomy");
  await expect(tid(page, "flow-node-plan")).toBeVisible();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "false");
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
  // The other pages keep the sidebar as the user left it.
  await tid(page, "nav-runs").click();
  await expect(tid(page, "sidenav")).toHaveAttribute("data-collapsed", "false");
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
  await expect(tid(page, "runs-table").locator("thead th")).toHaveCount(5);
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

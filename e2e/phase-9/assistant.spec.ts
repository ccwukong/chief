import type { Page } from "@playwright/test";
import { expect, fake, test as base, type Server, roomyLayout } from "../helpers";

/** Task 9.64: the floating assistant. One conversation about chief, with the run on show as its context. */

const test = base.extend<{ boot: () => Promise<Server> }>({
  boot: async ({ chief }, use) => {
    const started: Server[] = [];
    await use(async () => { const s = await chief.serve(); started.push(s); await roomyLayout(s); return s; });
    for (const s of started) await s.stop();
  },
});
const tid = (page: Page, id: string) => page.getByTestId(id);

const OK = `name: fine\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { ok: 1 } })}' }\n`;
const BROKEN = `name: broken\nnodes:\n  - { id: plan, type: agent, mcp: [], prompt: 'PLAN ${fake({ output: { ok: 1 } })}' }\n  - { id: big, type: agent, mcp: [], prompt: 'BIG ${fake({ error: "boom" })}' }\nedges: [plan -> big]\n`;
const GATED = "name: gated\nnodes:\n  - { id: g, type: gate, kind: approve, value: ship it }\n";
const status = async (s: Server, id: number, want: string) => expect.poll(async () => (await s.api("GET", `/api/runs/${id}`)).body.run?.status, { timeout: 20_000 }).toBe(want);

test("E9.64-1 the assistant answers about chief as a whole, continues while nothing happens, starts over when something does, and takes a run as context", async ({ chief }) => {
  chief.importWorkflow(OK);
  chief.importWorkflow(BROKEN);
  chief.importWorkflow(GATED);
  const s = await chief.serve();
  try {
    const broken = (await s.api("POST", "/api/runs", { workflow: "broken" })).body.run.id as number;
    await status(s, broken, "failed");
    const gated = (await s.api("POST", "/api/runs", { workflow: "gated" })).body.run.id as number;
    await status(s, gated, "waiting_gate");

    const empty = await s.api("GET", "/api/assistant");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ adapter: "claude-code", conversation: [] });

    // A question with no run: the overview, no record, no tools.
    const q1 = `which runs failed? ${fake({ text: `Run #${broken} failed at step **big**: boom.`, cost: 0.02 }, { text: "Follow-up: the gate in the other run is waiting." })}`;
    const a1 = await s.api("POST", "/api/assistant", { question: q1 });
    expect(a1.status).toBe(200);
    expect(a1.body).toMatchObject({ answer: `Run #${broken} failed at step **big**: boom.`, adapter: "claude-code", model: null, cost_usd: 0.02, resumed: false, run_id: null });
    expect(a1.body.conversation.map((t: any) => t.role)).toEqual(["user", "assistant"]);
    const call = chief.calls().filter((c) => c.prompt.includes("## The question")).at(-1)!;
    expect(call.prompt).toContain("not looking at a particular run");
    expect(call.prompt).toContain("## Workflows");
    expect(call.prompt).toContain("- broken (version 1): plan (agent), big (agent)");
    expect(call.prompt).toContain(`- run #${broken}: broken v1, failed`);
    expect(call.prompt).toContain("error: node \"big\"");
    expect(call.prompt).toContain(`- gate 1 in run #${gated} at step g (approve, node)`);
    expect(call.prompt).not.toContain("## What ran, in order");
    expect(call.argv).toContain("--disallowedTools");
    expect(call.resume).toBeNull();

    // Nothing happened since: the follow-up continues the CLI session.
    const a2 = await s.api("POST", "/api/assistant", { question: "and the other run?" });
    expect(a2.body).toMatchObject({ answer: "Follow-up: the gate in the other run is waiting.", resumed: true });
    expect(chief.calls().at(-1)!.resume).toBe(call.session);

    // Something happened (a run): the next question starts over, with the earlier exchanges.
    const fine = (await s.api("POST", "/api/runs", { workflow: "fine" })).body.run.id as number;
    await status(s, fine, "completed");
    const a3 = await s.api("POST", "/api/assistant", { question: `and now? ${fake({ text: "Now one more run completed." })}` });
    expect(a3.body).toMatchObject({ answer: "Now one more run completed.", resumed: false });
    const fresh = chief.calls().at(-1)!;
    expect(fresh.resume).toBeNull();
    expect(fresh.prompt).toContain("## Earlier questions and answers");
    expect(fresh.prompt).toContain("Follow-up: the gate in the other run is waiting.");
    expect(fresh.prompt).toContain(`- run #${fine}: fine v1, completed`);

    // A run as context: its record is given, and the answer says which run it was about.
    const a4 = await s.api("POST", "/api/assistant", { question: `what went wrong? ${fake({ text: "Step big: boom." })}`, run_id: broken, model: "haiku" });
    expect(a4.body).toMatchObject({ answer: "Step big: boom.", run_id: broken, model: "haiku", resumed: false });
    const withRun = chief.calls().at(-1)!;
    expect(withRun.prompt).toContain(`looking at the page of run #${broken}`);
    expect(withRun.prompt).toContain("# The run the person is looking at");
    expect(withRun.prompt).toContain("### Step big (agent, attempt 1): failed");
    expect(withRun.argv[withRun.argv.indexOf("--model") + 1]).toBe("haiku");
    expect(a4.body.conversation.at(-1).meta).toMatchObject({ run_id: broken, cost_usd: 0.01, adapter: "claude-code", model: "haiku" });
    expect(a4.body.conversation.at(-2).meta.run_id).toBe(broken);

    // Everything is kept, in its own schema; the runs' own records and costs are untouched.
    const tables = Object.fromEntries((await s.api("GET", "/api/doctor")).body.db.schemas.assistant.map((t: any) => [t.table, t.rows]));
    expect(tables).toEqual({ messages: 12 });
    expect(((await s.api("GET", `/api/runs/${broken}/transcript`)).body as any[]).some((m) => m.kind.startsWith("ask_"))).toBe(false);

    // New chat, and the errors.
    expect((await s.api("DELETE", "/api/assistant")).body).toEqual({ cleared: 12 });
    expect((await s.api("GET", "/api/assistant")).body.conversation).toEqual([]);
    const blank = await s.api("POST", "/api/assistant", { question: " " });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toMatch(/no question yet/);
    expect((await s.api("POST", "/api/assistant", { question: "hi", run_id: 999 })).status).toBe(404);
  } finally { await s.stop(); }
});

test("E9.64-2 the floating button is on every page, the panel follows the page, stays open across a reload, and fits a phone", async ({ chief, boot, page }) => {
  chief.importWorkflow(OK);
  const srv = await boot();
  const id = (await srv.api("POST", "/api/runs", { workflow: "fine" })).body.run.id as number;
  await status(srv, id, "completed");

  for (const path of ["/#/runs", "/#/designer", "/#/settings"]) {
    await page.goto(srv.url + path);
    const btn = tid(page, "assistant-button");
    await expect(btn, path).toBeVisible();
    const box = (await btn.boundingBox())!;
    const size = page.viewportSize()!;
    expect(box.x + box.width, path).toBeGreaterThan(size.width - 40);
    expect(box.y + box.height, path).toBeGreaterThan(size.height - 40);
    await expect(btn.locator("img"), path).toHaveAttribute("src", "/logo.svg");
    await expect(tid(page, "assistant-panel"), path).toHaveCount(0);
  }

  // Open: the panel is about chief; it is still open after a reload; three ways to close it.
  await tid(page, "assistant-button").click();
  await expect(tid(page, "assistant-panel")).toBeVisible();
  await expect(tid(page, "assistant-context")).toHaveText("about chief");
  await expect(tid(page, "assistant-suggestion-0")).toHaveText("Which runs failed, and why?");
  await page.waitForFunction(() => !(window as any).__chiefDraftWrites);
  await page.reload();
  await expect(tid(page, "assistant-panel")).toBeVisible();
  await tid(page, "assistant-close").click();
  await expect(tid(page, "assistant-panel")).toHaveCount(0);
  await tid(page, "assistant-button").click();
  await expect(tid(page, "assistant-panel")).toBeVisible();
  await tid(page, "assistant-button").click();
  await expect(tid(page, "assistant-panel")).toHaveCount(0);
  await tid(page, "assistant-button").click();
  await tid(page, "assistant-question").press("Escape");
  await expect(tid(page, "assistant-panel")).toHaveCount(0);

  // The context follows the page: a run's page, and back.
  await tid(page, "assistant-button").click();
  await page.goto(`${srv.url}/#/runs/${id}`);
  await expect(tid(page, "assistant-context")).toHaveText(`about run #${id}`);
  await expect(tid(page, "assistant-suggestion-1")).toHaveText(`Summarise run #${id} in plain words`);
  await page.goto(srv.url + "/#/runs");
  await expect(tid(page, "assistant-context")).toHaveText("about chief");

  // A question on the Runs page, then New chat.
  await tid(page, "assistant-question").fill(`what is waiting? ${fake({ text: "Nothing is waiting for you." })}`);
  await tid(page, "assistant-send").click();
  await expect(tid(page, "assistant-turn-assistant")).toContainText("Nothing is waiting for you.");
  await expect(tid(page, "assistant-turn-meta")).toContainText("claude-code");
  await expect(tid(page, "assistant-turn-meta")).not.toContainText("$");
  await expect(tid(page, "assistant-turn-meta")).not.toContainText("run #");
  await tid(page, "assistant-new").click();
  await expect(tid(page, "assistant-turn-assistant")).toHaveCount(0);
  await expect(tid(page, "assistant-empty")).toBeVisible();
  expect((await srv.api("GET", "/api/assistant")).body.conversation).toEqual([]);

  // A phone: the panel fits and nothing scrolls sideways.
  await page.setViewportSize({ width: 375, height: 700 });
  const panel = (await tid(page, "assistant-panel").boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(375);
  expect(panel.y).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

// ── task 9.65: in the designer the assistant builds and changes the workflow on the canvas ──

const block = (tag: string, v: unknown) => "```" + tag + "\n" + JSON.stringify(v, null, 2) + "\n```";
const TWO = {
  name: "review",
  nodes: [
    { id: "collector", type: "agent", prompt: "Collect the data points for {{inputs.collector.team}}." },
    { id: "analyst", type: "agent", prompt: "Write the report from:\n{{nodes.collector.output}}" },
  ],
  edges: [{ from: "collector", to: "analyst" }],
  inputs: { collector: { team: "core" } },
};
const THREE = { ...TWO, nodes: [...TWO.nodes, { id: "check", type: "gate", kind: "ask", prompt: "Show me the report and ask whether to send it." }], edges: [...TWO.edges, { from: "analyst", to: "check" }] };
const OPTIONS = { question: "Should a person approve the report?", options: ["Add an approval gate after analyst", "Leave it as it is"] };
const saved = (page: Page) => page.waitForFunction(() => { const el = document.querySelector('[data-testid="autosave-status"]'); return el?.getAttribute("data-state") === "saved" && el.getAttribute("data-dirty") === "false"; });
const steps = async (s: Server, name: string) => ((await s.api("GET", `/api/workflows/${name}`)).body.definition?.nodes ?? []).map((n: any) => n.id);

test("E9.65-1 asked with the canvas, the assistant returns a checked workflow as a change, asks once for a correction, and never sets a model or a sandbox", async ({ chief }) => {
  const s = await chief.serve();
  try {
    // An empty canvas: the agent is told so, is given the format, and its workflow comes back as a change. Nothing is stored here.
    const q1 = `build a review workflow ${fake({ text: `I built two steps.\n\n${block("chief-workflow", TWO)}\n\n${block("chief-options", OPTIONS)}`, cost: 0.02 }, { text: `I added the gate.\n\n${block("chief-workflow", THREE)}` })}`;
    const a1 = await s.api("POST", "/api/assistant", { question: q1, workflow: { definition: { name: "", nodes: [], edges: [] } } });
    expect(a1.status).toBe(200);
    expect(a1.body).toMatchObject({ answer: "I built two steps.", workflow: "review", run_id: null, resumed: false, change_error: null, options: OPTIONS, cost_usd: 0.02 });
    expect(a1.body.change.summary).toEqual(['New workflow "review"', "Added: collector, analyst", "Connected: collector → analyst", "Workflow settings: inputs"]);
    expect(a1.body.change.before).toEqual({ name: "", nodes: [], edges: [] });
    expect(a1.body.change.after).toMatchObject({ name: "review", edges: TWO.edges, inputs: TWO.inputs });
    expect((await s.api("GET", "/api/workflows")).body).toEqual([]);
    const first = chief.calls().at(-1)!;
    expect(first.prompt).toContain("## The workflow format");
    expect(first.prompt).toContain("The canvas is empty and the workflow has no name yet");
    expect(first.prompt).toContain("```chief-workflow");
    expect(first.prompt).toContain("```chief-options");
    // It is given the rest of chief too, so a question asked here ("which runs failed?") can be answered
    // instead of refused — the panel follows the page, but people ask it whatever is on their mind.
    expect(first.prompt).toContain("## Runs");
    expect(first.argv).toContain("--disallowedTools");

    // The canvas as the page then has it (with a layout): the follow-up continues the session; the layout is neither sent nor returned.
    const canvas = { ...a1.body.change.after, nodes: a1.body.change.after.nodes.map((n: any, i: number) => ({ ...n, position: { x: 60, y: 40 + i * 130 } })) };
    const a2 = await s.api("POST", "/api/assistant", { question: OPTIONS.options[0], workflow: { definition: canvas } });
    expect(a2.body).toMatchObject({ answer: "I added the gate.", resumed: true, options: null });
    expect(a2.body.change.summary).toEqual(["Added: check", "Connected: analyst → check"]);
    expect(a2.body.change.before.nodes[0].position).toEqual({ x: 60, y: 40 });
    expect(a2.body.change.after.nodes.every((n: any) => n.position === undefined)).toBe(true);
    expect(chief.calls().at(-1)!.resume).toBe(first.session);

    // A workflow chief does not accept: one correction is asked for, with the reasons, in the same session.
    const bad = { ...TWO, nodes: [TWO.nodes[0], { id: "analyst", type: "agent", prompt: "Use {nodes.collector.output}" }] };
    const a3 = await s.api("POST", "/api/assistant", { question: `shorten the prompt ${fake({ text: `Here.\n${block("chief-workflow", bad)}` }, { text: `Corrected.\n${block("chief-workflow", { ...TWO, description: "reviews" })}` })}`, workflow: { definition: TWO } });
    expect(a3.body).toMatchObject({ answer: "Corrected.", change_error: null, cost_usd: 0.02, resumed: false });
    expect(a3.body.change.summary).toEqual(["Workflow settings: description"]);
    const fix = chief.calls().at(-1)!;
    expect(fix.prompt).toContain("chief did not accept that, so nothing was changed");
    expect(fix.prompt).toContain("write {{nodes.collector.output}}");
    expect(chief.calls().at(-2)!.prompt).toContain('Workflow "review", not saved yet');
    expect(chief.calls().at(-2)!.prompt).toContain("## Earlier in this conversation");
    expect(chief.calls().at(-2)!.prompt).toContain("(You changed the canvas: Added: check; Connected: analyst → check)");

    // A model, an agent CLI or a sandbox the person did not set is refused; the canvas is then left as it is.
    const model = { ...TWO, nodes: [{ ...TWO.nodes[0], model: "opus" }, TWO.nodes[1]] };
    const a4 = await s.api("POST", "/api/assistant", { question: `use opus ${fake({ text: `Set.\n${block("chief-workflow", model)}` }, { text: `Set.\n${block("chief-workflow", model)}` })}`, workflow: { definition: { ...TWO, description: "x" } } });
    expect(a4.status).toBe(200);
    expect(a4.body.change).toBeNull();
    expect(a4.body.change_error).toMatch(/step "collector": `model` is chosen by the person/);
    const script = { ...TWO, nodes: [...TWO.nodes, { id: "send", type: "script", run: "send.py", sandbox: { network: true } }] };
    const a5 = await s.api("POST", "/api/assistant", { question: `send it ${fake({ text: block("chief-workflow", script) }, { text: block("chief-workflow", script) })}`, workflow: { definition: { ...TWO, description: "y" } } });
    expect(a5.body.change).toBeNull();
    expect(a5.body.change_error).toMatch(/step "send": `sandbox`/);
    // A model that is already on the canvas stays.
    const a6 = await s.api("POST", "/api/assistant", { question: `describe it ${fake({ text: `Described.\n${block("chief-workflow", { ...model, description: "z" })}` })}`, workflow: { definition: model } });
    expect(a6.body.change.summary).toEqual(["Workflow settings: description"]);

    // A question: no block, no change. An invalid canvas is described with what the check says.
    const a7 = await s.api("POST", "/api/assistant", { question: `what is wrong? ${fake({ text: "The edge points to a step that does not exist." })}`, workflow: { definition: { ...TWO, edges: [{ from: "collector", to: "nobody" }] } } });
    expect(a7.body).toMatchObject({ answer: "The edge points to a step that does not exist.", change: null, change_error: null, options: null });
    expect(chief.calls().at(-1)!.prompt).toContain('unknown node "nobody"');

    // Kept with the conversation: the workflow, the change (before and after), the refusal, the options; every prompt sent.
    const turns = (await s.api("GET", "/api/assistant")).body.conversation.filter((t: any) => t.role === "assistant");
    expect(turns.map((t: any) => [t.meta.workflow, !!t.meta.change, !!t.meta.change_error, !!t.meta.options])).toEqual([
      ["review", true, false, true], ["review", true, false, false], ["review", true, false, false], ["review", false, true, false], ["review", false, true, false], ["review", true, false, false], ["review", false, false, false],
    ]);
    const rows = Object.fromEntries((await s.api("GET", "/api/doctor")).body.db.schemas.assistant.map((t: any) => [t.table, t.rows]));
    expect(rows).toEqual({ messages: 7 + 7 + 10 });
    expect((await s.api("POST", "/api/assistant", { question: "hi", workflow: { definition: "nope" } })).status).toBe(400);
    expect((await s.api("GET", "/api/meta")).body.api).toBe(14);
  } finally { await s.stop(); }
});

test("E9.65-2 in the designer the assistant builds a workflow on an empty canvas, changes it from an offered option, and each change can be undone", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await tid(page, "assistant-button").click();
  await expect(tid(page, "assistant-context")).toHaveText("designing a new workflow");
  await expect(tid(page, "assistant-empty")).toContainText("on the canvas");

  await tid(page, "assistant-question").fill(`build a review workflow ${fake({ text: `I built two steps.\n\n${block("chief-workflow", TWO)}\n\n${block("chief-options", OPTIONS)}` }, { text: `I added the gate.\n\n${block("chief-workflow", THREE)}` })}`);
  await tid(page, "assistant-send").click();
  // The steps are on the canvas, connected, and the designer's autosave made it a workflow.
  await expect(tid(page, "flow-node-collector")).toBeVisible();
  await expect(tid(page, "flow-node-analyst")).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page).toHaveURL(/#\/designer\/review$/);
  await saved(page);
  await expect(tid(page, "assistant-context")).toHaveText("designing review");
  await expect(tid(page, "wf-name")).toHaveValue("review");
  await expect(tid(page, "designer-note")).toContainText("The assistant changed the canvas");
  expect(await steps(srv, "review")).toEqual(["collector", "analyst"]);
  expect((await srv.api("GET", "/api/workflows/review")).body).toMatchObject({ version: 1, definition: { inputs: TWO.inputs, nodes: [{ prompt: TWO.nodes[0].prompt }, { prompt: TWO.nodes[1].prompt }] } });
  await expect(tid(page, "assistant-turn-assistant")).toContainText("I built two steps.");
  await expect(tid(page, "assistant-turn-assistant")).not.toContainText("chief-workflow");
  await expect(tid(page, "assistant-change")).toContainText("Added: collector, analyst");
  // A new workflow has nothing to go back to.
  await expect(tid(page, "assistant-undo")).toHaveCount(0);

  // The options the answer offers, with the person's own answer always among them.
  await expect(tid(page, "assistant-options")).toContainText("Should a person approve the report?");
  await expect(tid(page, "assistant-option-0")).toHaveText("Add an approval gate after analyst");
  await expect(tid(page, "assistant-option-1")).toHaveText("Leave it as it is");
  await tid(page, "assistant-option-own").click();
  await expect(tid(page, "assistant-question")).toBeFocused();
  await expect(tid(page, "assistant-question")).toHaveAttribute("placeholder", "Your own answer…");

  // Picking one sends it; steps that stay keep their place.
  const before = await tid(page, "flow-node-collector").boundingBox();
  await tid(page, "assistant-option-0").click();
  await expect(tid(page, "flow-node-check")).toBeVisible();
  await expect(tid(page, "assistant-options")).toHaveCount(0);
  await saved(page);
  expect(await steps(srv, "review")).toEqual(["collector", "analyst", "check"]);
  const stored = (await srv.api("GET", "/api/workflows/review")).body.definition.nodes;
  expect(stored[0].position).toEqual({ x: 60, y: 40 });
  expect(stored[2].position).toEqual({ x: 60, y: 300 });
  expect(before).not.toBeNull();

  // Undo and Apply again go through the canvas, so they are saved like any edit; no version is added (nothing ran).
  await tid(page, "assistant-undo").click();
  await expect(tid(page, "flow-node-check")).toHaveCount(0);
  await saved(page);
  await expect.poll(() => steps(srv, "review")).toEqual(["collector", "analyst"]);
  await tid(page, "assistant-apply").last().click();
  await expect(tid(page, "flow-node-check")).toBeVisible();
  await saved(page);
  expect(await steps(srv, "review")).toEqual(["collector", "analyst", "check"]);
  expect((await srv.api("GET", "/api/workflows/review")).body.version).toBe(1);

  // The changes are kept with the conversation: still there after a reload, and only usable on their workflow.
  await page.waitForFunction(() => !(window as any).__chiefDraftWrites);
  await page.reload();
  await expect(tid(page, "assistant-change")).toHaveCount(2);
  await expect(tid(page, "assistant-undo")).toHaveCount(1);
  await page.goto(srv.url + "/#/runs");
  await expect(tid(page, "assistant-context")).toHaveText("about chief");
  await expect(tid(page, "assistant-undo")).toHaveCount(0);
  await expect(tid(page, "assistant-change").first()).toContainText("Open review in the designer");
});

test("E9.65-3 a change that arrives after the canvas was edited by hand is not put on it, and a refused change is shown as refused", async ({ chief, boot, page }) => {
  chief.importWorkflow(`name: review\nnodes:\n  - { id: collector, type: agent, prompt: 'Collect.' }\n  - { id: analyst, type: agent, prompt: 'Write the report.' }\nedges: [collector -> analyst]\n`);
  const srv = await boot();
  const base = (await srv.api("GET", "/api/workflows/review")).body.definition;
  const sharper = { ...base, nodes: [base.nodes[0], { ...base.nodes[1], prompt: "Write a fair, specific report." }] };
  const withModel = { ...base, nodes: [{ ...base.nodes[0], model: "opus" }, base.nodes[1]] };
  await page.goto(srv.url + "/#/designer/review");
  await expect(tid(page, "flow-node-analyst")).toBeVisible();
  await tid(page, "assistant-button").click();
  await expect(tid(page, "assistant-context")).toHaveText("designing review");
  await expect(tid(page, "assistant-suggestion-0")).toHaveText("Explain this workflow step by step");

  // The agent takes a while; a gate is added by hand meanwhile.
  await tid(page, "assistant-question").fill(`sharpen the analyst's prompt ${fake({ sleep_ms: 2500, text: `Sharper.\n${block("chief-workflow", sharper)}` }, { text: `Set.\n${block("chief-workflow", withModel)}` }, { text: `Set.\n${block("chief-workflow", withModel)}` })}`);
  await tid(page, "assistant-send").click();
  await expect(tid(page, "assistant-turn-pending")).toBeVisible();
  await tid(page, "palette-gate").dblclick();
  await expect(page.locator('[data-testid^="flow-node-"]')).toHaveCount(3);
  await expect(tid(page, "assistant-change")).toHaveAttribute("data-held", "true", { timeout: 15_000 });
  await expect(tid(page, "assistant-change")).toContainText("you edited it while I worked");
  await expect(page.locator('[data-testid^="flow-node-"]')).toHaveCount(3);
  expect((await srv.api("GET", "/api/workflows/review")).body.definition.nodes[1].prompt).toBe("Write the report.");

  // Apply puts the assistant's version there.
  await tid(page, "assistant-apply").click();
  await expect(page.locator('[data-testid^="flow-node-"]')).toHaveCount(2);
  await saved(page);
  expect((await srv.api("GET", "/api/workflows/review")).body.definition.nodes[1].prompt).toBe("Write a fair, specific report.");
  await expect(tid(page, "assistant-change")).not.toHaveAttribute("data-held", "true");

  // A change chief refuses (a model the person did not choose): the canvas stays, and the answer says so.
  await tid(page, "assistant-question").fill("use opus for the collector");
  await tid(page, "assistant-send").click();
  await expect(tid(page, "assistant-change-error")).toContainText("The canvas was not changed.");
  await expect(tid(page, "assistant-change-error")).toContainText("`model` is chosen by the person");
  await expect(tid(page, "assistant-change")).toHaveCount(1);
  expect((await srv.api("GET", "/api/workflows/review")).body.definition.nodes[0].model).toBeUndefined();
});

// ── task 9.66: the format between steps is a contract, checked by chief and designed by the assistant ──

test("E9.66-1 a placeholder that reads a field the producing step's output schema does not name is reported, and the assistant is sent back to fix it", async ({ chief }) => {
  const s = await chief.serve();
  try {
    const schema = { people: [{ name: "string", links: ["string"] }], summary: "string", meta: { team: "string" } };
    const wf = (read: string, withSchema = true) => ({
      name: "t",
      nodes: [
        { id: "a", type: "agent", prompt: "x", ...(withSchema ? { "output-schema": schema } : {}) },
        { id: "m", type: "map", over: "{{nodes.a.output.people}}", node: { type: "agent", prompt: "Review {{item.name}}" } },
        { id: "b", type: "agent", prompt: `Use {{nodes.a.output.${read}}}, {{nodes.a.output.side_effects}} and {{nodes.a.output}}` },
      ],
      edges: ["a -> m", "a -> b"],
    });
    const warnings = async (def: object) => ((await s.api("POST", "/api/workflows/validate", { definition: def })).body.warnings as string[]).filter((w) => w.includes("output schema"));
    // Fields the schema names, at any depth, and what is inside a list: fine. The whole result and side_effects: always fine.
    for (const ok of ["summary", "people", "people.0.name", "meta.team"]) expect(await warnings(wf(ok)), ok).toEqual([]);
    expect(await warnings(wf("links"))).toEqual(['node "b": {{nodes.a.output.links}} reads "links", which the output schema of "a" does not name (it names: people, summary, meta); add the field to that schema or read one it names']);
    expect((await warnings(wf("meta.size")))[0]).toContain('reads "meta.size", which the output schema of "a" does not name (it names: team)');
    // A warning, not an error: the workflow is still valid. A step without a schema promises nothing.
    expect((await s.api("POST", "/api/workflows/validate", { definition: wf("links") })).body.ok).toBe(true);
    expect(await warnings(wf("anything", false))).toEqual([]);

    // The assistant is told that the format between steps is its job, and a mismatch in what it sends is refused once with the reason.
    const base = { name: "review", nodes: [{ id: "collector", type: "agent", prompt: "Collect my links." }, { id: "analyst", type: "agent", prompt: "Write the report." }], edges: [{ from: "collector", to: "analyst" }] };
    const wrong = { ...base, nodes: [{ ...base.nodes[0], "output-schema": { github: ["string"], jira: ["string"] } }, { ...base.nodes[1], prompt: "Write the report from {{nodes.collector.output.github}} and {{nodes.collector.output.slack}}." }] };
    const right = { ...wrong, nodes: [{ ...wrong.nodes[0], "output-schema": { github: ["string"], jira: ["string"], slack: ["string"] } }, wrong.nodes[1]] };
    const a = await s.api("POST", "/api/assistant", { question: `design the format between the steps ${fake({ text: `Designed.\n${block("chief-workflow", wrong)}` }, { text: `Fixed the schema.\n${block("chief-workflow", right)}` })}`, workflow: { definition: base } });
    expect(a.body).toMatchObject({ answer: "Fixed the schema.", change_error: null });
    expect(a.body.change.summary).toEqual(["Changed: collector, analyst"]);
    expect(a.body.change.after.nodes[0]["output-schema"]).toEqual({ github: ["string"], jira: ["string"], slack: ["string"] });
    const calls = chief.calls();
    expect(calls.at(-2)!.prompt).toContain("## The data format between steps");
    expect(calls.at(-2)!.prompt).toContain("designing that contract is your job");
    expect(calls.at(-1)!.prompt).toContain('{{nodes.collector.output.slack}} reads "slack", which the output schema of "collector" does not name (it names: github, jira)');
  } finally { await s.stop(); }
});

/**
 * Reported 2026-11-21, three things about the panel:
 *
 *  * it refused a general question asked while designing ("a random whether question using the AI model
 *    i selected on the designer page") — the designer prompt said it was there to build the workflow, and
 *    the panel was treated as a screen-local tool rather than chief bot;
 *  * it waited for the *cursor-agent* model list, so a Cursor CLI that is installed but not signed in put
 *    its raw flags in the composer and left the model dropdown empty, with no way to retry;
 *  * it kept using the agent CLI it was opened with after the default changed in Settings, and would send
 *    that CLI's model id to the new one.
 */
test("E15.38-1 in the designer chief bot answers what it is asked and does not touch the canvas unless asked", async ({ chief }) => {
  const s = await chief.serve();
  try {
    chief.importWorkflow(OK);
    // A question with nothing to do with the workflow: the answer stands, and no workflow block is sent.
    const plain = await s.api("POST", "/api/assistant", {
      question: `what is 17 times 23? ${fake({ text: "391. (17 × 23 = 391.)" })}`,
      workflow: { definition: { name: "fine", nodes: [{ id: "a", type: "agent", prompt: "A" }], edges: [] } },
    });
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({ answer: "391. (17 × 23 = 391.)", change: null, change_error: null, schedule: null });
    // And it is told it may answer: the instruction that used to make it refuse is gone.
    const prompt = chief.calls().at(-1)!.prompt;
    expect(prompt).toContain("You are chief bot");
    expect(prompt).toContain("about anything else");
    expect(prompt).not.toMatch(/You answer questions about it and, when a change is wanted/);
    // It still has the canvas, so a change asked for is still made in the same session.
    expect(prompt).toContain("The canvas right now");
    expect(prompt).toContain("## Runs");
  } finally {
    await s.stop();
  }
});

test("E15.38-2 the model list says how to sign a CLI in, is not cached while it fails, and the panel follows the default CLI", async ({ chief, page }) => {
  const srv = await chief.serve();
  try {
    await roomyLayout(srv);
    // A Cursor CLI that is installed but not signed in: `models` exits non-zero with the vendor's wording.
    const bin = chief.file("cursor-agent", `#!/bin/sh
case "$1" in
  --version) echo "2026.11.19-f005e9d" ;;
  models) echo "Error: Authentication required. Run 'agent login'." >&2; exit 1 ;;
  *) echo "{}" ;;
esac
`, 0o755);
    await srv.api("PUT", "/api/settings", { "cursor.path": bin, cursor: { chosen: true, enabled: true }, "default-adapter": "cursor" });

    // The server says what to do, not what the CLI printed.
    const models = await srv.api("GET", "/api/models?adapter=cursor&refresh=1");
    expect(models.body.models).toEqual([]);
    expect(models.body.signIn).toBe(true);
    expect(models.body.note).toContain("not signed in");
    expect(models.body.note).toContain("cursor-agent login");
    expect(models.body.note).not.toContain("Authentication required");

    // Not cached: a failure must not survive the sign-in. The same request answers from the CLI again, so
    // the fixed CLI is picked up at once rather than after the ten-minute cache.
    const fixed = chief.file("cursor-agent-ok", `#!/bin/sh
case "$1" in
  --version) echo "2026.11.19-f005e9d" ;;
  models) echo "composer-1"; echo "gpt-5"; ;;
  *) echo "{}" ;;
esac
`, 0o755);
    await srv.api("PUT", "/api/settings", { "cursor.path": fixed });
    const again = await srv.api("GET", "/api/models?adapter=cursor");
    expect(again.body.models.map((m: any) => m.value)).toEqual(["composer-1", "gpt-5"]);
    expect(again.body.signIn).toBeUndefined();

    // The panel follows the default CLI: opened on cursor, it shows Cursor's list, and the composer has a
    // way to retry rather than a wall of flags.
    await page.goto(srv.url + "/#/designer");
    await tid(page, "assistant-button").click();
    await expect(tid(page, "assistant-model")).toHaveAttribute("data-adapter", "cursor");
    await expect(tid(page, "assistant-model")).toHaveAttribute("data-loaded", "true");
    await expect(tid(page, "assistant-model")).toContainText("composer-1");
    // And its title is chief bot, not "Assistant".
    await expect(tid(page, "assistant-panel").getByText("chief bot", { exact: false }).first()).toBeVisible();
    await expect(tid(page, "assistant-panel")).toHaveAttribute("aria-label", "chief bot");
  } finally {
    await srv.stop();
  }
});

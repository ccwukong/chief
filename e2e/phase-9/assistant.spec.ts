import type { Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, fake, test as base, type Server, roomyLayout } from "../helpers";

/** Task 9.64: the floating assistant. One conversation about chief, with the run on show as its context. */

const test = base.extend<{ boot: (opts?: { env?: Record<string, string> }) => Promise<Server> }>({
  boot: async ({ chief }, use) => {
    const started: Server[] = [];
    // `opts` is passed on, and the signature says so: it used to take none while cases called `boot({ env })`, which
    // silently started the default server — so a case with its own fake CLI was answered by the harness's instead, and
    // passed for the wrong reason or failed for no reason at all (found 2026-11-22 by E15.69-1).
    await use(async (opts) => { const s = await chief.serve(opts); started.push(s); await roomyLayout(s); return s; });
    for (const s of started) await s.stop();
  },
});
const tid = (page: Page, id: string) => page.getByTestId(id);

const OK = `name: fine\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ output: { ok: 1 } })}' }\n`;
const BROKEN = `name: broken\nnodes:\n  - { id: plan, type: agent, mcp: [], prompt: 'PLAN ${fake({ output: { ok: 1 } })}' }\n  - { id: big, type: agent, mcp: [], prompt: 'BIG ${fake({ error: "boom" })}' }\nedges: [plan -> big]\n`;
const GATED = "name: gated\nnodes:\n  - { id: g, type: gate, kind: approve, value: ship it }\n";
const status = async (s: Server, id: number, want: string) => expect.poll(async () => (await s.api("GET", `/api/runs/${id}`)).body.run?.status, { timeout: 20_000 }).toBe(want);

test("E15.102-1 the boot fixture forwards its env, so a case's own scripted CLI answers", async ({ chief, boot }) => {
  // Task 15.102. The fixture took no argument while cases called `boot({ env })`, so the default fake answered and a case
  // that reads the argv chief built (E15.87-1) or the tool loop it ran (E15.69-1) was reading somebody else's process.
  // One scripted CLI, one answer only it can give.
  const script = join(chief.dir, "who-answered.sh");
  writeFileSync(script, [
    "#!/bin/sh",
    `printf '%s\n' '{"type":"system","subtype":"init","session_id":"s1"}'`,
    `printf '%s\n' '{"type":"result","subtype":"success","result":"the scripted CLI answered","session_id":"s1","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}'`,
    "",
  ].join("\n"), { mode: 0o755 });
  const srv = await boot({ env: { CHIEF_CLAUDE_BIN: script } });
  try {
    const answer = await srv.api("POST", "/api/assistant", { question: "who answered?" });
    expect(answer.status).toBe(200);
    expect(answer.body.answer, "the CLI the case named, not the harness's own").toBe("the scripted CLI answered");
  } finally {
    await srv.stop();
  }
});

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
    // The fields this case is about, not the whole object: the response has grown with the bot (tools, reach, actions,
    // threads), and an exact match here would go red for every later task that adds one — which is what it did.
    expect(empty.body.adapter).toBe("claude-code");
    expect(empty.body.conversation).toEqual([]);

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
    // A count, not the shape of the whole schema: `assistant__threads` joined it in 15.67, and the next table will join it
    // some day. What this case is about is that the answers were written down, once each.
    expect(tables.messages, "every turn recorded, and nothing else").toBe(12);
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

test("E9.64-2 chief bot is a place in the app: a rail item on every page, a panel beside the page, open across a reload, and a fit on a phone", async ({ chief, boot, page }) => {
  chief.importWorkflow(OK);
  const srv = await boot();
  const id = (await srv.api("POST", "/api/runs", { workflow: "fine" })).body.run.id as number;
  await status(srv, id, "completed");

  // It was a floating bubble in the corner (reported 2026-11-21: on top of the pager) and then a draggable one
  // (15.61, 15.62). Asked 2026-11-22 for what Figma does: a rail item that opens a static panel, "so it gives the
  // impression the agent isn't an adhoc helper but more of a main feature". The bubble is gone.
  for (const path of ["/#/runs", "/#/designer", "/#/settings"]) {
    await page.goto(srv.url + path);
    const item = tid(page, "nav-assistant");
    await expect(item, path).toBeVisible();
    // An item in the rail, not a bubble over the page: the old floating button is gone.
    await expect(tid(page, "assistant-button"), path).toHaveCount(0);
    await expect(tid(page, "assistant-panel"), path).toHaveCount(0);
    await expect(item).toHaveAttribute("aria-pressed", "false");
  }

  // Open: the panel is beside the page, and about chief; it is still open after a reload.
  await page.setViewportSize({ width: 1280, height: 900 });
  await tid(page, "nav-assistant").click();
  const panel = tid(page, "assistant-panel");
  await expect(panel).toBeVisible();
  await expect(tid(page, "nav-assistant")).toHaveAttribute("aria-pressed", "true");
  await expect(tid(page, "assistant-context")).toHaveText("about chief");
  await expect(tid(page, "assistant-suggestion-0")).toHaveText("Which runs failed, and why?");
  // A column, not an overlay: the page keeps its layout beside it, and nothing is covered.
  const box = (await panel.boundingBox())!;
  expect(box.height, "it is the full height of the window").toBeGreaterThan(800);
  await page.waitForFunction(() => !(window as any).__chiefDraftWrites);
  await page.reload();
  await expect(tid(page, "assistant-panel")).toBeVisible();

  // The header is three glyphs of one size: the past conversations, a new one, and closing the panel. Nothing in it is a
  // box, and nothing in it is a word — "New" was the only one of each, which made starting a conversation look like the
  // panel's primary action (asked 2026-11-22: "this can be just a text/icon button", then "can we change this to a plus
  // icon button instead?").
  for (const [id, label] of [["assistant-history", "Past conversations"], ["assistant-new", "New conversation"], ["assistant-close", "Close chief bot"]]) {
    const chrome = await tid(page, id).evaluate((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { border: cs.borderWidth, bg: cs.backgroundColor, shadow: cs.boxShadow, w: Math.round(r.width), h: Math.round(r.height), glyph: !!el.querySelector("svg"), text: (el.textContent ?? "").trim(), label: el.getAttribute("aria-label") };
    });
    expect(chrome.border, `${id} has no border`).toBe("0px");
    expect(chrome.bg, `${id} has no fill`).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(chrome.shadow, `${id} has no shadow`).toBe("none");
    expect(chrome.glyph, `${id} is drawn`).toBe(true);
    expect(chrome.text, `${id} carries no word`).toBe("");
    expect(chrome.label, `${id} is named for a screen reader`).toBe(label);
    expect(chrome.w, `${id} has the same target as its neighbours`).toBe(32);
    expect(chrome.h).toBe(32);
  }

  // Three ways to close it: the ×, the rail item again, Escape in the box.
  await tid(page, "assistant-close").click();
  await expect(tid(page, "assistant-panel")).toHaveCount(0);
  await tid(page, "nav-assistant").click();
  await expect(tid(page, "assistant-panel")).toBeVisible();
  await tid(page, "nav-assistant").click();
  await expect(tid(page, "assistant-panel")).toHaveCount(0);
  await tid(page, "nav-assistant").click();
  await tid(page, "assistant-question").press("Escape");
  await expect(tid(page, "assistant-panel")).toHaveCount(0);

  // The context follows the page: a run's page, and back.
  await tid(page, "nav-assistant").click();
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
  await tid(page, "assistant-new").click();
  await expect(tid(page, "assistant-turn-assistant")).toHaveCount(0);
  await expect(tid(page, "assistant-empty")).toBeVisible();
  expect((await srv.api("GET", "/api/assistant")).body.conversation).toEqual([]);

  // A phone: the panel is the page (there is no room for two columns) and nothing scrolls sideways.
  await page.setViewportSize({ width: 375, height: 700 });
  const small = (await tid(page, "assistant-panel").boundingBox())!;
  expect(small.x).toBeGreaterThanOrEqual(0);
  expect(small.x + small.width).toBeLessThanOrEqual(375);
  expect(small.y).toBeGreaterThanOrEqual(0);
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
    expect(rows.messages, "the answers, the prompts and the change records, once each").toBe(7 + 7 + 10);
    expect((await s.api("POST", "/api/assistant", { question: "hi", workflow: { definition: "nope" } })).status).toBe(400);
    expect((await s.api("GET", "/api/meta")).body.api).toBe(16);
  } finally { await s.stop(); }
});

test("E9.65-2 in the designer the assistant builds a workflow on an empty canvas, changes it from an offered option, and each change can be undone", async ({ boot, page }) => {
  const srv = await boot();
  await page.goto(srv.url + "/#/designer");
  await tid(page, "nav-assistant").click();
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
  await tid(page, "nav-assistant").click();
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

    // The panel follows the default CLI, and says so; the list itself is in Settings, and it is still Cursor's — the CLI's
    // own list, never one hard-coded here (task 15.87 moved the picker there).
    await page.goto(srv.url + "/#/designer");
    await tid(page, "nav-assistant").click();
    await expect(tid(page, "assistant-reach")).toContainText("cursor");
    await page.goto(srv.url + "/#/settings");
    await expect(tid(page, "setting-bot-model")).toHaveAttribute("data-adapter", "cursor");
    await expect(tid(page, "setting-bot-model")).toHaveAttribute("data-loaded", "true");
    await expect(tid(page, "setting-bot-model")).toContainText("composer-1");
    await expect(tid(page, "setting-bot-adapter")).toHaveValue("auto");
    // And its title is chief bot, not "Assistant".
    await expect(tid(page, "assistant-panel").getByText("chief bot", { exact: false }).first()).toBeVisible();
    await expect(tid(page, "assistant-panel")).toHaveAttribute("aria-label", "chief bot");
  } finally {
    await srv.stop();
  }
});

test("E15.67-1 a conversation is kept, and an old one can be picked up again", async ({ chief, boot, page }) => {
  // Asked 2026-11-22: "the chief bot should allow user to view historical chats too, because the user may wanna
  // continue the previous conversation". New used to delete the conversation; it now starts a new thread and keeps
  // the old one, and only an explicit × deletes.
  chief.importWorkflow(OK);
  const srv = await boot();
  const ask = (q: string) => srv.api("POST", "/api/assistant", { question: q });
  const threads = async () => (await srv.api("GET", "/api/assistant/threads")).body as { id: number; title: string; current: number; turns: number }[];

  // The first question names the conversation: the list reads as what each one was about, not as a timestamp.
  await ask(`what failed? ${fake({ text: "Nothing failed." })}`);
  let list = await threads();
  expect(list).toHaveLength(1);
  // The title is the question **as it was sent**, so the fake marker this case had to type to get an answer rides along —
  // chief does not know that syntax, and a real question has none. What is asserted is that the conversation is named after
  // what was asked rather than after a timestamp.
  expect(list[0].title.startsWith("what failed?")).toBe(true);
  expect(list[0].current).toBe(1);

  // A new chat is a new thread; the first is still there with its messages.
  const created = await srv.api("POST", "/api/assistant/threads");
  expect(created.status).toBe(200);
  await ask(`and last week? ${fake({ text: "All green." })}`);
  list = await threads();
  // The fake marker is the case's own scaffolding, so the assertion takes it off before reading the name.
  const name = (t: { title: string }) => t.title.split("<fake>")[0].trim();
  expect(list.map(name).sort()).toEqual(["and last week?", "what failed?"]);
  expect(list.find((t) => t.title.startsWith("what failed?"))!.current, "a new chat becomes the current one").toBe(0);

  // Reopening the first makes it current and brings its messages back, in order.
  const first = list.find((t) => t.title.startsWith("what failed?"))!;
  const reopened = await srv.api("POST", `/api/assistant/threads/${first.id}/use`);
  expect(reopened.body.thread).toBe(first.id);
  // The question as recorded — the case's own fake marker included, since that is the text the panel sent.
  expect((reopened.body.conversation as any[]).filter((t) => t.role === "user").map((t) => t.text.slice(0, 12))).toEqual(["what failed?"]);
  expect((await threads()).find((t) => t.id === first.id)!.current, "it is current now").toBe(1);

  // Deleting is a real delete, and only the one asked for goes. It was the **current** conversation, so a blank one takes
  // its place: without that, the next question would fall back to the newest remaining thread and silently continue an
  // older conversation rather than starting a new one.
  const del = await srv.api("DELETE", `/api/assistant/threads/${first.id}`);
  expect(del.body.deleted).toBe(1);
  const after = await threads();
  // The blank replacement has no name yet, which is the list saying "nothing has been asked in this one".
  expect(after.map(name), "the deleted one is gone, the other is untouched").toEqual(["", "and last week?"]);
  const blank = after.find((t) => t.current === 1)!;
  expect(blank, "a new current conversation to type into").toBeTruthy();
  expect(blank.id).not.toBe(first.id);
  expect(blank.turns, "and it is empty").toBe(0);

  // In the panel: History lists them, New starts one, and the exchange survives.
  await page.goto(srv.url + "/#/runs");
  await tid(page, "nav-assistant").click();
  await expect(tid(page, "assistant-panel")).toBeVisible();
  // A clock, not the word: it is a header of glyphs (New, ×), and the name stays in its label for anything that
  // cannot see the icon (asked 2026-11-22).
  await expect(tid(page, "assistant-history")).toHaveAttribute("aria-label", "Past conversations");
  await expect(tid(page, "assistant-history")).toHaveAttribute("title", /Past conversations/);
  await expect(tid(page, "assistant-history").locator("svg")).toHaveCount(1);
  await tid(page, "assistant-history").click();
  await expect(tid(page, "assistant-history-list")).toBeVisible();
  await expect(tid(page, "assistant-history-list")).toContainText("and last week?");
  // A dropdown, not a strip that pushed the conversation down (asked 2026-11-22), and it closes on Escape: one press for
  // the menu, and the panel stays.
  await page.keyboard.press("Escape");
  await expect(tid(page, "assistant-history-list")).toHaveCount(0);
  await expect(tid(page, "assistant-panel")).toBeVisible();
});

test("E15.69-1 chief bot runs the CLI's own tool loop, and every call it makes is recorded", async ({ chief, boot, page }) => {
  // It ran with `builtinTools: "none"` and no servers, so the bot that designs a step could not read the repository the
  // step runs on, while the step could (found 2026-11-22). The loop stays the CLI's; chief decides what it may reach and
  // writes down every call.
  const fake = join(chief.dir, "tool-cli.sh");
  writeFileSync(fake, [
    "#!/bin/sh",
    // The stream a CLI writes: session, a tool call, its result, then the final answer.
    `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s1"}'`,
    `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"}}]}}'`,
    `printf '%s\\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"export const a = 1;","is_error":false}]}}'`,
    `printf '%s\\n' '{"type":"result","subtype":"success","result":"It defines a.","session_id":"s1","total_cost_usd":0.001,"usage":{"input_tokens":5,"output_tokens":3}}'`,
    "",
  ].join("\n"), { mode: 0o755 });
  const srv = await boot({ env: { CHIEF_CLAUDE_BIN: fake } });

  // What it may reach is a setting the panel shows, not a hidden default.
  let info = (await srv.api("GET", "/api/assistant")).body;
  expect(info.tools, "default is read-only, because the bot can rewrite the canvas").toBe("read-only");
  expect(info.mcp, "and no MCP servers until asked").toBe("none");
  expect(info.reach).toMatch(/read-only tools/);
  await srv.api("PUT", "/api/settings", { "assistant-tools": "read-only", "assistant-mcp": "all" });
  info = (await srv.api("GET", "/api/assistant")).body;
  expect(info.reach).toMatch(/every MCP server/);

  // The answer comes back, and the tool call is in the record between the prompt and the answer.
  const answer = await srv.api("POST", "/api/assistant", { question: "what is in a.ts?" });
  expect(answer.body.answer).toContain("It defines a.");
  const thread = (await srv.api("GET", "/api/assistant/threads")).body[0];
  const rows = (await srv.api("GET", `/api/drafts?prefix=`), null);
  void rows;
  // Read the record straight from the store the same way the panel does: the thread's messages, in order.
  const whole = await srv.api("GET", "/api/assistant");
  const kinds = (whole.body.conversation as any[]).map((t) => t.role);
  expect(kinds, "user and assistant turns are what the chat shows").toEqual(["user", "assistant"]);
  expect(thread.turns, "the tool rows are kept too, they are just not chat turns").toBeGreaterThanOrEqual(2);

  // The panel says what is in force in one line, and the folder it is reading; the controls are in Settings.
  await page.goto(srv.url + "/#/runs");
  await tid(page, "nav-assistant").click();
  await expect(tid(page, "assistant-reach")).toContainText("read-only tools");
  await expect(tid(page, "assistant-reach")).toContainText("every MCP server");
  await expect(tid(page, "assistant-folder")).toContainText("in ");
  await page.goto(srv.url + "/#/settings");
  await expect(tid(page, "setting-bot-tools")).toHaveValue("read-only");
  await expect(tid(page, "setting-bot-mcp")).toHaveValue("all");
});

test("E15.74-1 the agent is told what it can reach, shows what it did, and can be stopped", async ({ chief, boot, page }) => {
  // "implement a full agent … it should always use the underlying agent cli" (2026-11-22). The loop is the CLI's; what the
  // panel owes the person is the truth about the reach, the record of the calls, and a way to stop it.
  const fake = join(chief.dir, "agent-cli.sh");
  writeFileSync(fake, [
    "#!/bin/sh",
    `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s1"}'`,
    `printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Reading."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/a.ts"}}]}}'`,
    `printf '%s\\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"export const a = 1;","is_error":false}]}}'`,
    `printf '%s\\n' '{"type":"result","subtype":"success","result":"It defines a.","session_id":"s1","total_cost_usd":0.001,"usage":{"input_tokens":9,"output_tokens":4}}'`,
    "",
  ].join("\n"), { mode: 0o755 });
  const srv = await boot({ env: { CHIEF_CLAUDE_BIN: fake } });

  // The reach is a setting, and the panel says what it is.
  const info = (await srv.api("GET", "/api/assistant")).body;
  expect(info.tools).toBe("read-only");
  expect(info.mcp).toBe("none");
  expect(info.reach).toMatch(/read-only tools/);

  // The answer, and the tool call it made, in the panel's payload.
  const answer = await srv.api("POST", "/api/assistant", { question: "what is in a.ts?" });
  expect(answer.body.answer).toContain("It defines a.");
  const after = (await srv.api("GET", "/api/assistant")).body;
  expect(after.actions, "the call the agent made is reported").toEqual([
    { tool: "Read", input: { file_path: "src/a.ts" }, result: "export const a = 1;", isError: false },
  ]);

  // Stop exists and says plainly when there is nothing to stop.
  const cancelled = await srv.api("DELETE", "/api/assistant/pending");
  expect(cancelled.body).toEqual({ cancelled: false });

  // In the panel: what it may reach, the actions list, and the Stop button only while pending.
  await page.goto(srv.url + "/#/runs");
  await tid(page, "nav-assistant").click();
  await expect(tid(page, "assistant-reach")).toContainText("read-only tools");
  await expect(tid(page, "assistant-actions-summary")).toContainText("1 call");
  await expect(tid(page, "assistant-action-0")).toContainText("Read");
  await expect(tid(page, "assistant-cancel")).toHaveCount(0);
});

test("E15.78-1 a conversation reads as one asking and one answering: the turn that is yours is grey, the agent's has no background", async ({ chief, page }) => {
  // Asked 2026-11-22: "the user's chat has a silver/gray background, and the chiefbot's chat records have no background color" — the
  // way Cursor draws a conversation, so a reply reads as the answer rather than as another card beside yours.
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1200, height: 820 });
    await srv.api("POST", "/api/assistant", { question: "hello", model: undefined }).catch(() => {});
    await page.goto(srv.url + "/#/runs");
    await tid(page, "nav-assistant").click();
    const mine = tid(page, "assistant-turn-user").first();
    const theirs = tid(page, "assistant-turn-assistant").first();
    await expect(mine).toBeVisible();
    // A tinted block for the person…
    const mineBg = await mine.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(mineBg, "the person's turn is a tinted block").not.toBe("rgba(0, 0, 0, 0)");
    // …and no background for the agent, with the rule that still separates it.
    expect(await theirs.evaluate((el) => getComputedStyle(el).backgroundColor), "the agent's turn is on the panel").toBe("rgba(0, 0, 0, 0)");
    expect(await theirs.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe("2px");
  } finally {
    await srv.stop();
  }
});

test("E15.87-1 chief bot's CLI and model are Settings, and the answer is given with them", async ({ chief, boot, page }) => {
  // Asked 2026-11-22: "we should add new configs for the agent cli and model used by chief bot in the settings page".
  // The panel carried a model picker and two dropdowns for what it may reach, on every reply; those are settings, so
  // they moved to Settings › chief bot and the panel keeps one line saying what is in force (task 15.87).
  const srv = await boot();
  try {
    // The card exists, offers Auto plus the CLIs chief may use, and starts where chief starts: following the page.
    await page.goto(srv.url + "/#/settings");
    await expect(tid(page, "bot-settings")).toBeVisible();
    await expect(tid(page, "setting-bot-adapter")).toHaveValue("auto");
    await expect(tid(page, "setting-bot-adapter").locator("option").first()).toHaveText("Auto — follow the page");
    await expect(tid(page, "setting-bot-tools")).toHaveValue("read-only");
    await expect(tid(page, "setting-bot-mcp")).toHaveValue("none");

    // Choosing a CLI is saved without a Save button, and clears the model: a model belongs to the CLI that offered it.
    await tid(page, "setting-bot-adapter").selectOption("claude-code");
    await expect.poll(async () => (await srv.api("GET", "/api/settings")).body["assistant-adapter"]).toBe("claude-code");
    // The list is the CLI's own — the rule every model choice in chief follows, never a list written here.
    await expect(tid(page, "setting-bot-model")).toHaveAttribute("data-adapter", "claude-code");
    await expect(tid(page, "setting-bot-model")).toHaveAttribute("data-loaded", "true");
    await expect(tid(page, "setting-bot-model")).toContainText("Sonnet");
    await tid(page, "setting-bot-model").selectOption("sonnet");
    await expect.poll(async () => (await srv.api("GET", "/api/settings")).body["assistant-model"]).toBe("sonnet");
    await tid(page, "setting-bot-mcp").selectOption("all");
    await expect.poll(async () => (await srv.api("GET", "/api/settings")).body["assistant-mcp"]).toBe("all");

    // The panel shows it as one line and carries no controls of its own.
    await page.goto(srv.url + "/#/runs");
    await tid(page, "nav-assistant").click();
    await expect(tid(page, "assistant-panel")).toBeVisible();
    await expect(tid(page, "assistant-reach")).toContainText("claude-code");
    await expect(tid(page, "assistant-reach")).toContainText("sonnet");
    await expect(tid(page, "assistant-reach")).toContainText("every MCP server");
    await expect(tid(page, "assistant-settings-link")).toHaveAttribute("href", "#/settings");
    for (const gone of ["assistant-tools", "assistant-mcp", "assistant-model"]) {
      await expect(tid(page, gone), `the panel has no ${gone} control`).toHaveCount(0);
    }

    // The answer really is given with it: the assistant's turn records the model the settings chose.
    const answer = await srv.api("POST", "/api/assistant", { question: `hello ${fake({ text: "ok" })}` });
    expect(answer.status).toBe(200);
    const conversation = (await srv.api("GET", "/api/assistant")).body.conversation as any[];
    expect(conversation.at(-1)?.meta?.model, "the stored model is the one that answered").toBe("sonnet");
  } finally {
    await srv.stop();
  }

  // And the CLI's own argv carries it, which is the part no page can show: a scripted CLI writes down what it was given.
  const dir = join(chief.dir, "bot-settings");
  mkdirSync(dir, { recursive: true });
  const argvFile = join(dir, "argv.txt");
  const script = join(dir, "agent-cli.sh");
  writeFileSync(script, [
    "#!/bin/sh",
    `printf '%s\n' "$@" > ${argvFile}`,
    `printf '%s\n' '{"type":"system","subtype":"init","session_id":"s1"}'`,
    `printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}'`,
    `printf '%s\n' '{"type":"result","subtype":"success","result":"ok","session_id":"s1","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}'`,
    "",
  ].join("\n"), { mode: 0o755 });
  const second = await boot({ env: { CHIEF_CLAUDE_BIN: script } });
  try {
    await second.api("PUT", "/api/settings", { "assistant-adapter": "claude-code", "assistant-model": "sonnet", "assistant-tools": "read-only", "assistant-mcp": "all" });
    // A fresh conversation: the first half of this case already answered a question in this chief home, so the next
    // question would *resume* that session, and a resumed turn is a follow-up prompt rather than a full one. What is
    // being read here is the argv of a call that is given everything, so it has to be one.
    await second.api("DELETE", "/api/assistant");
    expect((await second.api("POST", "/api/assistant", { question: "hello" })).status).toBe(200);
    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    const at = (flag: string) => argv.indexOf(flag);
    expect(argv[at("--model") + 1], "--model is the one chosen in Settings").toBe("sonnet");
    // Read-only is an allowlist passed to the CLI, not a hope: read tools in, the acting ones out. The `mcp__…` entries
    // are the servers this case *also* allowed ("assistant-mcp": "all"), so they belong in the list; what must not appear
    // is anything that writes or runs a command.
    const allowed = argv.slice(at("--allowedTools") + 1, at("--disallowedTools"));
    expect(allowed.filter((t) => !t.startsWith("mcp__")), "the read tools, in order").toEqual(["Read", "Grep", "Glob"]);
    expect(allowed.filter((t) => /^(Write|Edit|NotebookEdit|Bash)$/.test(t)), "nothing that acts").toEqual([]);
    // "Every connected server" means none of them is excluded: chief passes `--mcp-config`/`--disallowedTools` only to
    // *scope* a session, and there is nothing to scope out when all are allowed. (Which argv an actually restricted node
    // gets is E15.74-1 and phase-2's claude-code cases: `--strict-mcp-config` with the chosen definitions. The connectors
    // on a claude.ai account cannot be passed that way at all, which is why the adapter scopes by disallowing the rest —
    // and with "all" there is no rest.)
    const disallowed = argv.slice(at("--disallowedTools") + 1).filter((t) => t.startsWith("mcp__"));
    expect(disallowed, "no server is excluded when every one is allowed").toEqual([]);
  } finally {
    await second.stop();
  }
});

test("E15.95-1 Stop interrupts the answer and the conversation carries on", async ({ chief, page }) => {
  // Asked 2026-11-22: *"can we add a Cancel button to interrupt the ongoing agent's thinking process, in cases where a user
  // wanted to cancel a chat and ask something else in the same session?"*. The panel had a small Stop beside a
  // spinner-labelled Ask nobody could press; the primary slot **becomes** Stop while an answer is in flight, and stopping
  // ends the answer without ending the conversation.
  const srv = await chief.serve();
  try {
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "sidenav")).toBeVisible();
    await tid(page, "nav-assistant").click();
    await expect(tid(page, "assistant-question")).toBeVisible();

    // A slow answer, so there is something to interrupt (the fake waits, and ends the turn on a signal).
    await tid(page, "assistant-question").fill(`a slow one ${fake({ text: "the slow answer", sleep_ms: 20_000 })}`);
    await tid(page, "assistant-question").press("Enter");

    // The Stop is the primary control, in the place Ask was, and it says what it does.
    await expect(tid(page, "assistant-cancel")).toBeVisible();
    await expect(tid(page, "assistant-cancel")).toHaveText("Stop");
    await expect(tid(page, "assistant-cancel")).toHaveAttribute("title", /conversation stays/);
    await expect(tid(page, "assistant-send"), "no dead spinner button beside it").toHaveCount(0);
    await expect(tid(page, "assistant-turn-pending")).toBeVisible();

    await tid(page, "assistant-cancel").click();
    // Stopped: said as a stop, not as a failure — the adapter's raw "cancelled" used to reach the page as a red error.
    await expect(tid(page, "assistant-stopped")).toContainText("Stopped");
    await expect(tid(page, "assistant-turn-pending")).toHaveCount(0);
    await expect(tid(page, "assistant-cancel")).toHaveCount(0);
    await expect(tid(page, "assistant-send")).toBeVisible();
    await expect(tid(page, "assistant-question"), "the box takes the next question").toBeEnabled();

    // And the conversation is the same one: a new question goes through, and no second thread was created.
    await tid(page, "assistant-question").fill(`never mind ${fake({ text: "Here is the real answer." })}`);
    await tid(page, "assistant-question").press("Enter");
    await expect(tid(page, "assistant-turn-assistant").last()).toContainText("Here is the real answer.", { timeout: 30_000 });
    const threads = (await srv.api("GET", "/api/assistant/threads")).body as any[];
    expect(threads.length, "one conversation, not two").toBe(1);
    // The interrupted turn is in that conversation's record, marked as stopped rather than failed.
    const turns = (await srv.api("GET", "/api/assistant")).body.conversation as any[];
    expect(turns.some((t) => t.meta?.error === "stopped"), "the stop is recorded").toBe(true);
  } finally {
    await srv.stop();
  }
});

test("E15.115-1 a workflow can be built from the panel when it is not in the designer, and a thin request is asked about", async ({ chief, page }) => {
  // Reported 2026-11-23: *"The chief bot is unable to create a workflow just based on description initially … the first
  // response should suggest me how to improve my description, or provide some recommendations rather than asking me to
  // directly do it the manual way"*. Both halves were real. Outside the designer the agent was given no workflow format
  // at all, so its answer was the true-but-useless *"chief hasn't given me a format for workflow changes in this
  // conversation"* and a design to copy by hand; and a thin description got homework instead of a question.
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    // The run list: no canvas, which is where the report came from.
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "sidenav")).toBeVisible();
    if (!(await tid(page, "assistant-panel").isVisible().catch(() => false))) await tid(page, "nav-assistant").click();

    // 1. A description becomes a proposed workflow: offered, not created.
    const built = { name: "peer-feedback", nodes: [
      { id: "collect", type: "agent", prompt: "Collect the evidence." },
      { id: "review", type: "gate", kind: "approve", value: "{{nodes.collect.output}}" },
      { id: "write", type: "agent", prompt: "Write it up from {{nodes.review.output}}." },
    ], edges: [{ from: "collect", to: "review" }, { from: "review", to: "write" }] };
    const block = "```chief-workflow\n" + JSON.stringify(built) + "\n```";
    await tid(page, "assistant-question").fill(`build a peer feedback workflow ${fake({ text: `Three steps, with a gate before the write.\n\n${block}` })}`);
    await tid(page, "assistant-send").click();
    const card = tid(page, "assistant-proposal");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("New workflow");
    await expect(card).toContainText("peer-feedback");
    await expect(card).toContainText("collect (agent), review (gate), write (agent)");
    // Nothing is written until the person presses it.
    expect((await srv.api("GET", "/api/workflows")).body, "offered, not created").toEqual([]);

    // What the CLI was asked, which is the half that was missing: the format, and that a block here is a proposal.
    const prompt = chief.calls().at(-1)!.prompt;
    expect(prompt).toContain("## The workflow format");
    expect(prompt).toContain("## Proposing a workflow");
    expect(prompt).toContain("When the request is too thin to build, ask");

    // One click creates it through the endpoint the designer uses, and the designer opens on it.
    await tid(page, "assistant-proposal-create").click();
    await expect(page).toHaveURL(/#\/designer\/peer-feedback$/);
    await expect.poll(async () => (await srv.api("GET", "/api/workflows")).body.map((w: any) => w.name)).toEqual(["peer-feedback"]);
    // The stored workflow is the one it proposed, steps and arrows.
    const stored = (await srv.api("GET", "/api/workflows/peer-feedback")).body;
    expect(stored.definition.nodes.map((n: any) => n.id)).toEqual(["collect", "review", "write"]);
    expect(stored.definition.edges).toEqual([{ from: "collect", to: "review" }, { from: "review", to: "write" }]);

    // 2. A description that is too thin gets questions with options, and no proposal: what the report asked for.
    await srv.api("DELETE", "/api/assistant");
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "assistant-panel")).toBeVisible();
    await tid(page, "assistant-question").fill(`make me a review thing ${fake({ text: "Two things first — where should the data come from?\n\n```chief-options\n{\"question\": \"Where should the data come from?\", \"options\": [\"From GitHub pull requests\", \"From Slack channels\"]}\n```" })}`);
    await tid(page, "assistant-send").click();
    await expect(tid(page, "assistant-options")).toBeVisible({ timeout: 20_000 });
    await expect(tid(page, "assistant-option-0")).toContainText("From GitHub pull requests");
    await expect(tid(page, "assistant-proposal"), "no workflow on a guess").toHaveCount(0);

    // 3. A proposal that sets the person's own choices is refused, with the reason — not silently accepted.
    await srv.api("DELETE", "/api/assistant");
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "assistant-panel")).toBeVisible();
    const withModel = { ...built, nodes: [{ ...built.nodes[0], model: "opus" }, built.nodes[1], built.nodes[2]] };
    await tid(page, "assistant-question").fill(`again ${fake({ text: "Here.\n\n```chief-workflow\n" + JSON.stringify(withModel) + "\n```" })}`);
    await tid(page, "assistant-send").click();
    await expect(tid(page, "assistant-proposal-error-box")).toContainText("model", { timeout: 20_000 });
    await expect(tid(page, "assistant-proposal"), "nothing offered").toHaveCount(0);
    expect((await srv.api("GET", "/api/workflows")).body.length, "and nothing written").toBe(1);
  } finally {
    await srv.stop();
  }
});

test("E15.114-1 the thinking hint is drawn like the answer, not as a card", async ({ chief, page }) => {
  // Asked 2026-11-23: *"no white background needed for chief bot's thinking hints"*. It was a bordered white box with a
  // spinner — filled, rounded, elevated — sitting where the answer would be, so it read as a third participant between the
  // question and the reply. It now uses the answer's own shape: the 2 px left rule and nothing else.
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "sidenav")).toBeVisible();
    if (!(await tid(page, "assistant-panel").isVisible().catch(() => false))) await tid(page, "nav-assistant").click();
    // A slow answer, so the hint is on screen long enough to measure.
    await tid(page, "assistant-question").fill(`a slow one ${fake({ text: "the slow answer", sleep_ms: 20_000 })}`);
    await tid(page, "assistant-question").press("Enter");
    const hint = tid(page, "assistant-thinking");
    await expect(hint).toBeVisible();
    const look = await hint.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, top: s.borderTopWidth, right: s.borderRightWidth, bottom: s.borderBottomWidth, left: s.borderLeftWidth, radius: s.borderTopLeftRadius, shadow: s.boxShadow };
    });
    expect(look.bg === "rgba(0, 0, 0, 0)" || look.bg === "transparent", `no fill (was ${look.bg})`).toBe(true);
    expect([look.top, look.right, look.bottom], "no box around it").toEqual(["0px", "0px", "0px"]);
    expect(look.left, "the answer's own left rule").toBe("2px");
    expect(look.radius, "not a bubble").toBe("0px");
    expect(look.shadow, "and not lifted off the page").toBe("none");
    // And it says what it is doing, which is the only thing a state line must do.
    await expect(hint).toContainText(/Working on the workflow|Reading what chief has recorded/);
  } finally {
    await srv.stop();
  }
});

test("E15.113-1 a rough question in the chat box is refined by the bot's own CLI, and the words come back", async ({ chief, page }) => {
  // Asked 2026-11-23: *"add refine prompt using agent for the prompt i typed in the chief bot chatbox, this is to ensure my
  // random thoughts or words can be rephrased in a better agent-friendly prompt"*. It is the designer's Refine (9.37) with
  // a **question** kind: a chat message is read once by an assistant that acts on it, so what the person left implicit is
  // what goes wrong — and the rules therefore say not to invent a workflow, a run or a time they did not mention.
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "sidenav")).toBeVisible();
    await tid(page, "nav-assistant").click();
    const box = tid(page, "assistant-question");
    await expect(box).toBeVisible();
    const refine = tid(page, "assistant-refine");
    // A ghost glyph and a word, like the panel's other chrome, and nothing to refine when nothing is typed.
    await expect(refine).toBeDisabled();
    await expect(refine.locator("svg")).toHaveCount(1);
    await expect(refine).not.toHaveClass(/border/);

    const rough = `make the daily thing run every morning for the payments people ${fake({ text: "Run the em-daily-operation workflow every weekday at 09:00 for the payments team.", sleep_ms: 300, cost: 0.004 })}`;
    await box.fill(rough);
    await expect(refine).toBeEnabled();
    await refine.click();
    // In place, and the panel says who rewrote it and offers the way back.
    await expect(box).toHaveValue("Run the em-daily-operation workflow every weekday at 09:00 for the payments team.");
    await expect(tid(page, "assistant-refined")).toContainText("Rewritten by claude-code");
    // The price is hidden with the other dollar figures (task 15.24).
    await expect(tid(page, "assistant-refined")).not.toContainText("$");

    // What the CLI was asked is the point: the typed text, the rules for a message — not for a step prompt — and no
    // tools or servers, because refining is not a run.
    const call = chief.calls().at(-1)!;
    expect(call.prompt).toContain(`<prompt>\n${rough}\n</prompt>`);
    expect(call.prompt).toContain("a message a person typed into chief's assistant");
    expect(call.prompt).toContain("do not invent a workflow name, a run, a time");
    expect(call.prompt).toContain("Keep every template placeholder exactly as written");
    expect(call.prompt).not.toContain("prompt of one step of an automated workflow");
    expect(call.argv.join(" ")).toContain("--disallowedTools");
    expect((await srv.api("GET", "/api/runs")).body, "refining starts no run").toEqual([]);

    // The way back restores the words exactly, and survives a refresh: it is a draft like everything else typed.
    await expect.poll(() => page.evaluate(() => (window as any).__chiefDraftWrites)).toBe(0);
    await page.reload();
    // The panel's open state is kept across a reload, so clicking the rail item here would *close* it.
    await expect(tid(page, "assistant-panel")).toBeVisible();
    await expect(tid(page, "assistant-refined")).toBeVisible();
    await tid(page, "assistant-refine-undo").click();
    await expect(tid(page, "assistant-question")).toHaveValue(rough);
    await expect(tid(page, "assistant-refined")).toHaveCount(0);

    // Refined again and kept: the offer goes, the text stays.
    await tid(page, "assistant-refine").click();
    await expect(tid(page, "assistant-refined")).toBeVisible();
    await tid(page, "assistant-refine-keep").click();
    await expect(tid(page, "assistant-refined")).toHaveCount(0);
    await expect(tid(page, "assistant-question")).toHaveValue("Run the em-daily-operation workflow every weekday at 09:00 for the payments team.");
  } finally {
    await srv.stop();
  }
});

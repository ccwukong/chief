import type { Page } from "@playwright/test";
import { expect, fake, test as base, type Server, roomyLayout } from "../helpers";

/**
 * Task 9.62: ask about a run. An agent answers questions about a run from the run's record; it has
 * no tools and changes nothing; everything is written to the record.
 */

const test = base.extend<{ boot: () => Promise<Server> }>({
  boot: async ({ chief }, use) => {
    const started: Server[] = [];
    await use(async () => { const s = await chief.serve(); started.push(s); await roomyLayout(s); return s; });
    for (const s of started) await s.stop();
  },
});
const tid = (page: Page, id: string) => page.getByTestId(id);

const ERR = "Prompt is too long: 251000 tokens > 200000 maximum context length";
/** The second step fails twice, then works: a failed run that Resume completes. */
const BROKEN = `name: broken
inputs: { who: me }
nodes:
  - { id: plan, type: agent, mcp: [], prompt: 'PLAN for {{inputs.who}} ${fake({ output: { items: ["a", "b"] }, tools: [{ name: "Read", input: { path: "x" }, result: "ok" }] })}' }
  - { id: big, type: agent, mcp: [], model: sonnet, prompt: 'BIG ${fake({ by_start: [{ error: ERR, tools: [{ name: "mcp__slack__read", input: { channel: "c" }, result: "too much", is_error: true }] }, { error: ERR }, { output: { done: true } }] })}' }
edges: [plan -> big]
`;
const status = async (s: Server, id: number, want: string) => expect.poll(async () => (await s.api("GET", `/api/runs/${id}`)).body.run?.status, { timeout: 20_000 }).toBe(want);

test("E9.62-1 a question about a failed run is answered from its record; follow-ups continue; the record grows and a fresh session gets it all", async ({ chief }) => {
  chief.importWorkflow(BROKEN);
  const s = await chief.serve();
  try {
    const id = (await s.api("POST", "/api/runs", { workflow: "broken" })).body.run.id as number;
    await status(s, id, "failed");
    const costBefore = (await s.api("GET", `/api/runs/${id}`)).body.run.cost_usd;

    // Nothing asked yet.
    const empty = await s.api("GET", `/api/runs/${id}/ask`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ adapter: "claude-code", conversation: [] });

    // The question. (The fake CLI's directive rides in the question; the answer has a second turn for the follow-up.)
    const q1 = `what went wrong? ${fake({ text: "**Step big failed**: the prompt did not fit. Change its model and Resume.", cost: 0.02 }, { text: "Follow-up: pick opus." })}`;
    const a1 = await s.api("POST", `/api/runs/${id}/ask`, { question: q1 });
    expect(a1.status).toBe(200);
    expect(a1.body.answer).toBe("**Step big failed**: the prompt did not fit. Change its model and Resume.");
    expect(a1.body).toMatchObject({ adapter: "claude-code", model: null, cost_usd: 0.02, resumed: false });
    expect(a1.body.conversation.map((t: any) => t.role)).toEqual(["user", "assistant"]);
    expect(a1.body.conversation[1].meta).toMatchObject({ adapter: "claude-code", cost_usd: 0.02, resumed: false });

    // What the agent was given: the run, its status, the failed step with its error and last tool call, and no tools.
    const call = chief.calls().filter((c) => c.prompt.includes("## The question")).at(-1)!;
    expect(call.prompt).toContain(`Run #${id} of workflow "broken"`);
    expect(call.prompt).toContain("Status: failed");
    expect(call.prompt).toContain("### Step big (agent, attempt 1): failed");
    expect(call.prompt).toContain("Error: agent reported an error");
    expect(call.prompt).toContain(ERR);
    expect(call.prompt).toContain("tool call mcp__slack__read");
    expect(call.prompt).toContain("### Step plan (agent, attempt 1): completed");
    expect(call.prompt).toContain('"items"');
    expect(call.prompt).toContain('"who": "me"');
    expect(call.prompt.indexOf("## The question")).toBeLessThan(call.prompt.indexOf("## Run"));
    expect(call.argv).toContain("--disallowedTools");
    expect(call.resume).toBeNull();

    // A follow-up continues the same CLI session: the record has not changed.
    const a2 = await s.api("POST", `/api/runs/${id}/ask`, { question: "and which model?" });
    expect(a2.status).toBe(200);
    expect(a2.body.answer).toBe("Follow-up: pick opus.");
    expect(a2.body.resumed).toBe(true);
    const follow = chief.calls().at(-1)!;
    expect(follow.resume).toBe(call.session);
    expect(follow.prompt).toContain("and which model?");
    expect(follow.prompt).not.toContain("## Run");

    // The record holds the exchange, with no step, and the run's own cost is untouched.
    const rows = (await s.api("GET", `/api/runs/${id}/transcript`)).body as any[];
    const ask = rows.filter((m) => m.kind.startsWith("ask_"));
    expect(ask.map((m) => m.kind)).toEqual(["ask_question", "ask_prompt", "ask_answer", "ask_question", "ask_prompt", "ask_answer"]);
    expect(ask.every((m) => m.node_run_id == null && m.node_id == null)).toBe(true);
    expect(ask[0].content).toBe(q1);
    expect(ask[1].content).toBe(call.prompt);
    // The record holds the command line as run: the binary and the arguments the CLI logged.
    expect(ask[1].meta.argv.slice(1)).toEqual(call.argv);
    expect(ask[2].meta).toMatchObject({ session_id: call.session, cost_usd: 0.02 });
    expect((await s.api("GET", `/api/runs/${id}`)).body.run.cost_usd).toBe(costBefore);

    // The step is fixed and the run resumed: the record grows, so the next question starts over with everything, earlier answers included.
    await s.api("POST", `/api/runs/${id}/steps/big`, { model: "opus" });
    await s.api("POST", `/api/runs/${id}/resume`);
    await status(s, id, "completed");
    const q3 = `summarise ${fake({ text: "All done now." })}`;
    const a3 = await s.api("POST", `/api/runs/${id}/ask`, { question: q3, model: "haiku" });
    expect(a3.body).toMatchObject({ answer: "All done now.", resumed: false, model: "haiku" });
    const fresh = chief.calls().at(-1)!;
    expect(fresh.resume).toBeNull();
    expect(fresh.argv[fresh.argv.indexOf("--model") + 1]).toBe("haiku");
    expect(fresh.prompt).toContain("Status: completed");
    expect(fresh.prompt).toContain("### Step big (agent, attempt 2): completed");
    expect(fresh.prompt).toContain("## Earlier questions and answers");
    expect(fresh.prompt).toContain("Follow-up: pick opus.");
    expect((await s.api("GET", `/api/runs/${id}/ask`)).body.conversation).toHaveLength(6);

    // Nothing to answer, and no such run.
    const blank = await s.api("POST", `/api/runs/${id}/ask`, { question: "   " });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toMatch(/no question yet/);
    expect((await s.api("POST", "/api/runs/999/ask", { question: "hi" })).status).toBe(404);
    expect((await s.api("GET", "/api/runs/999/ask")).status).toBe(404);
  } finally { await s.stop(); }
});

test("E9.62-2 on a run's page the assistant is about that run: a draft survives a reload, the answer is formatted, the conversation stays", async ({ chief, boot, page }) => {
  chief.importWorkflow(BROKEN);
  const srv = await boot();
  const id = (await srv.api("POST", "/api/runs", { workflow: "broken" })).body.run.id as number;
  await status(srv, id, "failed");
  await page.goto(`${srv.url}/#/runs/${id}`);
  await expect(tid(page, "run-status")).toHaveText("failed");

  await tid(page, "assistant-button").click();
  const panel = tid(page, "assistant-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-run", String(id));
  await expect(tid(page, "assistant-context")).toHaveText(`about run #${id}`);
  await expect(tid(page, "assistant-suggestion-0")).toHaveText("What went wrong, and what should I do next?");
  await expect(tid(page, "assistant-send")).toBeDisabled();
  await expect(tid(page, "assistant-model")).toHaveAttribute("data-loaded", "true");

  // What is typed is a draft: a reload keeps it (and the panel stays open).
  const q = `why did big fail? ${fake({ text: "Because **the prompt was too long**.\n\n- change the model\n- press Resume", sleep_ms: 600, cost: 0.03 })}`;
  await tid(page, "assistant-question").fill(q);
  await page.waitForFunction(() => !(window as any).__chiefDraftWrites);
  await page.reload();
  await expect(tid(page, "assistant-panel")).toBeVisible();
  await expect(tid(page, "assistant-question")).toHaveValue(q);

  // Enter sends. While the agent works the button is busy and the question is already shown.
  await tid(page, "assistant-question").press("Enter");
  await expect(tid(page, "assistant-send")).toHaveAttribute("aria-busy", "true");
  await expect(tid(page, "assistant-turn-pending")).toHaveText(q);
  const answer = tid(page, "assistant-turn-assistant");
  await expect(answer).toHaveCount(1);
  await expect(answer.locator("strong")).toHaveText("the prompt was too long");
  await expect(answer.locator("li")).toHaveCount(2);
  await expect(tid(page, "assistant-turn-meta")).toContainText(`claude-code · run #${id}`);
  // No dollars in the meta line while cost is hidden (task 15.24).
  await expect(tid(page, "assistant-turn-meta")).not.toContainText("$");
  await expect(tid(page, "assistant-turn-user")).toHaveText(q);
  await expect(tid(page, "assistant-question")).toHaveValue("");
  await expect(tid(page, "assistant-error")).toHaveCount(0);
  // The agent was given the run's record.
  const call = chief.calls().filter((c) => c.prompt.includes("## The question")).at(-1)!;
  expect(call.prompt).toContain(`looking at the page of run #${id}`);
  expect(call.prompt).toContain("### Step big (agent, attempt 1): failed");
  expect(call.prompt).toContain(ERR);

  // Still there after a reload.
  await page.reload();
  await expect(tid(page, "assistant-turn-user")).toHaveText(q);
  await expect(tid(page, "assistant-turn-assistant")).toContainText("the prompt was too long");
});

test("E9.62-3 chief runs ask prints the answer; --json and --model; a missing question; runs show points to it", ({ chief }) => {
  chief.importWorkflow(BROKEN);
  expect(chief.run(["run", "broken"]).code).toBe(1);

  const show = chief.run(["runs", "show", "1"]);
  expect(show.stdout).toContain(`error in big: `);
  expect(show.stdout).toContain(ERR);
  expect(show.stdout).toContain('ask about it: chief runs ask 1 "what went wrong?"');

  // The fake CLI's directive rides in the first question; its second turn answers the follow-up (same session: the record has not changed).
  const plain = chief.run(["runs", "ask", "1", `what went wrong? ${fake({ text: "Step big ran out of context. Change its model, then resume.", cost: 0.015 }, { text: "One step failed." })}`]);
  expect(plain.code).toBe(0);
  expect(plain.stdout).toContain("Step big ran out of context. Change its model, then resume.");
  expect(plain.stdout).toContain("(claude-code · $0.0150)");

  const json = chief.run(["runs", "ask", "1", "summarise", "it", "please", "--model", "haiku", "--json"]);
  expect(json.code).toBe(0);
  expect(json.json()).toMatchObject({ answer: "One step failed.", adapter: "claude-code", model: "haiku", cost_usd: 0.01, resumed: true });
  expect(json.json().conversation).toHaveLength(4);
  expect(json.json().conversation[2].text).toBe("summarise it please");
  const last = chief.calls().at(-1)!;
  expect(last.argv[last.argv.indexOf("--model") + 1]).toBe("haiku");
  expect(last.resume).not.toBeNull();

  const missing = chief.run(["runs", "ask", "1"]);
  expect(missing.code).not.toBe(0);
  expect(missing.stderr).toContain('missing question: chief runs ask <id> "what went wrong?"');
  expect(missing.stderr).toContain("Usage: chief");
});

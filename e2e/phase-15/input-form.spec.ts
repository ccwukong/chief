import type { Page } from "@playwright/test";
import { expect, fake, roomyLayout, test, openInputSetPanel } from "../helpers";

const tid = (page: Page, id: string) => page.getByTestId(id);

/**
 * The inputs a run is given are **declared** (dev plan 15.119): a workflow may say, for each input, the
 * words it is asked with, its type and whether a value must be given. The declaration is checked by one
 * function (`describeInputs`) and refused by one place (`missingRequired`), so the API, the CLI, a
 * schedule and the form that comes next all read the same thing. A definition without one keeps working
 * exactly as it did: the fields are **inferred** from the prompts and the defaults, and are still typed
 * and labelled — by their path.
 *
 * The form that asks these fields is 15.120; the designer's field list is 15.121. Until they are built
 * the JSON editor is still what a person types into, and `E9.48-3` still says so.
 */

/** One workflow using all three kinds of field: declared and used, declared and unused, and inferred. */
const DECLARED = `
name: declare
inputs: { params: { lookback-hours: 24 }, notify: true }
input-fields:
  - { path: planner.prlink, label: Pull request link, type: text, required: true, description: The pull request to review }
  - { path: params.lookback-hours, label: Hours back, type: number }
  - { path: notify, label: Notify me, type: yes-no }
  - { path: extra.note, label: A note for the record, type: text }
nodes:
  - { id: plan, type: agent, mcp: [], prompt: 'Review {{inputs.planner.prlink}} over {{inputs.params.lookback-hours}}h, notify {{inputs.notify}} ${fake({ output: { ok: true } })}' }
`;

test("E15.119-1 the declaration is what the server checks, and undeclared paths still work", async ({ chief }) => {
  expect(chief.importWorkflow(DECLARED).code).toBe(0);
  const s = await chief.serve();
  try {
    // The declared fields come first and in their order, the declared one no prompt reads after the used
    // ones, and a prompt that reads an input nobody declared still gets an entry — inferred, not missing.
    const w = await s.api("GET", "/api/workflows/declare");
    expect(w.body.input_refs).toEqual([
      { path: "planner.prlink", has_default: false, label: "Pull request link", type: "text", required: true, declared: true, description: "The pull request to review" },
      { path: "params.lookback-hours", has_default: true, default: 24, label: "Hours back", type: "number", required: false, declared: true },
      { path: "notify", has_default: true, default: true, label: "Notify me", type: "yes-no", required: false, declared: true },
      { path: "extra.note", has_default: false, label: "A note for the record", type: "text", required: false, declared: true },
    ]);

    // A required field with no value is refused before anything starts, naming the label **and** the path.
    const bad = await s.api("POST", "/api/runs", { workflow: "declare" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("Pull request link");
    expect(bad.body.error).toContain("planner.prlink");
    expect(chief.calls()).toHaveLength(0);

    // Given, it starts: the number stays a number and the boolean a boolean, and the default is kept.
    const ok = await s.api("POST", "/api/runs", { workflow: "declare", inputs: { planner: { prlink: "https://x/pull/4" }, params: { "lookback-hours": 48 } } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const id = ok.body.run.id;
    await chief.until(async () => (await s.api("GET", `/api/runs/${id}`)).body.run.status === "completed");
    expect(chief.calls()[0].prompt).toContain("Review https://x/pull/4 over 48h, notify true");
    const first = (await s.api("GET", `/api/runs/${id}/transcript`)).body[0];
    expect(JSON.parse(first.content)).toEqual({ params: { "lookback-hours": 48 }, notify: true, planner: { prlink: "https://x/pull/4" } });

    // A value nobody declared is accepted: the declaration describes, it does not close the object.
    const extra = await s.api("POST", "/api/runs", { workflow: "declare", inputs: { planner: { prlink: "https://x/pull/5" }, undeclared: "kept" } });
    expect(extra.status, JSON.stringify(extra.body)).toBe(201);
    expect(extra.body.run.inputs).toMatchObject({ undeclared: "kept" });

    // A required field **no prompt reads** is refused too — the one thing the referenced-input check cannot
    // do, since nothing refers to it. This is what makes the declaration more than a relabelling.
    expect(chief.importWorkflow(`
name: unread
input-fields:
  - { path: ticket, label: Ticket number, type: text, required: true }
nodes:
  - { id: a, type: agent, mcp: [], prompt: '${fake({ output: { ok: true } })}' }
`).code).toBe(0);
    const unread = await s.api("POST", "/api/runs", { workflow: "unread" });
    expect(unread.status, JSON.stringify(unread.body)).toBe(400);
    expect(unread.body.error).toContain("Ticket number");
    expect(unread.body.error).toContain("inputs.ticket");
    expect(unread.body.error).not.toContain("no value at all");
    expect((await s.api("POST", "/api/runs", { workflow: "unread", inputs: { ticket: "42" } })).status).toBe(201);

    // A definition with no declaration is unchanged: the same two entries as before 15.119, now typed.
    expect(chief.importWorkflow(`
name: plain
inputs: { params: { repo: my-org/app } }
nodes:
  - { id: review, type: agent, mcp: [], prompt: 'Review {{inputs.params.prlink}} in {{inputs.params.repo}} ${fake({ output: { ok: true } })}' }
`).code).toBe(0);
    expect((await s.api("GET", "/api/workflows/plain")).body.input_refs).toEqual([
      { path: "params.prlink", has_default: false, label: "params.prlink", type: "text", required: false, declared: false },
      { path: "params.repo", has_default: true, default: "my-org/app", label: "params.repo", type: "text", required: false, declared: false },
    ]);

    // A declaration that cannot be satisfied is refused when it is written, and nothing is written.
    const before = (await s.api("GET", "/api/workflows/plain")).body.version;
    const contradictory = async (bad: string) => {
      const put = await s.api("PUT", "/api/workflows/plain", { definition: { ...(await s.api("GET", "/api/workflows/plain")).body.definition, ...bad } });
      expect(put.status, JSON.stringify(put.body)).toBe(400);
      expect((await s.api("GET", "/api/workflows/plain")).body.version).toBe(before);
      return put.body.error as string;
    };
    // A field that is required and has a default says two things at once.
    expect(await contradictory({ "input-fields": [{ path: "params.repo", label: "Repo", type: "text", required: true }] })).toContain("required");
    // An option with no value: the step would receive nothing when it is picked.
    expect(await contradictory({ "input-fields": [{ path: "params.prlink", label: "Link", type: "text", options: [{ label: "x" }] }] })).toContain("options");
    // A choice field with nothing to choose from.
    expect(await contradictory({ "input-fields": [{ path: "params.prlink", label: "Link", type: "choose-one" }] })).toContain("options");
    // A text field whose default is an object: the type would be a lie.
    expect(await contradictory({ "input-fields": [{ path: "params", label: "Params", type: "text" }] })).toContain("object");
  } finally { await s.stop(); }
});

test("E15.119-2 the CLI and YAML carry the same declaration and refuse the same way", ({ chief }) => {
  expect(chief.importWorkflow(DECLARED).code).toBe(0);

  // `chief run` refuses before the agent CLI is started, naming the label and the path and how to give it.
  const refused = chief.run(["run", "declare"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr + refused.stdout).toContain("Pull request link");
  expect(refused.stderr + refused.stdout).toContain("inputs.planner.prlink");
  expect(refused.stderr + refused.stdout).toContain("--input planner.prlink=");
  expect(chief.calls()).toHaveLength(0);

  // Given, the run goes, the workflow's own default fills the number, and the prompt reads both.
  const ok = chief.run(["run", "declare", "--input", "planner.prlink=https://x/pull/8", "--json"]);
  expect(ok.code, ok.stdout + ok.stderr).toBe(0);
  expect(ok.json().run.status).toBe("completed");
  expect(chief.calls()[0].prompt).toContain("Review https://x/pull/8 over 24h, notify true");
  expect(ok.json().run.inputs).toEqual({ planner: { prlink: "https://x/pull/8" } });

  // A schedule that would be refused at every tick is refused now, the same way.
  const sched = chief.run(["schedule", "add", "declare", "0 9 * * 1"]);
  expect(sched.code).toBe(1);
  expect(sched.stderr + sched.stdout).toContain("Pull request link");
  expect(chief.run(["schedule", "add", "declare", "0 9 * * 1", "--inputs-json", '{"planner":{"prlink":"https://x/pull/9"}}']).code).toBe(0);

  // The declaration is part of the YAML, and survives a round trip through it.
  const exported = chief.run(["workflow", "export", "declare"]);
  expect(exported.code).toBe(0);
  expect(exported.stdout).toContain("input-fields:");
  expect(exported.stdout).toContain("Pull request link");
  expect(chief.importWorkflow(exported.stdout).code).toBe(0);
  const roundTrip = chief.run(["workflow", "export", "declare", "--format", "json"]).json();
  expect(roundTrip["input-fields"]).toHaveLength(4);
  expect(roundTrip["input-fields"][0]).toMatchObject({ path: "planner.prlink", label: "Pull request link", type: "text", required: true });

  // `validate` names the field and says what is wrong with it, without importing anything.
  const file = chief.file("bad.yaml", `
name: bad
inputs: { repo: my-org/app }
input-fields:
  - { path: repo, label: Repo, type: text, required: true }
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'hi' }
`);
  const bad = chief.run(["workflow", "validate", file, "--json"]);
  expect(bad.code).toBe(1);
  expect(bad.json().errors.join("\n")).toContain('"repo"');
  expect(bad.json().errors.join("\n")).toContain("required");
});

/**
 * 15.120 and 15.121: the form a run is given its inputs by, and the field list the author writes it with.
 * E9.48-3, E15.49-1 and E15.116-1 were rewritten with them: they had asserted that the JSON editor was the
 * only way in, which is exactly what these tasks change.
 */

const FORM = `
name: formy
inputs: { hours: 24, filters: { label: docs } }
input-fields:
  - { path: prlink, label: Pull request link, type: text, required: true, description: The pull request to review }
  - { path: hours, label: Hours back, type: number }
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'Review {{inputs.prlink}} over {{inputs.hours}}h with {{inputs.filters}} ${fake({ output: { ok: true } })}' }
`;

test("E15.120-1 a collection's inputs are a form and a JSON view of one value", async ({ chief, page }) => {
  expect(chief.importWorkflow(FORM).code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.goto(`${srv.url}/#/runs`);
    // The page opens on Collections (15.126); the editor is where a run's inputs are written.
    await openInputSetPanel(page);
    await tid(page, "input-set-workflow").selectOption("formy");

    // **Every field is on screen**, each holding what the run would get. The old form folded those with a default
    // away and showed no field at all for a fully-defaulted workflow (reported 2026-11-24: *"how would anyone be able
    // to know how this thing works and there's a form for the input?"*).
    await expect(tid(page, "new-run-inputs-field-prlink")).toBeVisible();
    await expect(tid(page, "new-run-inputs-field-hours")).toBeVisible();
    await expect(tid(page, "new-run-inputs-hours-input")).toHaveValue("24");
    await expect(tid(page, "new-run-inputs-field-filters")).toBeVisible();
    await expect(tid(page, "new-run-inputs-count")).toContainText("3 fields, already filled from the workflow");
    // A value nobody has touched is marked as the workflow's, so it can be told from one the person typed.
    await expect(tid(page, "new-run-inputs-from-workflow-hours")).toBeVisible();
    await expect(tid(page, "new-run-inputs-from-workflow-prlink"), "an empty field has no default to be").toHaveCount(0);
    // The label is the person's, the path is under it so it connects to the prompt, and the note is the author's.
    await expect(tid(page, "new-run-inputs-field-prlink")).toContainText("Pull request link");
    await expect(tid(page, "new-run-inputs-field-prlink")).toContainText("{{inputs.prlink}}");
    await expect(tid(page, "new-run-inputs-field-prlink")).toContainText("The pull request to review");

    // A required field with no value disables Start, and the button says which one. Nothing is refused after a click.
    await expect(tid(page, "input-set-start")).toBeDisabled();
    await expect(tid(page, "input-set-start")).toHaveAttribute("title", /Pull request link/);
    expect(chief.calls()).toHaveLength(0);

    // A default can be changed for this collection, and a value typed into a number field is a number.
    await tid(page, "new-run-inputs-hours-input").fill("48");
    await expect(tid(page, "new-run-inputs-from-workflow-hours"), "a changed value is no longer the workflow's").toHaveCount(0);

    // The switch is the only way between the two views, and both hold the same value in both directions.
    await tid(page, "new-run-inputs-view-json").click();
    const json = tid(page, "new-run-inputs");
    await expect(json).toBeVisible();
    await expect(tid(page, "new-run-inputs-pane-form")).toBeHidden();
    expect(JSON.parse(await json.inputValue())).toMatchObject({ hours: 48, filters: { label: "docs" } });
    // From the JSON into the form…
    await json.fill(JSON.stringify({ prlink: "https://x/pull/1", hours: 12, filters: { label: "docs" } }, null, 2));
    await tid(page, "new-run-inputs-view-form").click();
    await expect(tid(page, "new-run-inputs-prlink-input")).toHaveValue("https://x/pull/1");
    await expect(tid(page, "new-run-inputs-hours-input")).toHaveValue("12");
    // …and from the form into the JSON.
    await tid(page, "new-run-inputs-prlink-input").fill("https://x/pull/2");
    await tid(page, "new-run-inputs-view-json").click();
    await expect.poll(async () => JSON.parse(await json.inputValue()).prlink).toBe("https://x/pull/2");

    // An object has no control, and the form says where it lives instead of pretending it can edit it.
    await tid(page, "new-run-inputs-view-form").click();
    await expect(tid(page, "new-run-inputs-field-filters")).toContainText("An object or a list");

    // While the JSON is not valid, the switch sends the person to it and the form is paused — never a second, stale
    // answer. The JSON is the view on screen, so it is the one that is typed in.
    await tid(page, "new-run-inputs-view-json").click();
    await json.fill('{"prlink":');
    await expect(tid(page, "new-run-inputs-invalid-hint")).toBeVisible();
    await tid(page, "new-run-inputs-view-form").click();
    await expect(tid(page, "new-run-inputs-paused")).toContainText("not a valid object");
    await expect(tid(page, "new-run-inputs-prlink-input")).toBeDisabled();
    await expect(tid(page, "input-set-start")).toBeDisabled();

    // A draft survives a refresh: the editor is reopened and still holds what was typed (the rule for every field).
    await tid(page, "new-run-inputs-view-json").click();
    await json.fill(JSON.stringify({ prlink: "https://x/pull/3", hours: 6, filters: { label: "docs" } }, null, 2));
    await page.reload();
    await openInputSetPanel(page);
    await tid(page, "input-set-workflow").selectOption("formy");
    await expect(tid(page, "new-run-inputs-prlink-input")).toHaveValue("https://x/pull/3");

    // Starting saves the collection and starts the run from it, and the run page reads it back.
    await tid(page, "input-set-name").fill("One pull request");
    await tid(page, "input-set-start").click();
    await expect(tid(page, "run-status")).toHaveText("completed", { timeout: 30_000 });
    expect(chief.calls()[0].prompt).toContain("Review https://x/pull/3 over 6h");
    await expect(tid(page, "run-collection")).toContainText("prepared as “One pull request”");
    await expect(tid(page, "run-input-prlink")).toContainText("https://x/pull/3");
    await expect(tid(page, "run-input-hours")).toContainText("6");
  } finally {
    await srv.stop();
  }
});

test("E15.120-4 a workflow whose inputs all have defaults still shows its form, field by field", async ({ chief, page }) => {
  // Reported 2026-11-24: *"how would anyone be able to know how this thing works and there's a form for the input?"* —
  // with a screenshot of a card whose only trace of five inputs was one grey line, "Using the workflow's defaults (5) +".
  // The form had folded away every field that had a default, which on an ordinary workflow is **every field**.
  expect(chief.importWorkflow(`
name: all-defaulted
inputs: { prlink: https://x/pull/1, hours: 24, note: "a longer note that runs past the short line" }
input-fields:
  - { path: prlink, label: Pull request link, type: text }
  - { path: hours, label: Hours back, type: number }
  - { path: note, label: A note, type: long-text }
nodes:
  - { id: a, type: agent, mcp: [], prompt: 'x {{inputs.prlink}}' }
`).code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`${srv.url}/#/runs`);
    await openInputSetPanel(page);
    await tid(page, "input-set-workflow").selectOption("all-defaulted");

    // Every field is a control on screen, with its value in it — not a line of text about the values.
    for (const path of ["prlink", "hours", "note"]) {
      await expect(tid(page, `new-run-inputs-field-${path}`), `${path} is a field`).toBeVisible();
    }
    await expect(tid(page, "new-run-inputs-prlink-input")).toHaveValue("https://x/pull/1");
    await expect(tid(page, "new-run-inputs-hours-input")).toHaveValue("24");
    await expect(tid(page, "new-run-inputs-note-input")).toHaveValue(/a longer note/);
    // The long-text one is a box sized to its content, not a one-line input holding prose.
    const rows = await tid(page, "new-run-inputs-note-input").evaluate((el) => (el as HTMLTextAreaElement).tagName + ":" + (el as HTMLTextAreaElement).rows);
    expect(rows.startsWith("TEXTAREA:")).toBe(true);
    expect(Number(rows.split(":")[1])).toBeGreaterThan(2);

    // The count says the shape before a field is read, and no field is hidden behind a disclosure.
    await expect(tid(page, "new-run-inputs-count")).toContainText("3 fields, already filled from the workflow");
    await expect(tid(page, "new-run-inputs-defaults-toggle")).toHaveCount(0);
    await expect(tid(page, "new-run-inputs-defaults-summary")).toHaveCount(0);

    // Each says its value is the workflow's, and the run can still be started as it stands.
    for (const path of ["prlink", "hours", "note"]) await expect(tid(page, `new-run-inputs-from-workflow-${path}`)).toBeVisible();
    await expect(tid(page, "input-set-start")).toBeEnabled();
    await tid(page, "input-set-start").click();
    await expect(tid(page, "run-status")).toHaveText("completed", { timeout: 30_000 });
    expect(chief.calls()[0].prompt).toContain("x https://x/pull/1");
  } finally { await srv.stop(); }
});

test("E15.120-3 the switch between the form and the JSON is obvious, and one value comes back both ways", async ({ chief, page }) => {
  // Asked 2026-11-24, twice: a folded "Edit as JSON" link is not a toggle a person can see (*"there should be a
  // toggle button between the form view and JSON editor view, and the toggle button should be obvious enough"*).
  expect(chief.importWorkflow(FORM).code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${srv.url}/#/runs`);
    await openInputSetPanel(page);
    await tid(page, "input-set-workflow").selectOption("formy");

    // Two labelled, visible halves — not a word hiding a disclosure — and the form is the one shown first.
    const switch_ = tid(page, "new-run-inputs-view-switch");
    await expect(switch_).toBeVisible();
    await expect(switch_).toHaveAccessibleName("How to fill in the inputs");
    await expect(tid(page, "new-run-inputs-view-form")).toBeVisible();
    await expect(tid(page, "new-run-inputs-view-json")).toBeVisible();
    await expect(tid(page, "new-run-inputs-view-form")).toHaveAttribute("aria-selected", "true");
    await expect(tid(page, "new-run-inputs-view-form")).toContainText("Form");
    await expect(tid(page, "new-run-inputs-view-json")).toContainText("JSON");
    // Big enough to hit and to read: at least 32 px tall, and its labels are body-size rather than caption-size
    // (the type scale is the person's own, so this is measured against the page's body text, not a fixed px).
    const box = (await switch_.boundingBox())!;
    expect(box.height, "the switch is a control, not a caption").toBeGreaterThanOrEqual(32);
    const sizes = await page.evaluate(() => ({
      label: parseFloat(getComputedStyle(document.querySelector('[data-testid="new-run-inputs-view-form"]')!).fontSize),
      body: parseFloat(getComputedStyle(document.body).fontSize),
    }));
    expect(sizes.label, "its labels are read, not squinted at").toBeGreaterThanOrEqual(sizes.body * 0.85);
    // The active tab stands out from the track, so which view is in use needs no reading.
    const activeBg = await tid(page, "new-run-inputs-view-form").evaluate((el) => getComputedStyle(el).backgroundColor);
    const idleBg = await tid(page, "new-run-inputs-view-json").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(activeBg).not.toBe(idleBg);

    // It is **the tab component, doing a tab component's job** — not tab roles painted onto hand-rolled panes, which
    // is what shipped first and what this asserts against (2026-11-24: `tabpanels: 0`, both `aria-controls` dangling).
    const wiring = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('[data-testid="new-run-inputs-view-switch"] [role="tab"]')];
      return {
        tabs: tabs.length,
        controls: tabs.map((t) => t.getAttribute("aria-controls")),
        pointing: tabs.map((t) => !!document.getElementById(t.getAttribute("aria-controls") ?? "")),
        panels: document.querySelectorAll('[data-testid="new-run-inputs-pane-form"], [data-testid="new-run-inputs-pane-json"]').length,
        back: [...document.querySelectorAll('[role="tabpanel"]')].map((p) => {
          const label = document.getElementById(p.getAttribute("aria-labelledby") ?? "");
          return label?.getAttribute("aria-selected") !== null && !!label;
        }),
        visiblePanels: ["new-run-inputs-pane-form", "new-run-inputs-pane-json"]
          .map((id) => document.querySelector(`[data-testid="${id}"]`))
          .filter((el) => !!el && !!(el as HTMLElement).offsetWidth).length,
      };
    });
    expect(wiring.tabs).toBe(2);
    expect(wiring.pointing, "every tab controls a panel that exists").toEqual([true, true]);
    expect(wiring.panels, "there are tab panels, not divs").toBe(2);
    expect(wiring.back.every(Boolean), "every panel is labelled by its tab").toBe(true);
    expect(wiring.visiblePanels, "one panel at a time").toBe(1);

    // The component's own keyboard behaviour, which hand-rolled panes would not have.
    await tid(page, "new-run-inputs-view-form").focus();
    await page.keyboard.press("ArrowRight");
    await expect(tid(page, "new-run-inputs-view-json")).toHaveAttribute("aria-selected", "true");
    await expect(tid(page, "new-run-inputs-view-form")).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("ArrowLeft");
    await expect(tid(page, "new-run-inputs-view-form")).toHaveAttribute("aria-selected", "true");

    // One value, two views: away and back keeps what each holds, and the switch says which is in use.
    await tid(page, "new-run-inputs-prlink-input").fill("https://x/pull/toggle");
    await tid(page, "new-run-inputs-view-json").click();
    await expect(tid(page, "new-run-inputs-view-json")).toHaveAttribute("aria-selected", "true");
    await expect(tid(page, "new-run-inputs-pane-form")).toBeHidden();
    await expect(tid(page, "new-run-inputs")).toHaveValue(/"prlink": "https:\/\/x\/pull\/toggle"/);
    await tid(page, "new-run-inputs-view-form").click();
    await expect(tid(page, "new-run-inputs-pane-json")).toBeHidden();
    await expect(tid(page, "new-run-inputs-prlink-input")).toHaveValue("https://x/pull/toggle");
    // Nothing was lost by the round trip: the run starts with exactly that value.
    await tid(page, "input-set-start").click();
    await expect(tid(page, "run-status")).toHaveText("completed", { timeout: 30_000 });
    expect(chief.calls()[0].prompt).toContain("https://x/pull/toggle");
  } finally { await srv.stop(); }
});

test("E15.120-2 each workflow's collection has its own fields and its own values", async ({ chief, page }) => {
  expect(chief.importWorkflow("name: one\ninput-fields:\n  - { path: a, label: First value, type: text, required: true }\nnodes:\n  - { id: x, type: agent, mcp: [], prompt: 'one {{inputs.a}}' }\n").code).toBe(0);
  expect(chief.importWorkflow("name: two\ninput-fields:\n  - { path: b, label: Second value, type: long-text }\nnodes:\n  - { id: y, type: agent, mcp: [], prompt: 'two {{inputs.b}}' }\n").code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.goto(`${srv.url}/#/runs`);

    // A collection of `one`: only its field, and it is required, so Start is disabled and names it.
    await openInputSetPanel(page);
    await tid(page, "input-set-workflow").selectOption("one");
    await expect(tid(page, "new-run-inputs-field-a")).toBeVisible();
    await expect(tid(page, "new-run-inputs-field-b")).toHaveCount(0);
    await expect(tid(page, "input-set-start")).toBeDisabled();
    await expect(tid(page, "input-set-start")).toHaveAttribute("title", /First value/);
    await tid(page, "new-run-inputs-a-input").fill("first thing");

    // A collection of `two`: its own field, its own empty value — never the other workflow's.
    await tid(page, "input-set-close").click();
    await openInputSetPanel(page);
    await tid(page, "input-set-workflow").selectOption("two");
    await expect(tid(page, "new-run-inputs-field-b")).toBeVisible();
    await expect(tid(page, "new-run-inputs-field-a")).toHaveCount(0);
    await expect(tid(page, "new-run-inputs-b-input")).toHaveValue("");
    // Its field is not required, so this one can start as it stands.
    await expect(tid(page, "input-set-start")).toBeEnabled();

    // 375 px: the panel, the tabs, the editor and the table fit, and nothing scrolls sideways.
    await page.setViewportSize({ width: 375, height: 800 });
    await tid(page, "input-set-start").scrollIntoViewIfNeeded();
    await expect(tid(page, "input-set-start")).toBeInViewport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "the page does not scroll sideways at 375 px").toBeLessThanOrEqual(0);
  } finally {
    await srv.stop();
  }
});

test("E15.121-1 the designer authors the field list, and offers the inferred ones without writing them", async ({ chief, page }) => {
  expect(chief.importWorkflow("name: authored\ninputs: { mode: dry }\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'go {{inputs.prlink}} in {{inputs.mode}}' }\n").code).toBe(0);
  const srv = await chief.serve();
  await roomyLayout(srv);
  const def = async () => (await srv.api("GET", "/api/workflows/authored")).body.definition;
  try {
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.goto(`${srv.url}/#/designer/authored`);
    await expect(tid(page, "flow-node-a")).toBeVisible();
    await tid(page, "tab-workflow").click();

    // No fields yet, and nothing is written just by looking: the offer names what the prompts read.
    await expect(tid(page, "wf-inputs-empty")).toBeVisible();
    expect((await def())["input-fields"]).toBeUndefined();
    await expect(tid(page, "wf-inputs-adopt")).toContainText("Add the 2 inputs the prompts use");

    // One click declares them, typed from each default — the field list is written by the autosave, no Save button.
    await tid(page, "wf-inputs-adopt").click();
    await expect(tid(page, "wf-input-field-0")).toBeVisible();
    await expect(tid(page, "wf-input-field-1")).toBeVisible();
    await expect.poll(async () => (await def())["input-fields"]).toEqual([
      { path: "prlink", label: "prlink", type: "text", required: false },
      { path: "mode", label: "mode", type: "text", required: false },
    ]);

    // The words, the type and the note are the author's; the declaration follows as they are typed.
    await tid(page, "wf-field-label-0").fill("Pull request link");
    await tid(page, "wf-field-type-0").selectOption("text");
    await tid(page, "wf-field-description-0").fill("The pull request to review");
    await expect.poll(async () => (await def())["input-fields"]?.[0]).toMatchObject({ label: "Pull request link", description: "The pull request to review" });

    // A field's value **is** the default: written to inputs[path], the one place a default lives.
    await tid(page, "wf-field-value-0-input").fill("https://x/pull/9");
    await expect.poll(async () => (await def()).inputs?.prlink).toBe("https://x/pull/9");

    // A new field, and one removed: the list is the author's.
    await tid(page, "wf-inputs-add").click();
    await expect(tid(page, "wf-input-field-2")).toBeVisible();
    await tid(page, "wf-field-remove-2").click();
    await expect(tid(page, "wf-input-field-2")).toHaveCount(0);

    // A declaration that cannot be satisfied is named in the validation panel, and the last valid version keeps running.
    const validVersion = (await srv.api("GET", "/api/workflows/authored")).body.version;
    await tid(page, "wf-field-required-0").click();
    await expect(tid(page, "validation-errors")).toContainText("required");
    // Nothing invalid is published: the stored version and its field list are the last valid ones.
    await expect.poll(async () => (await srv.api("GET", "/api/workflows/authored")).body.version).toBe(validVersion);
    expect((await def())["input-fields"]?.[0]).toMatchObject({ label: "Pull request link", required: false });
    // Required and a default at once is the contradiction: take the value away and it is valid again.
    await tid(page, "wf-field-value-0-input").fill("");
    await expect(tid(page, "validation-summary")).toHaveText("Valid");
    await expect.poll(async () => (await def())["input-fields"]?.[0]).toMatchObject({ required: true });

    // The JSON view edits the values too, for an object or a list no field holds. (Required is off first: a
    // required field with a value is the contradiction, by design.)
    await tid(page, "wf-field-required-0").click();
    await tid(page, "wf-inputs").fill('{"prlink": "https://x/pull/10", "mode": "dry", "extra": [1, 2]}');
    await expect.poll(async () => (await def()).inputs).toMatchObject({ prlink: "https://x/pull/10", extra: [1, 2] });
    await expect(tid(page, "wf-field-value-0-input")).toHaveValue("https://x/pull/10");

    // It all survives a reload, because it is the workflow and not page state.
    await page.reload();
    await expect(tid(page, "wf-input-field-0")).toBeVisible();
    await expect(tid(page, "wf-field-label-0")).toHaveValue("Pull request link");
  } finally {
    await srv.stop();
  }
});

test("E15.121-2 a schedule asks the same way, and the run page reads the same form", async ({ chief, page }) => {
  expect(chief.importWorkflow(FORM).code).toBe(0);
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.goto(`${srv.url}/#/schedules`);
    await tid(page, "schedule-workflow").selectOption("formy");
    await tid(page, "schedule-cron").fill("0 9 * * 1");

    // The fields, not a JSON box — and a required one left empty is refused, naming the label and the path.
    await expect(tid(page, "schedule-inputs-field-prlink")).toBeVisible();
    await expect(tid(page, "schedule-inputs-hours-input")).toHaveValue("24");
    await tid(page, "schedule-add").click();
    await expect(tid(page, "schedule-error")).toContainText("Pull request link");
    await expect(tid(page, "schedule-error")).toContainText("inputs.prlink");
    expect((await srv.api("GET", "/api/schedules")).body).toEqual([]);

    // Given, it is created, and the stored inputs are the values the form showed — the shape, including the
    // defaults, so a schedule is a configuration a person can read back rather than a delta.
    await tid(page, "schedule-inputs-prlink-input").fill("https://x/pull/11");
    await tid(page, "schedule-add").click();
    await expect(tid(page, "schedule-row-1")).toBeVisible();
    expect((await srv.api("GET", "/api/schedules")).body[0].inputs).toEqual({ prlink: "https://x/pull/11", hours: 24, filters: { label: "docs" } });
    await expect(tid(page, "schedule-inputs-summary-1")).toContainText("prlink: https://x/pull/11");

    // The row opens the same form; a field saves itself, and the summary follows.
    await tid(page, "schedule-inputs-summary-1").click();
    await tid(page, "schedule-inputs-1-prlink-input").fill("https://x/pull/12");
    await expect.poll(async () => (await srv.api("GET", "/api/schedules")).body[0].inputs?.prlink).toBe("https://x/pull/12");
    await tid(page, "schedule-inputs-done-1").click();
    await expect(tid(page, "schedule-inputs-summary-1")).toContainText("prlink: https://x/pull/12");

    // And a run of that workflow reads back as the form that asked, JSON one click away.
    const run = await srv.api("POST", "/api/runs", { workflow: "formy", inputs: { prlink: "https://x/pull/13" } });
    await chief.until(async () => (await srv.api("GET", `/api/runs/${run.body.run.id}`)).body.run.status === "completed");
    await page.goto(`${srv.url}/#/runs/${run.body.run.id}/full`);
    await tid(page, "run-inputs").locator("summary").first().click();
    await expect(tid(page, "run-input-prlink")).toContainText("https://x/pull/13");
    await expect(tid(page, "run-input-hours")).toContainText("24");
    await tid(page, "run-inputs-json-view").locator("summary").click();
    await expect(tid(page, "run-inputs-json")).toContainText('"prlink": "https://x/pull/13"');
  } finally {
    await srv.stop();
  }
});

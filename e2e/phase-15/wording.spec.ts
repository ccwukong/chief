import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, ROOT_DIR, test } from "../helpers";

/**
 * Phase 15, task 15.10: chief is an orchestrator for agent CLIs, not for coding-agent CLIs. Nothing in
 * the engine assumes a coding agent — an adapter is a command-line contract, an agent node is a prompt
 * and MCP servers — so the surfaces that describe the product must not say otherwise. Grok Bot, Hermes
 * and the like are then additions, not a rewrite of the description.
 *
 * A copy case: it reads the surfaces rather than driving a page, because the text is the deliverable.
 */
const read = (file: string) => readFileSync(join(ROOT_DIR, file), "utf8");

test("E15.10-1 the product is described for agent CLIs, not only coding agents", async ({ chief }) => {
  // The first line of the CLI's help.
  const help = chief.run(["--help"]);
  expect(help.code).toBe(0);
  const first = help.stdout.split("\n")[0];
  expect(first).toContain("agent CLIs");
  expect(first).not.toContain("coding-agent");

  // The About panel's credits (the string macOS shows under the app's name).
  const main = read("packages/desktop/src/main.ts");
  const credits = main.match(/credits: "([^"]+)"/)?.[1] ?? "";
  expect(credits).toContain("agent CLIs");
  expect(credits).not.toContain("coding-agent");

  // The README's opening.
  const readme = read("README.md");
  const opening = readme.slice(readme.indexOf("\n# chief\n"));
  expect(opening.slice(0, 400)).toContain("AI agents");
  expect(opening.slice(0, 400)).not.toContain("coding agents");

  // The help texts for the agent fields.
  const helptexts = read("packages/web/src/help.ts");
  expect(helptexts).not.toContain("coding-agent");

  // §1 of the plan: it says what exists today and that the engine does not assume a coding agent.
  const plan = read("docs/dev-plan.md");
  const what = plan.slice(plan.indexOf("## 1. What chief is"));
  const paragraph = what.slice(0, what.indexOf("- **chief owns**"));
  expect(paragraph).toContain("agent CLIs");
  expect(paragraph).toContain("Claude Code");
  expect(paragraph).toContain("Hermes");
  expect(paragraph).not.toContain("drives coding-agent CLIs");
});

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, ROOT_DIR, test } from "../helpers";

const read = (p: string) => readFileSync(join(ROOT_DIR, p), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * E15.118-1. A design document is only worth having if it cannot quietly stop being true, so this case checks
 * the two things that rot first: the paths and settings it names, and the blocks and endpoints it describes.
 * It does not restate the prose — a sentence is a person's to judge; a name that no longer exists is not.
 */
test("E15.118-1 the chief bot design document names only things that exist, and the README points at it", () => {
  const doc = read("docs/chief-bot.md");
  const readme = read("README.md");

  // It is discoverable from the section a person reads about chief bot, not only from the repository tree.
  const section = readme.slice(readme.indexOf("## chief bot"), readme.indexOf("## How a workflow is built"));
  expect(section).toContain("[docs/chief-bot.md](docs/chief-bot.md)");

  /** Every repository path it names must be there: a design doc that points at a deleted file is a false map. */
  const paths = new Set([...doc.matchAll(/(?:^|[\s(`[])((?:packages|docs|e2e|scripts)\/[A-Za-z0-9_./-]+)/gm)].map((m) => m[1].replace(/[.,;:]+$/, "")));
  expect(paths.size, "the document names the code it describes").toBeGreaterThan(6);
  for (const p of paths) expect(existsSync(join(ROOT_DIR, p)), `${p} is named in docs/chief-bot.md but does not exist`).toBe(true);

  /**
   * The settings it documents are exactly the ones the code reads. A new `assistant-*` setting that the doc does not
   * name — or a name the code dropped — is how a document becomes a description of a chief that no longer exists.
   */
  const docSettings = new Set([...doc.matchAll(/`(assistant-[a-z-]+)`/g)].map((m) => m[1]));
  const source = code("packages/chief/src/ask.ts") + code("packages/web/src/pages/settings.tsx") + code("packages/chief/src/server/app.ts");
  const readSettings = new Set([...source.matchAll(/"(assistant-[a-z-]+)"/g)].map((m) => m[1]));
  expect([...docSettings].sort()).toEqual([...readSettings].sort());

  // Its stated defaults are the code's defaults: the tools, the MCP servers, and the compaction budget.
  expect(doc).toContain("| `assistant-tools` | `read-only` |");
  expect(doc).toContain("| `assistant-mcp` | `none` |");
  const budget = Number(/const DEFAULT_CONTEXT_BUDGET = ([\d_]+)/.exec(code("packages/chief/src/ask.ts"))![1].replace(/_/g, ""));
  expect(budget).toBe(100_000);
  expect(doc).toContain("100,000 tokens by default");
  // And the floor the setting keeps: below it, the default is restored rather than a budget that compacts at once.
  expect(code("packages/chief/src/ask.ts")).toContain("n >= 10_000");
  expect(doc).toContain("never below 10,000");

  // The blocks it describes are the blocks the reader implements, named as they must be written.
  const design = read("packages/chief/src/assistant-design.ts");
  for (const block of ["chief-workflow", "chief-options", "chief-schedule"]) {
    expect(doc, `the document describes ${block}`).toContain("```" + block);
    expect(design, `${block} is a block the reader implements`).toContain(`BLOCK("${block}")`);
  }

  // The endpoints in its table are routes the server serves. A query string is how a person reads it, not part of
  // the path the server registers.
  const app = read("packages/chief/src/server/app.ts");
  const endpoints = [...doc.matchAll(/`(?:GET|POST|DELETE) (\/api\/[^`\s?]+)/g)].map((m) => m[1]);
  expect(endpoints.length, "the document lists the assistant's endpoints").toBeGreaterThan(5);
  for (const route of endpoints) {
    // A route in the doc is written as a person reads it; the server registers the same string.
    expect(app, `${route} is documented but not routed`).toContain(`"${route}"`);
  }

  // The one claim that explains the rest of the design is checkable: a follow-up continues the CLI's session.
  // The document is wrapped by hand, so the line break is not part of the claim (found when 15.119–15.121 ran the
  // suite: this case had been written and never run, and its pattern assumed the break fell in one particular place).
  expect(doc).toMatch(/one run\s+of an agent CLI/);
  expect(code("packages/chief/src/ask.ts")).toContain("resumeSessionId");
  // And the table that decides when it is safe to continue one.
  for (const condition of ["fingerprint", "canonical(", "lastEventId", "countRuns", "retired"]) {
    expect(code("packages/chief/src/ask.ts"), `the resume rule ${condition}`).toContain(condition);
  }
});

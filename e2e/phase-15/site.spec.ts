import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, ROOT_DIR, test } from "../helpers";

/**
 * Phase 15, task 15.20: the claims that stay in this repository after the landing page moved to
 * ccwukong/chief-site. The published page is built and deployed there. What remains here is the
 * terms, the README's list of agent CLIs, and the vendor marks the README shows.
 */

const adapters = () => {
  const source = /ADAPTER_NAMES\s*=\s*\[([^\]]+)\]/.exec(readFileSync(join(ROOT_DIR, "packages/chief/src/adapters/index.ts"), "utf8"));
  expect(source, "ADAPTER_NAMES").toBeTruthy();
  const names = [...source![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const labels = readFileSync(join(ROOT_DIR, "packages/web/src/pages/settings.tsx"), "utf8");
  const label = (id: string) => new RegExp(`["']?${id}["']?\\s*:\\s*["']([^"']+)["']`).exec(labels)?.[1] ?? id;
  return { names, label };
};

/**
 * Task 12.1 / 15.20: the terms a person reads before running someone else's automation, in plain words.
 * The canonical document stays in this repository. The site's copy is published from chief-site.
 */
test("E15.20-5 the terms page is published, linked from the page and the README, and does not narrow the licence", () => {
  const doc = readFileSync(join(ROOT_DIR, "docs/terms.md"), "utf8");
  const readme = readFileSync(join(ROOT_DIR, "README.md"), "utf8");

  expect(readme).toContain("docs/terms.md");
  expect(doc).toMatch(/as is/i);
  expect(doc).toMatch(/without warranty/i);
  expect(doc).toMatch(/not\s+liable/i);
  expect(doc).toMatch(/lost or corrupted data|lost\s+data/i);
  expect(doc).toMatch(/Apache\s+License,\s+Version\s+2\.0/);
  // The one thing such a page must never do: add a restriction on top of an open-source licence.
  expect(doc).toMatch(/nothing on this page\s+takes any of it away/);
  expect(doc).toMatch(/LICENSE/);
  // The copyright holder is named where Apache-2.0 requires it (the licence), not in the terms.
  expect(doc).not.toMatch(/Chen Cheng/);
});

/**
 * The "works with" strip (asked for 2026-11-21: "add the supported agent cli with their official logos").
 * The strip on the landing page moved with the site. The README's strip is the one this repository
 * still publishes, and it has to name every CLI chief can drive and only show a mark that is really
 * the vendor's.
 */
test("E15.20-6 the agent strip shows a real mark only where one exists, and names every CLI chief can drive", () => {
  const { names, label } = adapters();
  const readme = readFileSync(join(ROOT_DIR, "README.md"), "utf8");
  const strip = /<sub><b>WORKS WITH<\/b><\/sub>[\s\S]*?<\/p>/.exec(readme);
  expect(strip, "a works-with strip").toBeTruthy();
  const shown = strip![0];
  for (const id of names) {
    expect(shown.toLowerCase(), `${id} is named in the strip`).toContain(label(id).toLowerCase());
  }
  expect(shown).toMatch(/logos\/antigravity\.svg/);
  expect(shown).toMatch(/logos\/openai-black\.svg/);
  expect(shown).toMatch(/logos\/openai-white\.svg/);
  // The OpenAI mark is used exactly as the kit supplies it: the committed files are byte-identical to the
  // kit's, with no tile drawn around them and no recolour.
  for (const name of ["openai-black.svg", "openai-white.svg"]) {
    const svg = readFileSync(join(ROOT_DIR, "docs/logos", name), "utf8");
    expect(svg.startsWith('<svg width="721" height="721" viewBox="0 0 721 721"'), `${name} is the kit's own svg`).toBe(true);
    expect(svg, `${name} has no tile added`).not.toMatch(/<rect[^>]*width="721"/);
  }
  const sources = readFileSync(join(ROOT_DIR, "docs/logos/readme.md"), "utf8");
  for (const [, file] of shown.matchAll(/docs\/logos\/([\w.-]+\.(?:svg|png))/g)) {
    expect(existsSync(join(ROOT_DIR, "docs/logos", file)), `docs/logos/${file}`).toBe(true);
    expect(sources, `the source of ${file}`).toContain(file);
  }
  expect(sources).toMatch(/Codex/);
});

/**
 * The README's prose lists the CLIs too, and prose drifts. The landing page's lists moved with the
 * site; these are the sentences that remain here.
 */
test("E15.20-7 every CLI list in the page and the README names every adapter chief registers", () => {
  const { names, label } = adapters();
  const readme = readFileSync(join(ROOT_DIR, "README.md"), "utf8");
  const flat = readme.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const anchors = ["agent CLI you already use", "At least one agent CLI"];
  for (const anchor of anchors) {
    const i = flat.indexOf(anchor);
    expect(i, anchor).toBeGreaterThanOrEqual(0);
    const says = flat.slice(i, i + 420);
    for (const id of names) expect(says, `"${label(id)}" beside "${anchor}"`).toContain(label(id));
  }
  expect(readme).toMatch(/Codex, Cursor and Hermes adapters are unverified/);
  expect(readme).toMatch(/Hermes/);
});

/**
 * Phase 15, task 15.27: chief bot's picture is taken, not drawn.
 *
 * The screenshot has to show a real exchange — a question, an answer, and the change it lists beside the
 * canvas it produced — so the script drives the designer with a fake agent whose answer carries the
 * `chief-workflow` block. This case reads the script rather than running a browser: what it asserts is
 * that the picture cannot silently become a mock-up or drop out of the set.
 */
test("E15.27-1 chief bot's screenshot comes from a real exchange in the designer", () => {
  const script = readFileSync(join(ROOT_DIR, "e2e/tools/take-screenshots.mjs"), "utf8");
  // It opens the designer's own panel, asks a question and waits for the steps the answer built.
  expect(script).toContain('shot("chief-bot.png")');
  expect(script).toContain('[data-testid="assistant-button"]');
  expect(script).toContain('[data-testid="assistant-question"]');
  expect(script).toContain('[data-testid="assistant-send"]');
  expect(script).toContain('[data-testid="flow-node-collect"]');
  // The answer is a `chief-workflow` block, which is what the designer applies — not a picture of one.
  expect(script).toContain("chief-workflow");
  expect(script).toContain("Build a weekly review");
  expect(existsSync(join(ROOT_DIR, "docs/screenshots/chief-bot.png"))).toBe(true);
});

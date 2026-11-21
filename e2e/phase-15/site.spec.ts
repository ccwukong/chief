import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, ROOT_DIR, test } from "../helpers";

/**
 * Phase 15, tasks 15.20 and 15.36: the landing page.
 *
 * The page moved out of this repository on 2026-11-21 — it now lives in
 * [ccwukong/chief-site](https://github.com/ccwukong/chief-site), which builds it and deploys it to
 * Cloudflare Pages at <https://runchief.dev> on every push to its `main`. So what is left to check
 * here is the contract between the two repositories: the page is *built from* this one (its version,
 * its newest `.dmg`, its logos and screenshots), and a page that consumes this repository has to keep
 * being able to find them.
 *
 * The page's own guards — the CLI strip, the download chip's contrast, the terms, the dark default —
 * moved with it, to that repository's `test/site.test.mjs`.
 */

const read = (p: string) => readFileSync(join(ROOT_DIR, p), "utf8");

test("E15.20-1 this repository still supplies everything the landing page is built from, and says where it lives", () => {
  // The page is built from these paths (`scripts/build.mjs` in chief-site fetches them by name), so
  // renaming or deleting one breaks the site without breaking anything in this repository's suite.
  expect(existsSync(join(ROOT_DIR, "packages/desktop/package.json")), "the version the button states").toBe(true);
  expect(existsSync(join(ROOT_DIR, "packages/web/public/logo.svg")), "the logo").toBe(true);
  const logos = readdirSync(join(ROOT_DIR, "docs/logos")).filter((n) => /\.(svg|png)$/.test(n));
  expect(logos.length, "the vendor marks").toBeGreaterThanOrEqual(6);
  const shots = readdirSync(join(ROOT_DIR, "docs/screenshots")).filter((n) => n.endsWith(".png"));
  expect(shots.length, "the screenshots").toBeGreaterThanOrEqual(6);
  // Every mark has a recorded source, which is what makes it a vendor's mark rather than a scraped image.
  const sources = read("docs/logos/readme.md");
  for (const file of logos) expect(sources, `the source of ${file}`).toContain(file);

  // And the README says where the page now is, so a person looking for it is not sent to a dead URL.
  const readme = read("README.md");
  expect(readme).toContain("https://runchief.dev");
  expect(readme).not.toContain("ccwukong.github.io/chief");
});

test("E15.36-1 the page lives in its own repository, deployed to Cloudflare Pages, and nothing here builds it", () => {
  // One home for the page. A second copy here is what drifts: it was deployed from this repository
  // until 2026-11-21, and two published copies of the same page disagree the first time only one is
  // edited.
  expect(existsSync(join(ROOT_DIR, "site")), "no site/ folder in this repository").toBe(false);
  expect(existsSync(join(ROOT_DIR, "scripts/build-site.mjs")), "no site builder here").toBe(false);
  expect(existsSync(join(ROOT_DIR, ".github/workflows/pages.yml")), "no Pages workflow here").toBe(false);

  // The scripts that built and previewed it are gone from package.json too, so `npm run site` cannot
  // fail mysteriously.
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  expect(Object.keys(pkg.scripts).filter((k) => k.startsWith("site"))).toEqual([]);

  // Nothing in the suite still reads the removed folder, which would fail as a missing file at run
  // time rather than at review. (Mentioning `pages.yml` to assert it is *gone* is fine and is what the
  // case above does; reading from `site/` or invoking the old builder is not.)
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== ".tmp") walk(p); continue; }
      if (!p.endsWith(".spec.ts")) continue;
      // This file names the removed paths in order to assert they are gone; it is not a consumer.
      if (p.endsWith(join("phase-15", "site.spec.ts"))) continue;
      const text = readFileSync(p, "utf8");
      if (/readFileSync\(\s*join\(ROOT_DIR,\s*["'`]site\/|["'`]scripts\/build-site\.mjs["'`]|execFileSync\([^)]*build-site/.test(text)) {
        offenders.push(p.slice(ROOT_DIR.length + 1));
      }
    }
  };
  walk(join(ROOT_DIR, "e2e"));
  expect(offenders, "cases that still read the removed site").toEqual([]);

  // The documentation names the new home, so the move is discoverable from the repository itself.
  const plan = read("docs/dev-plan.md");
  expect(plan).toContain("ccwukong/chief-site");
  expect(plan).toContain("runchief.dev");
});

/**
 * Task 15.27: chief bot's picture is a real exchange, not a mock-up. The screenshot tooling stays in
 * this repository (the pictures are shown by the README and consumed by the page), so this is checked
 * here even though the page itself moved.
 */
test("E15.27-1 chief bot's screenshot comes from a real exchange in the designer", () => {
  const script = read("e2e/tools/take-screenshots.mjs");
  // It opens the designer's own panel, asks a question and waits for the steps the answer built.
  expect(script).toContain('shot("chief-bot.png")');
  expect(script).toContain('[data-testid="nav-assistant"]');
  expect(script).toContain('[data-testid="assistant-question"]');
  expect(script).toContain('[data-testid="assistant-send"]');
  expect(script).toContain('[data-testid="flow-node-collect"]');
  // The answer is a `chief-workflow` block, which is what the designer applies — not a picture of one.
  expect(script).toContain("chief-workflow");
  expect(script).toContain("Build a weekly review");
  // And the file it writes is the one the README shows (E15.19-1) and the page publishes.
  expect(existsSync(join(ROOT_DIR, "docs/screenshots/chief-bot.png"))).toBe(true);
});

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { expect, ROOT_DIR, test } from "../helpers";

/**
 * Phase 15, task 15.20: the landing page and the public site. A page that promises a download has to
 * point at something that exists, and a page that claims "local, no telemetry" has to be true of the
 * page as well as of the app — so this case checks the assembled site, not the source HTML.
 *
 * `node scripts/build-site.mjs` is what Pages publishes, so building it here is the same thing CI does.
 */
// Each build gets its own folder: two cases can run at the same time (they are separate tests, and a
// worker each), and one must not publish over the other's `site/dist` while it is being read.
const build = (env = {}) => {
  const out = mkdtempSync(join(tmpdir(), "chief-site-"));
  execSync("node scripts/build-site.mjs", { cwd: ROOT_DIR, stdio: "pipe", env: { ...process.env, CHIEF_SITE_OUT: out, ...env } });
  return out;
};

test("E15.20-1 the landing page is self-contained, links a real download, and says what chief is", () => {
  const out = build();
  const html = readFileSync(join(out, "index.html"), "utf8");
  const version = JSON.parse(readFileSync(join(ROOT_DIR, "packages/desktop/package.json"), "utf8")).version;

  // The version and the size in the page come from the build, never from the source (which has {{…}}).
  expect(html).not.toMatch(/\{\{/);
  expect(html).toContain(`v${version}`);
  // The size is a figure, not the placeholder: the build reads it from the built .dmg, or from the
  // release asset the page links to (`CHIEF_DMG_SIZE`), or falls back to an approximation.
  const size = /id="dmg-size">([^<]+)</.exec(html)?.[1] ?? "";
  expect(size).toMatch(/^~?\d+ MB$/);

  // The download, and the repository, both public URLs. With no CHIEF_DMG_URL a local build links to the
  // releases page: there is no stable asset URL to name, because the asset is versioned (E15.26-2/E15.26-3).
  const downloads = [...html.matchAll(/href="(https:\/\/github\.com\/ccwukong\/chief\/releases[^"]*)"/g)].map((m) => m[1]);
  expect(downloads).toContain("https://github.com/ccwukong/chief/releases");
  expect(html).toContain('href="https://github.com/ccwukong/chief"');
  // Every download link is on the releases page or is a release asset under it, which is where the
  // workflow publishes the versioned file (E15.26-2).
  expect(downloads.every((u) => u === "https://github.com/ccwukong/chief/releases" || u.startsWith("https://github.com/ccwukong/chief/releases/"))).toBe(true);
  // The page never names `arm64` or `-latest` in a download: the asset says the Mac in words.
  expect(html).not.toMatch(/arm64\.dmg|-latest\.dmg/);

  // The three claims the page exists to make.
  for (const claim of ["Your agent CLI", "No telemetry", "Nothing leaves the machine"]) expect(html, claim).toContain(claim);
  // And the honest part: it says plainly that the app is unsigned.
  expect(html).toContain("unsigned");
  expect(html).toContain("xattr -dr com.apple.quarantine /Applications/chief.app");

  // No third-party script, no font, no analytics: every asset is served from this folder. The two links
  // that leave are nodejs.org (a link, clicked on purpose) and GitHub's own download count as an image.
  const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
    .filter((u) => !u.startsWith("https://github.com/ccwukong/chief"));
  // And that is all. There is no live download badge any more (task 15.29): the counter is baked in from
  // the committed ledger, because a live count drops when an old release is pruned. The web UI's own
  // address is a link to this machine, not an asset fetched from anywhere, and nodejs.org is the one
  // outward link a person clicks on purpose.
  expect(external.sort(), "no third-party asset").toEqual([
    "http://127.0.0.1:8080",
    "https://nodejs.org",
  ]);
  expect(html).not.toContain("shields.io");
  expect(html).not.toMatch(/<img[^>]+src="https?:/);
  // Nothing is fetched as a script from anywhere, and no font is pulled in either.
  expect(html).not.toMatch(/<script[^>]+src=/);
  expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);

  // Everything the page displays is in the folder, so the site works as a static upload.
  for (const m of html.matchAll(/(?:src|href)="((?!#|https?:)[^"]+)"/g)) {
    const file = join(out, m[1]);
    expect(existsSync(file), `${m[1]} exists`).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(0);
  }
  // Every screenshot the README shows is on the page too: one source of truth for the pictures.
  const readme = readFileSync(join(ROOT_DIR, "README.md"), "utf8");
  const shots = [...new Set([...readme.matchAll(/docs\/screenshots\/([a-z-]+\.png)/g)].map((m) => m[1]))];
  expect(shots.length).toBeGreaterThanOrEqual(5);
  for (const shot of shots) {
    expect(existsSync(join(out, "assets/screenshots", shot)), shot).toBe(true);
    expect(html, `${shot} is shown`).toContain(`assets/screenshots/${shot}`);
  }
  // chief bot is one of the features the page leads with: a section of its own named for it, above the
  // feature grid, with its own picture — and the same picture is in the README, so the two agree.
  expect(html).toContain('id="bot"');
  expect(html).toContain("chief bot");
  expect(html).toContain("assets/screenshots/chief-bot.png");
  expect(readme).toContain("docs/screenshots/chief-bot.png");
  // Both ways to run chief are on the page, in a section of their own: the app, and `chief serve` in a
  // browser. It comes before the features, so a person who wants the browser finds it.
  expect(html).toContain('id="modes"');
  expect(html).toContain('data-testid="mode-desktop"');
  expect(html).toContain('data-testid="mode-web"');
  expect(html).toContain("npm run chief serve");
  expect(html).toContain("127.0.0.1:8080");
  // The hero offers it beside Download, so nobody has to scroll to find the browser path.
  expect(html).toContain('href="#modes"');
  expect(html.indexOf('href="#modes"')).toBeLessThan(html.indexOf('id="modes"'));
  // Which Mac the download is for is said in words, and the file name says it too: `apple-silicon`, never
  // the machine's `arm64` (task 15.28).
  expect(html).toContain(`chief-${version}-apple-silicon.dmg`);
  expect(html).not.toContain("arm64");
  expect(html).not.toContain("latest.dmg");
  // Pages needs these two, and a static host needs the page at the root.
  expect(existsSync(join(out, ".nojekyll"))).toBe(true);
  expect(existsSync(join(out, "404.html"))).toBe(true);
  expect(readdirSync(out)).toContain("index.html");
});

test("E15.20-2 the site is published from its own workflow, and not by publishing the repository root", () => {
  const wf = parse(readFileSync(join(ROOT_DIR, ".github/workflows/pages.yml"), "utf8")) as {
    on: any; permissions: Record<string, string>; concurrency: any; jobs: Record<string, { steps: any[] }>;
  };
  expect(wf.on.push.branches).toContain("main");
  // It republishes when the page, the pictures it shows, the logo or the builder change — and not on an
  // ordinary source commit, which would be a deploy per push for no change on the site.
  for (const path of ["site/**", "docs/screenshots/**", "packages/web/public/logo.svg", "scripts/build-site.mjs"]) {
    expect(wf.on.push.paths, path).toContain(path);
  }
  expect(wf.permissions.pages).toBe("write");
  expect(wf.permissions["id-token"]).toBe("write");
  expect(wf.permissions.contents).toBe("read");

  const runs = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => String(s.run ?? s.uses ?? "")));
  expect(runs.some((r) => r.includes("scripts/build-site.mjs"))).toBe(true);
  expect(runs).toContain("actions/upload-pages-artifact@v3");
  expect(runs).toContain("actions/deploy-pages@v4");
  // Only the assembled folder is uploaded: `path: .` would publish every plan and every source file.
  const upload = Object.values(wf.jobs).flatMap((j) => j.steps).find((s) => String(s.uses ?? "").includes("upload-pages-artifact"));
  expect(upload!.with.path).toBe("site/dist");
  // Pages has to be switched on by a person, and until it is, the job says so and passes rather than
  // failing on every push (the build still runs, so a broken page is still caught).
  const gate = Object.values(wf.jobs).flatMap((j) => j.steps).find((s) => String(s.id ?? "") === "pages");
  expect(gate, "a Pages-enabled check").toBeTruthy();
  expect(String(gate!.run)).toContain("/pages");
  expect(String(upload!.if)).toContain("ready");
  const deploy = Object.entries(wf.jobs).find(([name]) => name === "deploy")?.[1];
  expect(String(deploy!.if)).toContain("needs.build.outputs.ready");
  // A release republishes the page, and it has to be `workflow_run`: the release the `desktop` workflow
  // publishes is raised by its own `GITHUB_TOKEN`, and GitHub does not start a workflow from an event its
  // own token created (the loop guard), so `release: published` alone never fires for it. A workflow
  // finishing is a workflow event, not a repository event, and is not suppressed (task 15.20).
  expect(wf.on.workflow_run?.workflows, "chained from the desktop workflow").toContain("desktop");
  expect(wf.on.workflow_run.types).toEqual(["completed"]);
  // The hand-run and daily paths stay, so the page can still be published when nothing else fires.
  expect(wf.on).toHaveProperty("workflow_dispatch");
  expect(wf.on.schedule).toBeTruthy();
});

test("E15.20-3 the page links the versioned download it is given, and still builds without one", () => {
  const version = JSON.parse(readFileSync(join(ROOT_DIR, "packages/desktop/package.json"), "utf8")).version;
  const url = `https://github.com/ccwukong/chief/releases/download/v${version}/chief-${version}-apple-silicon.dmg`;
  const out = build({ CHIEF_DMG_URL: url, CHIEF_DMG_SIZE: "131 MB" });

  const html = readFileSync(join(out, "index.html"), "utf8");
  // The hero and the desktop mode both link the exact versioned asset, and the size is the measured one.
  expect(html.split(url).length - 1, "the hero and the desktop mode both link it").toBe(2);
  expect(html).toContain('id="dmg-size">131 MB');
  expect(html).toContain(`v${version}`);
  // Where the page names the file it is downloading, it is the real name: Apple silicon in words, never
  // the machine's `arm64` (task 15.28).
  expect(html).toContain(`chief-${version}-apple-silicon.dmg`);
  expect(html).not.toContain("arm64");
  expect(html).not.toMatch(/\{\{/);
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
  const rules = readFileSync(join(ROOT_DIR, "e2e/tools/take-screenshots.mjs"), "utf8");
  // It opens the designer's own panel, asks a question and waits for the steps the answer built.
  expect(script).toContain('shot("chief-bot.png")');
  expect(script).toContain('[data-testid="assistant-button"]');
  expect(script).toContain('[data-testid="assistant-question"]');
  expect(script).toContain('[data-testid="assistant-send"]');
  expect(script).toContain('[data-testid="flow-node-collect"]');
  // The answer is a `chief-workflow` block, which is what the designer applies — not a picture of one.
  expect(rules).toContain("chief-workflow");
  expect(rules).toContain("Build a weekly review");
  // And the file it writes is the one the page and the README show (E15.19-1, E15.20-1).
  expect(existsSync(join(ROOT_DIR, "docs/screenshots/chief-bot.png"))).toBe(true);
});

/**
 * The landing page's own layout and contrast, as a reader meets them (reported 2026-11-21): the nav links
 * and the Download pill did not share a centre line, the download button's "Apple silicon · v…" chip was
 * mint on mint in the dark theme (1.1:1 — *"barely visible"*), and the quarantine step gave a command
 * without saying what warning it was for.
 */
test("E15.20-4 the nav is centred on one line, the download chip is readable in both themes, and the quarantine step says what the warning is", async ({ page }) => {
  const out = build();
  // The built page with its stylesheet, from the file system: no network, no server.
  await page.goto(`file://${join(out, "index.html")}`);

  // One axis: the links, the pill and the theme button all share a vertical centre, within a pixel.
  const mid = async (sel: string) => {
    const b = (await page.locator(sel).first().boundingBox())!;
    return b.y + b.height / 2;
  };
  const [link, cta, theme] = [await mid(".nav-links a"), await mid(".nav-cta"), await mid(".theme")];
  expect(Math.abs(link - cta), "the links and the Download pill").toBeLessThan(1.5);
  expect(Math.abs(cta - theme), "the Download pill and the theme button").toBeLessThan(1.5);

  // The chip is text on the filled button in both themes; it was mint on a lightened mint in the dark.
  const chipContrast = async () => page.evaluate(() => {
    const el = document.querySelector(".btn-primary .chip")!;
    const rgbOf = (css: string) => {
      const c = document.createElement("canvas"); c.width = 1; c.height = 1;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    };
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    // The chip's own plate is translucent: its colour over the button is what a reader sees.
    const base = getComputedStyle(el.parentElement!).backgroundColor;
    const plate = getComputedStyle(el).backgroundColor;
    const ctx = document.createElement("canvas"); ctx.width = 1; ctx.height = 1;
    const c = ctx.getContext("2d")!;
    c.fillStyle = base; c.fillRect(0, 0, 1, 1);
    c.fillStyle = plate; c.fillRect(0, 0, 1, 1);
    const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
    const [a, bb] = [lum(rgbOf(getComputedStyle(el).color)), lum({ r, g, b })].sort((x, y) => y - x);
    return +((a + 0.05) / (bb + 0.05)).toFixed(2);
  });
  expect(await chipContrast(), "the chip in the light theme").toBeGreaterThan(4.5);
  await page.locator("#theme").click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  expect(await chipContrast(), "the chip in the dark theme").toBeGreaterThan(4.5);

  // The step names the dialog and the button, so a person who has just seen it knows which one it is.
  const step = page.locator('[data-testid="mode-desktop"] ol li').last();
  await expect(step).toContainText("cannot be opened because the developer cannot be verified");
  await expect(step).toContainText("Move to Bin");
  await expect(step).toContainText("xattr -dr com.apple.quarantine");
});

/**
 * Task 12.1 / 15.20: the terms a person reads before running someone else's automation, in plain words
 * (asked for 2026-11-21, after `ttps://orca.dev/terms` as the shape of the thing). One canonical document
 * in the repository; the site's page must say the same, because a person reading either one is deciding
 * whether to trust the thing.
 */
test("E15.20-5 the terms page is published, linked from the page and the README, and does not narrow the licence", () => {
  const out = build();
  const terms = readFileSync(join(out, "terms.html"), "utf8");
  const html = readFileSync(join(out, "index.html"), "utf8");
  const doc = readFileSync(join(ROOT_DIR, "docs/terms.md"), "utf8");

  // Linked from the front page's footer, and shipped: a terms page nobody can reach is a decoration.
  expect(html).toMatch(/href="terms\.html"[^>]*>Terms</);
  // The claims a person needs, in words they can read: no warranty, no liability for loss, and the licence
  // underneath it all. Both copies, so the site cannot drift from the repository. Whitespace in the patterns
  // is loose because both files are hard-wrapped prose.
  for (const text of [terms, doc]) {
    expect(text).toMatch(/as is/i);
    expect(text).toMatch(/without warranty/i);
    expect(text).toMatch(/not\s+liable/i);
    expect(text).toMatch(/lost or corrupted data|lost\s+data/i);
    expect(text).toMatch(/Apache\s+License,\s+Version\s+2\.0/);
  }
  // The one thing such a page must never do: add a restriction on top of an open-source licence. Both say
  // the licence wins and point at it.
  expect(terms).toMatch(/nothing on this page\s+takes any of it away/);
  expect(doc).toMatch(/nothing on this page\s+takes any of it away/);
  expect(terms).toMatch(/LICENSE/);
  // The copyright holder is named where Apache-2.0 requires it (the licence), and nowhere on the site is a
  // personal name presented as the terms' authority.
  expect(terms).not.toMatch(/Chen Cheng/);
});

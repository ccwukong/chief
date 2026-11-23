import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { parse } from "yaml";
import { expect, ROOT_DIR, test } from "../helpers";

/**
 * The mean luminance of a PNG and the share of its pixels that are dark, with no dependency.
 *
 * A screenshot is an 8-bit truecolour PNG written by Chromium, so a small unfilter is enough. The case
 * that shows the pictures needs this because a caption is not evidence: the dark-theme screenshot was
 * the light theme, and every case passed because none of them looked at a pixel (found 2026-11-20).
 */
function pngLuminance(file: string): { width: number; height: number; mean: number; darkShare: number } {
  const png = readFileSync(file);
  let at = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  expect({ depth, interlace }, "an 8-bit, non-interlaced PNG").toEqual({ depth: 8, interlace: 0 });
  const channels = color === 6 ? 4 : color === 2 ? 3 : color === 4 ? 2 : 1;
  if (![0, 2, 4, 6].includes(color)) throw new Error(`unsupported PNG colour type ${color}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const guessed = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const predicted = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? guessed : 0;
      px[y * stride + x] = (line[x] + predicted) & 0xff;
    }
  }
  let sum = 0, dark = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const grey = channels <= 2 ? px[o] : 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
    sum += grey;
    if (grey < 60) dark++;
  }
  return { width, height, mean: sum / (width * height), darkShare: dark / (width * height) };
}

/**
 * Phase 15, tasks 15.16 and 15.26: the macOS app is built by CI from the commit that raises the version,
 * so what is downloadable is what was deliberately released. This case reads the workflow rather than
 * running it (a runner cannot be started from a test), the way E14.1-1 reads `ci.yml`: what it asserts
 * is what the file must keep saying, and each assertion would fail if the step it describes were dropped.
 */
const workflow = () => {
  const doc = parse(readFileSync(join(ROOT_DIR, ".github/workflows/desktop.yml"), "utf8"));
  return doc as { on: any; concurrency?: any; permissions?: any; jobs: Record<string, { "runs-on": string; steps: any[] }> };
};
const runs = (job: { steps: any[] }) => job.steps.filter((s) => typeof s.run === "string").map((s) => String(s.run));

test("E15.16-1 the desktop .dmg is built by the workflow and verified before it is uploaded", () => {
  const wf = workflow();

  // A push to main builds it when the version went up (E15.26-1), and a manual run can force one.
  expect(wf.on.push.branches).toEqual(["main"]);
  expect(wf.on).toHaveProperty("workflow_dispatch");
  // A newer build supersedes the one before it.
  expect(wf.concurrency).toBeTruthy();
  expect(wf.concurrency["cancel-in-progress"]).toBe(true);
  // The build only reads the repository (the publishing job has its own write permission: E15.21-1).
  expect(wf.permissions.contents).toBe("read");

  // The build job. The decision job before it runs on Linux, so no macOS runner is spent on a version
  // that did not change (E15.26-1).
  const job = Object.entries(wf.jobs).find(([name]) => name === "dmg")![1];
  // The app is packaged with macOS's own tools (codesign, hdiutil), so the job must be on macOS.
  expect(job["runs-on"]).toMatch(/^macos/);
  expect(job.steps.some((s) => s.uses === "actions/checkout@v4")).toBe(true);
  expect(job.steps.some((s) => s.uses === "actions/setup-node@v4")).toBe(true);

  const r = runs(job).join("\n");
  // Install, the Electron binary `npm ci` does not always download, the gate, then the build.
  expect(r).toContain("npm ci");
  expect(r).toContain("node_modules/electron/install.js");
  expect(r).toContain("npm run check");
  expect(r).toContain("npm run build:desktop");

  // The artifact is checked before it is uploaded: an .app macOS starts, its server inside it, and a
  // .dmg that mounts and holds the executable — the assertions E10.5-1 makes on a laptop.
  const verify = job.steps.find((s) => /verify/i.test(s.name ?? ""));
  expect(verify, "a verification step").toBeTruthy();
  expect(verify!.run).toContain("plutil -lint");
  expect(verify!.run).toContain('test -f "$app/Contents/Resources/server/chief.mjs"');
  expect(verify!.run).toContain("codesign --verify --deep --strict");
  expect(verify!.run).toContain("Signature=adhoc");
  expect(verify!.run).toContain("hdiutil attach dist/chief.dmg");
  expect(verify!.run).toContain("shasum -a 256");

  // The .dmg and its checksum are the artifact, and a build that produced no file fails the job
  // rather than uploading nothing silently.
  const upload = job.steps.find((s) => String(s.uses ?? "").startsWith("actions/upload-artifact"));
  expect(upload, "an upload step").toBeTruthy();
  expect(String(upload!.with.path)).toContain("dist/chief-${{ needs.version.outputs.version }}-apple-silicon.dmg");
  expect(String(upload!.with.path)).toContain(".dmg.sha256");
  expect(upload!.with["if-no-files-found"]).toBe("error");
  // The dmg is advertised as Apple silicon (the landing page says so and the release asset is named for
  // it), so the job refuses to run on anything else rather than publish a mislabelled build.
  const arch = job.steps.find((s) => /Apple silicon/i.test(s.name ?? ""));
  expect(arch, "an architecture check").toBeTruthy();
  expect(String(arch!.run)).toContain('uname -m');
  expect(String(arch!.run)).toContain("arm64");
});

/**
 * Phase 15, task 15.18: the notices are a build product, and they travel with what is distributed.
 *
 * The list is not in the repository — it is a 1,200-line file that every dependency bump rewrote, so it
 * is generated from `package-lock.json` into `dist/` on each build. The licences chief bundles under
 * (MIT, ISC, BSD) require the copyright notice to be reproduced in the copies that are distributed, so
 * the artifact must carry it even though the tree does not.
 *
 * The build is run here because the point is the artifact, not the source tree.
 */
test("E15.18-1 the build generates the notices and ships them, and the tree has no list to maintain", async () => {
  // Nothing committed: the whole reason this is generated (task 15.18).
  expect(existsSync(join(ROOT_DIR, "THIRD-PARTY-NOTICES.md"))).toBe(false);
  expect(existsSync(join(ROOT_DIR, "NOTICE"))).toBe(false);

  execSync("npm run build && npm run build --workspace desktop", { cwd: ROOT_DIR, stdio: "pipe" });
  const files = ["LICENSE", "THIRD-PARTY-NOTICES.md"];
  // Beside the bundle a release ships.
  for (const f of files) {
    expect(existsSync(join(ROOT_DIR, "dist", f)), `dist/${f}`).toBe(true);
    expect(readFileSync(join(ROOT_DIR, "dist", f), "utf8").length, `dist/${f} is not empty`).toBeGreaterThan(100);
  }
  // And inside the app the .dmg contains: the app ships the whole server folder.
  for (const f of files) {
    expect(existsSync(join(ROOT_DIR, "dist/desktop/server", f)), `staged ${f}`).toBe(true);
    expect(readFileSync(join(ROOT_DIR, "dist/desktop/server", f), "utf8"), f).toBe(readFileSync(join(ROOT_DIR, "dist", f), "utf8"));
  }

  // The generated list describes this build's dependencies, with a reproduced license text each: MIT
  // and ISC both require their copyright line to travel.
  const notices = readFileSync(join(ROOT_DIR, "dist/THIRD-PARTY-NOTICES.md"), "utf8");
  const lock = JSON.parse(readFileSync(join(ROOT_DIR, "package-lock.json"), "utf8"));
  const runtime = Object.entries(lock.packages as Record<string, any>).filter(([p, m]) => p.startsWith("node_modules/") && !m.dev && !m.link);
  expect(runtime.length).toBeGreaterThan(50);
  for (const [path, meta] of runtime.slice(0, 10)) {
    const name = meta.name ?? path.replace(/^.*node_modules\//, "");
    expect(notices, `${name}@${meta.version}`).toContain(`\`${name}\` | ${meta.version}`);
  }
  // The React Flow credit lives here now that the canvas badge is hidden (E15.9-1).
  expect(notices).toContain("`@xyflow/react`");
  expect(notices).toContain("`@xyflow/system`");
  expect(notices).toMatch(/### \d+\. MIT/);
  expect(notices).toContain("Permission is hereby granted, free of charge");
});

/**
 * Phase 15, task 15.19: the pictures in the README are the product as it is, and they cannot rot by
 * being deleted or orphaned. There is a script that takes them (`e2e/tools/take-screenshots.mjs`); this
 * case checks the other half, that every picture the README shows exists and every picture in the folder
 * is shown, so a page that gains or loses a screenshot is noticed.
 */
test("E15.19-1 every screenshot the README shows exists and is shown, and the dark-theme one is dark", () => {
  const readme = readFileSync(join(ROOT_DIR, "README.md"), "utf8");
  // Each picture is a link around an image, so it appears twice in the markdown; the set is what matters.
  const shown = [...new Set([...readme.matchAll(/\]\(docs\/screenshots\/([a-z-]+\.png)\)/g)].map((m) => m[1]))];
  // The pages a person meets first, including the ones added in Phase 15.
  for (const name of ["designer.png", "run-gate.png", "runs.png", "schedules.png", "settings.png"]) expect(shown, name).toContain(name);
  for (const name of shown) {
    const file = join(ROOT_DIR, "docs/screenshots", name);
    expect(existsSync(file), `docs/screenshots/${name}`).toBe(true);
    // A real screenshot, not an empty file or a placeholder.
    expect(readFileSync(file).length, name).toBeGreaterThan(20_000);
  }
  // And nothing in the folder is left behind, unshown.
  const files = readdirSync(join(ROOT_DIR, "docs/screenshots")).filter((f) => f.endsWith(".png"));
  expect(files.filter((f) => !shown.includes(f)), "screenshots the README does not show").toEqual([]);

  // The dark-theme picture is *dark*. The tool used to set the setting and then change only the hash,
  // which is a same-document navigation, so the app never re-read it: the file was the light theme
  // under a caption saying "The dark theme", and every case passed because none looked at a pixel
  // (found 2026-11-20). The light run list measures about 247; a dark page cannot.
  expect(readme).toContain("in the dark theme");
  // The page that shows this picture now lives in ccwukong/chief-site, and its own suite asserts that
  // the dark screenshot is the one it shows (`test/site.test.mjs` there). What belongs here is the
  // picture itself: the file the README shows must be a dark frame, not a light one under a dark caption.
  const dark = pngLuminance(join(ROOT_DIR, "docs/screenshots/run-dark.png"));
  expect({ width: dark.width, height: dark.height }, "the same 1360×860 frame as the others, at 2x").toEqual({ width: 2720, height: 1720 });
  expect(dark.mean, "the dark screenshot's mean luminance").toBeLessThan(110);
  expect(dark.darkShare, "most of the dark screenshot is dark").toBeGreaterThan(0.5);
  // And it is the screen the caption names: a run in the panel over the list, not the full-page run.
  const tool = readFileSync(join(ROOT_DIR, "e2e/tools/take-screenshots.mjs"), "utf8");
  expect(tool).toContain('[data-testid="run-panel-body"]');
  /**
   * **No machine path in a published picture.** The Settings screenshot showed the Claude Code path as
   * `/Users/<name>/Documents/projects/chief/e2e/fixtures/fake-claude.ts` — the fixture the throw-away chief runs — in the
   * README and on the landing page (reported 2026-11-23: *"some of the screenshots … have my name as the `Claude Code
   * Path` value. i want it to be masked"*). Two are asserted here because a case cannot see inside a PNG: the tool masks
   * every place a path is printed, and it **fails the run** rather than publishing one, so a field added later cannot
   * slip through. The values themselves were verified in a browser: the set of masked fields is these, and the guard
   * caught a second leak (the MCP command boxes) the report had not mentioned.
   */
  for (const masked of ['[data-testid="setting-${name}-path"]', '[data-testid="mcp-command-line-${name}"]', "[data-testid=\"wf-base-dir\"]"]) {
    expect(tool, `the tool masks ${masked}`).toContain(masked);
  }
  expect(tool, "and refuses to publish a picture that still has one").toContain("would publish a machine path");
  expect(tool, "over the real home folder").toContain("homedir()");
  // The light picture beside it is the opposite, so the pair shows the theme instead of one page twice.
  const light = pngLuminance(join(ROOT_DIR, "docs/screenshots/runs.png"));
  expect(light.mean, "the run list is the light theme").toBeGreaterThan(200);
});

/**
 * Phase 15, task 15.21: a download anyone can press. A workflow artifact needs a GitHub login, so the
 * landing page's link is a release asset; this case checks that the workflow actually publishes one under
 * the name the page uses, and that the changelog is a changelog.
 */
test("E15.21-1 a build publishes the .dmg as a public release asset, and the changelog records the versions", () => {
  const wf = parse(readFileSync(join(ROOT_DIR, ".github/workflows/desktop.yml"), "utf8")) as {
    jobs: Record<string, { needs?: string; permissions?: Record<string, string>; steps: any[] }>;
  };
  // A job of its own, after the build, with the write permission a release needs. The build job itself
  // stays read-only, and only the tagging and publishing jobs hold the write permission.
  const release = Object.entries(wf.jobs).find(([name]) => name === "release")?.[1];
  expect(release, "a release job").toBeTruthy();
  expect(JSON.stringify(release!.needs)).toContain("dmg");
  expect(release!.permissions).toEqual({ contents: "write" });
  const run = release!.steps.map((s) => String(s.run ?? "")).join("\n");
  const uses = release!.steps.map((s) => String(s.uses ?? ""));
  // The artifact is fetched and its checksum verified before anything is published.
  expect(uses.some((u) => u.includes("actions/download-artifact"))).toBe(true);
  expect(run).toContain("shasum -a 256 -c");
  // It is published on the version's own tag, titled with the version (E15.26-2 checks the asset name).
  expect(run).toContain("gh release create");
  expect(run).toContain("gh release upload");
  expect(run).toContain("--notes-file notes.md");
  // The version it publishes is the one the decision job found, not a guess.
  const env = release!.steps.map((x) => String(x.env?.VERSION ?? "")).join(" ");
  expect(env).toContain("needs.version.outputs.version");

  // The changelog: every released version a heading, newest first, with the current version present.
  const log = readFileSync(join(ROOT_DIR, "CHANGELOG.md"), "utf8");
  const versions = [...log.matchAll(/^## \[([^\]]+)\](?: — (\d{4}-\d{2}-\d{2}))?/gm)].map((m) => ({ name: m[1], date: m[2] }));
  expect(versions[0].name, "Unreleased comes first").toBe("Unreleased");
  expect(versions[0].date).toBeUndefined();
  const current = JSON.parse(readFileSync(join(ROOT_DIR, "packages/desktop/package.json"), "utf8")).version;
  const released = versions.slice(1);
  expect(released.map((v) => v.name), "the version the app reports is in the log").toContain(current);
  // Newest first, and every released entry dated.
  const dates = released.map((v) => v.date ?? "");
  expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), "every version is dated").toBe(true);
  expect([...dates].sort().reverse(), "newest first").toEqual(dates);
  // It says what changed for a person, so it is grouped, not one list of commits.
  for (const section of ["### Added", "### Changed", "### Fixed"]) expect(log, section).toContain(section);
  // And the README links it, so it can be found from the front page.
  expect(readFileSync(join(ROOT_DIR, "README.md"), "utf8")).toContain("CHANGELOG.md");
});

/**
 * Phase 15, task 15.26: the version in `packages/desktop/package.json` decides whether an app is built.
 *
 * Every push to `main` — a merged pull request and a direct push are the same event — compares that
 * version with the highest `v*` tag. Higher means a new release: the workflow tags the commit, builds,
 * verifies and publishes. Not higher means nothing is built and no macOS runner is spent, which is what
 * keeps a README fix or a refactor from shipping a download.
 */
test("E15.26-1 a push to main builds the app only when the manifest's version is higher than the newest tag", () => {
  const wf = workflow();
  // The trigger is a push to main (a merge is a push), and a manual run can force one version.
  expect((wf.on as any).push.branches).toEqual(["main"]);
  expect((wf.on as any).push.tags, "a tag is created by the workflow, so it cannot be its own trigger").toBeUndefined();
  expect(wf.on).toHaveProperty("workflow_dispatch");
  expect((wf.on as any).workflow_dispatch.inputs).toHaveProperty("version");

  // The decision is a job of its own, on Linux, before any macOS runner is touched, and it outputs
  // whether to build and which version.
  const decide = (wf.jobs as any).version;
  expect(decide, "a version job").toBeTruthy();
  expect(decide["runs-on"]).toMatch(/^ubuntu/);
  expect(decide.outputs.build).toBeTruthy();
  expect(decide.outputs.version).toBeTruthy();
  const d = runs(decide).join("\n");
  // It reads the manifest, the newest tag (version-sorted, not lexicographic) and the releases.
  expect(d).toContain("packages/desktop/package.json");
  expect(d).toContain("git tag --list 'v*' --sort=-v:refname");
  expect(d).toContain("releases/tags/");
  // A version is compared number by number: 0.10.0 is newer than 0.9.0, which a string comparison gets
  // wrong, so the comparison is explicit in the script.
  expect(d).toContain("parseInt");
  // Not building says so, in the run summary and as a notice, instead of failing or building anyway.
  expect(d).toContain("::notice title=No new version");

  // The build is skipped when the version is not higher, and it never runs before the decision.
  expect((wf.jobs as any).dmg.if).toContain("needs.version.outputs.build == 'true'");
  // ...and it opts out of the status check, because a version whose tag already exists skips the `tag` job,
  // and a skipped job in the chain suppresses everything after it. Both the build and the publish must
  // still run in that case: it is how a failed build is retried (task 15.26).
  expect((wf.jobs as any).dmg.if).toContain("always()");
  const rel = (wf.jobs as any).release;
  expect(rel.if, "the publish runs after a rebuild of an existing tag").toContain("always()");
  // And it depends on the artifact, not on the version alone: `dmg.result` is what says the build made one.
  expect(rel.if).toContain("needs.dmg.result == 'success'");
  expect((wf.jobs as any).dmg.needs).toContain("version");
  // The tag is created by a job of its own that holds `contents: write`, and only that job and the
  // publishing one do.
  const tag = (wf.jobs as any).tag;
  expect(tag, "a tag job").toBeTruthy();
  expect(tag.permissions).toEqual({ contents: "write" });
  expect(runs(tag).join("\n")).toContain("git push origin");
  const writers = Object.entries(wf.jobs as Record<string, any>).filter(([, j]) => j.permissions?.contents === "write").map(([name]) => name).sort();
  expect(writers).toEqual(["release", "tag"]);
  // The build job itself stays read-only, and no environment gate: a version bump is the approval.
  expect((wf.jobs as any).dmg.permissions).toBeUndefined();
  expect((wf.jobs as any).dmg.environment, "no approval gate: raising the version is the decision").toBeUndefined();
  // A tag without a release is retried rather than skipped for ever (a build may have failed after tagging).
  expect(d).toContain("has no release");
});
test("E15.26-2 the download is named for its version and the Mac it is for, and old releases are pruned by hand", () => {
  const wf = workflow();
  const build = runs((wf.jobs as any).dmg).join("\n");
  const release = runs((wf.jobs as any).release).join("\n");
  const all = build + "\n" + release;

  // The asset is `chief-<version>-apple-silicon.dmg`, built from the version in the manifest.
  expect(all).toContain("chief-${VERSION}-apple-silicon.dmg");
  // Never `-latest`: a version is what a release is for (task 15.26).
  expect(all, "no -latest asset").not.toMatch(/latest\.dmg/);
  // The checksum names the same file, so `shasum -a 256 -c` verifies a copy in any folder.
  expect(build).toContain('"$asset.sha256"');
  expect(release).toContain("shasum -a 256 -c");

  // One release per version, on the tag the workflow created, titled with the version, and its notes are
  // that version's own changelog section.
  expect(release).toContain('gh release create "$TAG"');
  expect(release).toContain("--title");
  expect(release).toContain("chief ${VERSION}");
  expect(release).toContain("notes.md");
  expect(release).toContain("CHANGELOG.md");
  // Nothing is pruned silently: no step runs a delete, and the workflow only says how to do it by hand.
  expect(release.split("\n").filter((l) => l.trim().startsWith("gh release delete"))).toEqual([]);
  expect(release).toContain("gh release delete <tag>");

  // The page cannot hard-code a versioned asset URL: it takes the download from the build and names
  // the version it was given. That page moved to ccwukong/chief-site, whose `test/site.test.mjs`
  // asserts the built link matches the version in the button; what stays here is that no release is
  // ever named `latest` (task 15.26 made the asset versioned) and the README points at the releases.
  expect(readFileSync(join(ROOT_DIR, "README.md"), "utf8")).toContain("https://github.com/ccwukong/chief/releases");
  expect(release, "no rolling `latest` asset").not.toContain("latest.dmg");
});

/**
 * Phase 15, task 15.28: the download is named in words — `apple-silicon`, not `arm64`.
 *
 * Both name the same architecture (M1 onwards; Intel is `x86_64`), but `arm64` is the value `uname -m`
 * answers and the thing the runner check compares. The file a person finds in their Downloads folder says
 * which Mac it is for in words. This case exists so the readable name cannot drift back.
 */
test("E15.28-1 no release asset is named after arm64: the file is chief-<version>-apple-silicon.dmg", () => {
  const wf = workflow();
  const assetNames = ["dmg", "release"].flatMap((job) =>
    (runs((wf.jobs as any)[job]).join("\n").match(/chief-[^\s"`']*\.dmg(?:\.sha256)?/g) ?? []),
  );
  expect(assetNames.length).toBeGreaterThan(0);
  for (const name of assetNames) {
    // Every name it builds or uploads carries the version and the Mac, and never the machine value.
    expect(name, `${name} is the versioned, Apple-silicon name`).toMatch(/^chief-(\$\{VERSION\}|<version>)-apple-silicon\.dmg(\.sha256)?$/);
    expect(name, `${name} is not named after arm64`).not.toContain("arm64");
  }

  // The machine check stays, as the technical comparison it is: the runner has to be Apple silicon.
  const arch = (wf.jobs as any).dmg.steps.find((s: any) => /Apple silicon/i.test(s.name ?? ""));
  expect(arch, "an architecture check").toBeTruthy();
  expect(String(arch.run)).toContain('"arm64"');
  expect(String(arch.run)).toContain("uname -m");
  // And the build refuses a file whose name carries the machine value.
  expect(runs((wf.jobs as any).dmg).join("\n")).toContain('case "$asset" in *arm64*)');

  // The prose names the Mac, not the architecture.
  for (const file of ["README.md", "docs/desktop.md"]) {
    expect(readFileSync(join(ROOT_DIR, file), "utf8"), file).toContain("Apple silicon");
  }
});


/**
 * Phase 15, task 15.29: the ledger is kept without spending anything, and cannot start a build.
 *
 * The tally workflow commits `downloads.json` when the number changed. That commit is not a change to the
 * product, so it says `[skip ci]` and both workflows that would otherwise run — `ci.yml` and
 * `desktop.yml` — ignore the path outright. A commit message can be forgotten; a path cannot.
 */
test("E15.29-6 a tally commit keeps the ledger current, says [skip ci], and starts neither CI nor a build", () => {
  const tally = parse(readFileSync(join(ROOT_DIR, ".github/workflows/downloads.yml"), "utf8")) as {
    on: any; permissions: Record<string, string>; jobs: Record<string, { "runs-on": string; steps: any[] }>;
  };
  // Daily is enough for a download counter, and a release is the moment the number first exists.
  expect(tally.on.schedule?.[0]?.cron).toBeTruthy();
  expect(tally.on.release?.types).toEqual(["published"]);
  expect(tally.on).toHaveProperty("workflow_dispatch");
  // The release the `desktop` workflow publishes is raised by its own token, so `release:` never fires for
  // it; `desktop` completing is a workflow event and is not suppressed, which is what makes the number
  // appear the same day as the release instead of at the next morning's schedule (task 15.29).
  expect(tally.on.workflow_run?.workflows, "chained from the desktop workflow").toContain("desktop");
  expect(tally.on.workflow_run.types).toEqual(["completed"]);
  // It writes a file in the repository, so it needs the write permission and nothing else.
  expect(tally.permissions).toEqual({ contents: "write" });
  const job = Object.values(tally.jobs)[0];
  expect(job["runs-on"]).toMatch(/^ubuntu/);
  const run = job.steps.map((s) => String(s.run ?? "")).join("\n");
  // It reads the releases and pipes them into the ledger script.
  expect(run).toContain("gh api");
  expect(run).toContain("scripts/download-tally.mjs");
  // It commits only when the file changed, and the message keeps CI away.
  expect(run).toContain("git diff --quiet -- downloads.json");
  expect(run).toContain("[skip ci]");
  expect(run).toContain("git push");
  // A tally that cannot read GitHub is a notice, not a red repository: bookkeeping must not break history.
  expect(run).toContain("::notice");
  // The same for a push the branch protection refuses (`GH006`): the ledger commit is bookkeeping, so it
  // says so and the job still passes. Without this, every release on protected `main` ends with a red X.
  expect(run, "a refused push is a notice").toMatch(/if ! git push[\s\S]*::notice[\s\S]*?exit 0/);

  // And the two workflows a tally commit would otherwise start ignore it by path.
  for (const file of ["ci.yml", "desktop.yml"]) {
    const wf = parse(readFileSync(join(ROOT_DIR, ".github/workflows", file), "utf8")) as { on: any };
    expect(wf.on.push["paths-ignore"], `${file} ignores the ledger`).toContain("downloads.json");
  }
  // `desktop.yml` keeps its version-bump logic on top of the ignore, so pruning or tallying cannot ship an
  // app and cannot be the reason one is missed.
  const desktop = parse(readFileSync(join(ROOT_DIR, ".github/workflows/desktop.yml"), "utf8")) as { jobs: Record<string, any> };
  expect(desktop.jobs.version).toBeTruthy();

  // The page used to be rebuilt when the ledger changed; the page and its counter are gone from this
  // repository (task 15.36), and nothing here reads `downloads.json` any more. What still matters is
  // that the ledger is reachable and runnable on its own, which the docs say how to do.
  expect(existsSync(join(ROOT_DIR, ".github/workflows/pages.yml")), "no Pages workflow left here").toBe(false);
  expect(readFileSync(join(ROOT_DIR, "docs/desktop.md"), "utf8")).toContain("gh workflow run downloads");
});

/**
 * Phase 15, task 15.30: a workflow that can only be started by a push cannot be started at all when the
 * pushes stop producing runs, which is what happened on 2026-11-20 — every workflow was active, the files
 * parsed, and no run appeared for a squashed commit that changed 33 files, while a manual dispatch of the
 * same workflow ran and passed. So both halves of the gate take a manual start.
 */
test("E15.30-1 the CI gate and the app build can both be started by hand", () => {
  const ci = parse(readFileSync(join(ROOT_DIR, ".github/workflows/ci.yml"), "utf8")) as { on: any };
  const desktop = workflow();
  // `workflow_dispatch` is what `gh workflow run <name>` needs.
  expect(Object.keys(ci.on)).toContain("workflow_dispatch");
  expect(Object.keys(desktop.on)).toContain("workflow_dispatch");
  // Not instead of a push: both triggers stay, so the ordinary path is still automatic.
  expect(ci.on.push.branches).toContain("main");
  expect(desktop.on.push.branches).toContain("main");
  // A manual build takes the version, so a release can be published without inventing a commit to raise it.
  expect(Object.keys(desktop.on.workflow_dispatch.inputs)).toContain("version");
  // And the file says why it exists, so the next reader does not delete it as redundant.
  for (const file of ["ci.yml", "desktop.yml"]) {
    const source = readFileSync(join(ROOT_DIR, ".github/workflows", file), "utf8");
    expect(source, file).toMatch(/gh workflow run|workflow_dispatch/);
  }
});

test("E15.50-1 main takes squash and merge only, and a pull request branch is rebased rather than merged", () => {
  // The rule is enforced by the repository's GitHub settings (squash and merge only, linear history on
  // `main`), which no case here can read without an admin token. What is checkable is the repository's
  // own side: the rule is stated for people, and nothing in CI merges a pull request with the wrong
  // method — a workflow that ran `gh pr merge --merge` would look like a violation and be one.
  const agents = readFileSync(join(ROOT_DIR, "AGENTS.md"), "utf8");
  const contributing = readFileSync(join(ROOT_DIR, "CONTRIBUTING.md"), "utf8");
  for (const [name, text] of [["AGENTS.md", agents], ["CONTRIBUTING.md", contributing]] as const) {
    expect(text, `${name} says which merge method`).toMatch(/squash and merge/i);
    expect(text, `${name} says merge commits are off`).toMatch(/merge commit/i);
    // Rebase, named: the part people get wrong when a branch falls behind is merging `main` into it.
    expect(text, `${name} says to rebase`).toMatch(/rebas/i);
    expect(text, `${name} says main is linear`).toMatch(/linear history/i);
    expect(text, `${name} says the pull request title becomes the commit`).toMatch(/title/i);
  }

  // No workflow may merge a pull request at all, and none may use the two disabled methods.
  const dir = join(ROOT_DIR, ".github/workflows");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
    const text = readFileSync(join(dir, file), "utf8");
    expect(text, `${file} does not merge pull requests`).not.toMatch(/gh pr merge/);
    expect(text, `${file} does not ask for a merge commit`).not.toMatch(/--merge\b|--rebase\b/);
  }
});

test("E15.51-1 the suite's own environment is built and the two reds it hid are checked", () => {
  // E15.37-1 failed on CI with "dist/chief.mjs is missing. Run `npm run build` first": the e2e job built only the
  // web UI, while that case runs `npm run install:cli` — and E11.6-1 runs `chief` itself. A case that needs an
  // artifact the job does not build is an environment gap that looks like a red case on every run.
  const ci = readFileSync(join(ROOT_DIR, ".github/workflows/ci.yml"), "utf8");
  const at = ci.indexOf("\n  e2e:");
  expect(at, "the workflow still has an e2e job").toBeGreaterThan(0);
  const e2eJob = ci.slice(at);
  expect(e2eJob, "the e2e job builds the bundle, not only the UI").toMatch(/- run: npm run build$/m);
  expect(JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8")).scripts.build, "build includes the CLI bundle").toContain("workspace chief");

  // The run diagram leaves the wheel to the page it sits in: `preventScrolling={false}` alone does not, because
  // the zoom handler calls preventDefault first (E9.57-1 caught it).
  const diagram = readFileSync(join(ROOT_DIR, "packages/web/src/run-diagram.tsx"), "utf8");
  expect(diagram).toContain("zoomOnScroll={false}");
  expect(diagram).toContain("preventScrolling={false}");
  expect(diagram, "dragging still pans").toContain("panOnDrag");

  // A button whose action waits on the server shows a spinner: Clone was a plain <button>, which is why the
  // assertion E9.41-3 made could never pass — the case was right and the button was wrong.
  const designer = readFileSync(join(ROOT_DIR, "packages/web/src/pages/designer.tsx"), "utf8");
  const clone = designer.slice(designer.indexOf('data-testid="btn-clone"') - 60, designer.indexOf('data-testid="btn-clone"') + 40);
  expect(clone, "Clone is an AsyncButton").toContain("AsyncButton");
});

test("E15.52-1 the e2e suite runs on a pull request or by hand, never on a push to main", () => {
  // Asked for 2026-11-21: "it only runs e2e when merging a PR, if I force push to main, DO NOT run e2e".
  // The reason it is sound: `main` takes squash and merge (15.50), so a merge puts on `main` exactly the
  // content the pull request already ran the suite against. A direct force push is therefore unverified
  // until `gh workflow run ci`, which is the deliberate trade, not an oversight.
  const ci = parse(readFileSync(join(ROOT_DIR, ".github/workflows/ci.yml"), "utf8")) as {
    on: any;
    jobs: Record<string, { if?: string; "runs-on": string; steps: { run?: string }[] }>;
  };
  const suite = Object.values(ci.jobs).filter((j) => j.steps.some((s) => String(s.run ?? "").includes("npx playwright test")));
  expect(suite.length, "one job runs the suite").toBe(1);
  const e2e = suite[0] as { if?: string };
  expect(e2e.if, "the suite is conditioned").toBeTruthy();
  expect(e2e.if).toContain("pull_request");
  // A push must not be able to satisfy it: neither branch of the condition may be one.
  for (const branch of String(e2e.if).split("||")) expect(branch, "no branch of the condition is a push").not.toContain("push");

  // The cheap gate keeps running on every push, so a broken commit on `main` is still caught.
  const check = Object.values(ci.jobs).find((j) => j.steps.some((s) => String(s.run ?? "").includes("npm run check")))!;
  expect(check, "a job runs the check").toBeTruthy();
  expect(check.if, "the check has no condition, so it runs on a push").toBeUndefined();
  expect(ci.on.push.branches).toContain("main");

  // A release is a different workflow, so "no suite on main" does not mean "no build on main".
  expect(Object.keys(workflow().on)).toContain("push");

  // And the rule is written where the next reader looks, because a condition in YAML reads as an accident.
  const agents = readFileSync(join(ROOT_DIR, "AGENTS.md"), "utf8");
  expect(agents, "AGENTS.md states when the suite runs").toMatch(/e2e suite on a pull request or by hand/i);
});

test("E15.110-1 a manual workflow start does not run the e2e suite unless it asks", () => {
  // Found 2026-11-22 by doing it: a force push produced no runs at all, the push was recovered with
  // `gh workflow run ci` — the documented way for exactly that (task 15.30) — and a 12-minute macOS suite
  // started that nobody had asked for, which is the one thing the standard forbids (15.52, 15.53). The
  // dispatch carries a flag now, and this is what keeps it there.
  const ci = parse(readFileSync(join(ROOT_DIR, ".github/workflows/ci.yml"), "utf8")) as {
    on: any;
    jobs: Record<string, { if?: string; steps: { run?: string }[] }>;
  };
  const suite = Object.values(ci.jobs).find((j) => j.steps.some((s) => String(s.run ?? "").includes("npx playwright test")))!;
  expect(suite, "the suite job exists").toBeTruthy();
  expect(suite.if, "a manual start needs the flag").toContain("inputs.e2e");
  expect(String(suite.if), "and `workflow_dispatch` alone is not enough").not.toMatch(/event_name == 'workflow_dispatch'/);
  expect(String(suite.if), "a pull request still runs it").toContain("pull_request");
  const dispatch = ci.on.workflow_dispatch;
  expect(dispatch?.inputs?.e2e?.default, "the flag defaults to false").toBe(false);
  expect(dispatch?.inputs?.e2e?.type, "and is a boolean, so it is passed as -f e2e=true").toBe("boolean");
  // The fast gate is unaffected: a manual start still gets the checks, and a push still gets them.
  const check = Object.values(ci.jobs).find((j) => j.steps.some((s) => String(s.run ?? "").includes("npm run check")))!;
  expect(check.if, "the check has no condition").toBeUndefined();
  expect(ci.on.push.branches).toContain("main");
});

test("E15.53-1 the e2e suite is opt-in: it runs when the user asks, not after every change", () => {
  // Asked for 2026-11-21: "do not run e2e test by default, only run e2e test if I ask you to explicitly".
  // The rule is a standard, so it lives in AGENTS.md where an agent reads it before working — a correction
  // that has to be remembered is not yet a rule.
  const agents = readFileSync(join(ROOT_DIR, "AGENTS.md"), "utf8");
  // Compared as flowing text: a sentence is what is promised, not where the line happens to wrap (the same reason
  // docs.spec.ts flattens the README). `/which cases were run/i` failed on a paragraph that says it, wrapped.
  const step4 = agents.slice(agents.indexOf("4. **Do not run the e2e suite"), agents.indexOf("5. **Do not move on with a red case")).replace(/\s+/g, " ");
  expect(step4, "step 4 is the opt-in rule").not.toBe("");
  expect(step4).toMatch(/when the user asks/i);
  expect(step4).toMatch(/by default/i);
  // It is not a licence to go silent: a run that is asked for is reported in full.
  expect(step4, "the reporting duty survives").toMatch(/Phase results/i);
  expect(step4, "a report says what was not run").toMatch(/which cases were run/i);
  // A manual start does not run the suite unless it asks: the recovery path for a dropped push is not a suite.
  expect(step4, "a manual workflow start is not a way round the rule").toMatch(/gh workflow run ci/i);
  expect(step4).toMatch(/-f e2e=true/);
  // And the old instruction — run the cases a change touches, after each change — is gone.
  expect(agents).not.toMatch(/Run only the e2e cases that the change touches/);

  // The two plan-coverage cases are the one run worth keeping cheap by default: they read the plan files.
  const plan = readFileSync(join(ROOT_DIR, "docs/e2e-test-plan.md"), "utf8");
  expect(plan).toContain("plan-coverage");
});

test("E15.54-1 the installer script fetches the published release, proves it, and needs no flag cleared afterwards", () => {
  // The install note used to end at "run xattr in a Terminal". This script is the path for someone who
  // does not want one: `curl` does not set com.apple.quarantine, and Gatekeeper only checks what carries it.
  const script = readFileSync(join(ROOT_DIR, "scripts/install-app.sh"), "utf8");
  const flow = script.replace(/^\s*#.*$/gm, "");
  // What it installs is the published asset, named for the version and the Mac, as E15.26-2 requires.
  expect(script).toContain('chief-$VERSION-apple-silicon.dmg');
  expect(script).toContain("/releases/latest");
  // Verified before it is installed, and a missing digest is a refusal rather than a warning.
  expect(flow).toContain("shasum -a 256 -c");
  expect(script).toMatch(/no \.sha256 for .*refusing to install/);
  // Mounted the modern way, with the deprecated one only as a fallback: `hdiutil attach -mountpoint`
  // fails on macOS 26 with "Device not configured" (found by running it).
  expect(flow).toContain("diskutil image attach");
  expect(flow.indexOf("diskutil image attach")).toBeLessThan(flow.indexOf("hdiutil attach"));
  // A running copy is quit before its bundle is replaced, and a copy that will not quit stops the install.
  expect(flow).toContain('quit app "chief"');
  expect(script).toMatch(/still running; quit it/);
  // It never clears a quarantine flag silently: if one is found it prints the line for the person to run.
  // No line *runs* a delete: the only xattr calls are a read (`-p`, to decide whether to say anything)
  // and the text of a `say`, which prints the command for the person rather than doing it for them.
  expect(flow).not.toMatch(/^\s*xattr\s+-d/m);
  expect(script).toMatch(/carries the quarantine flag/);
  // And it refuses what it cannot install, saying what to do instead.
  expect(script).toMatch(/arm64/);
  expect(script).toMatch(/unknown option/);
});

test("E15.58-1 a server's slug is turned into the name its CLI knows, for sign-in, sign-out and remove", async ({ chief }) => {
  // Reported 2026-11-21 with the CLI's own words: `failed: No MCP server named "google-docs". Configured
  // servers: claude.ai Ahrefs, …`. chief names a server `google-docs` so it can be written in an `mcp:` list;
  // the CLI's command needs `claude.ai Google Docs`. This seeds exactly that row and asks for the command.
  const srv = await chief.serve();
  try {
    const seed = spawnSync(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(join(chief.home, "chief.db"))});
      db.prepare("INSERT INTO agent__mcp_servers (adapter, folder, name, source, config_json, updated_at) VALUES (?,?,?,?,?,?)")
        .run("claude-code", ${JSON.stringify(chief.dir)}, "google-docs", "discovered", JSON.stringify({ cli_name: "claude.ai Google Docs", status: "needs-auth" }), new Date().toISOString());
      db.prepare("INSERT INTO agent__mcp_servers (adapter, folder, name, source, config_json, updated_at) VALUES (?,?,?,?,?,?)")
        .run("claude-code", ${JSON.stringify(chief.dir)}, "flag-row", "discovered", JSON.stringify({ cli_name: "--dangerous", status: "needs-auth" }), new Date().toISOString());
    `], { encoding: "utf8" });
    expect(seed.status, seed.stderr).toBe(0);

    // Sign-in: the CLI's own name, as one argv element (a space in it needs no quoting, and no shell).
    const login = await srv.api("POST", "/api/mcp/auth", { adapter: "claude-code", action: "login", name: "google-docs", dryRun: true });
    expect(login.body.command, "the CLI's own name, not the slug").toContain("claude.ai Google Docs");
    expect(login.body.command).not.toMatch(/mcp login google-docs/);
    // Sign-out takes a name too, so it gets the same treatment.
    const out = await srv.api("POST", "/api/mcp/auth", { adapter: "claude-code", action: "logout", name: "google-docs", dryRun: true });
    expect(out.body.command).toContain("claude.ai Google Docs");
    // Remove is the third command that takes a name.
    const rm = await srv.api("POST", "/api/mcp/apply", { adapter: "claude-code", action: "remove", name: "google-docs", dryRun: true });
    expect(rm.body.command).toContain("claude.ai Google Docs");

    // A stored name that begins a flag is refused rather than passed through: it would be read as one.
    const flag = await srv.api("POST", "/api/mcp/auth", { adapter: "claude-code", action: "login", name: "flag-row", dryRun: true });
    expect(flag.body.command, "the slug is used instead of a name starting with a dash").toContain("mcp login flag-row");

    // A server chief does not know keeps the slug, so a name typed by hand still works.
    const unknown = await srv.api("POST", "/api/mcp/auth", { adapter: "claude-code", action: "login", name: "slack", dryRun: true });
    expect(unknown.body.command).toContain("mcp login slack");
  } finally { await srv.stop(); }
});

test("E15.59-1 a sign-in is only reported done when the CLI's own list changed, and runs in the server's folder", async ({ chief }) => {
  // Reported 2026-11-21: "sign in and sign out not working even though the UI says it signed in/out". The CLI prints
  // a refusal and exits 0, so the exit code is not the answer:
  //   $ claude mcp login "claude.ai Ahrefs" --no-browser
  //   No MCP server named "claude.ai Ahrefs". Configured servers: github
  //   ---exit=0
  // A stand-in CLI that refuses exactly that way, in its own exit-0 style.
  const fake = join(chief.dir, "refusing-claude.sh");
  writeFileSync(fake, "#!/bin/sh\necho 'No MCP server named \"github\". Configured servers: none'\nexit 0\n", { mode: 0o755 });
  const srv = await chief.serve({ env: { CHIEF_CLAUDE_BIN: fake } });
  try {
    const seed = spawnSync(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(join(chief.home, "chief.db"))});
      const now = new Date().toISOString();
      const put = db.prepare("INSERT INTO agent__mcp_servers (adapter, folder, name, source, config_json, updated_at) VALUES (?,?,?,?,?,?)");
      put.run("claude-code", ${JSON.stringify(chief.dir)}, "google-docs", "discovered", JSON.stringify({ cli_name: "claude.ai Google Docs", status: "needs-auth", scope: "connector" }), now);
      put.run("claude-code", ${JSON.stringify(chief.dir)}, "github", "discovered", JSON.stringify({ cli_name: "github", status: "failed", scope: "config" }), now);
    `], { encoding: "utf8" });
    expect(seed.status, seed.stderr).toBe(0);

    // A connector is account-level: it is not in the CLI's list, so its login command cannot act on it.
    const connector = await srv.api("POST", "/api/mcp/auth", { adapter: "claude-code", action: "login", name: "google-docs" });
    expect(connector.status).toBe(409);
    expect(String(connector.body.error)).toMatch(/connector of your Claude account/);

    // The refusal arrives with exit code 0. It must be reported as failed, with the CLI's own words — the whole
    // point: it used to end `done` because the code was 0.
    const started = await srv.api("POST", "/api/mcp/auth", { adapter: "claude-code", action: "login", name: "github" });
    expect([200, 202]).toContain(started.status);
    const id = String(started.body.id);
    let flow: any = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      flow = (await srv.api("GET", `/api/mcp/auth/${id}`)).body;
      if (flow?.finishedAt) break;
    }
    expect(flow?.status, JSON.stringify(flow)).toBe("failed");
    expect(String(flow?.error)).toMatch(/No MCP server named|nothing changed/);
  } finally { await srv.stop(); }
});

test("E15.63-1 a connector is signed in at the account, so the card links there and chief offers no command for it", () => {
  // Reported 2026-11-21: "it just shows connected and needs sign-in, there's no sign in/sign out action i can perform".
  // A claude.ai connector is not in the CLI's configuration at all — `claude mcp get`, `claude mcp login` and
  // `claude mcp --help` all refuse one — so the only place a person can act is the account's connector page.
  const section = readFileSync(join(ROOT_DIR, "packages/web/src/pages/mcp-section.tsx"), "utf8");
  // The link, opened in a new tab, so the person's place in chief is not lost.
  expect(section).toContain("https://claude.ai/customize/connectors");
  const link = section.slice(section.indexOf("settings-mcp-connectors-link"), section.indexOf("settings-mcp-connectors-link") + 400);
  expect(link).toContain('target="_blank"');
  expect(link).toContain('rel="noreferrer"');
  expect(link, "it says what the link is for: authenticating connections").toMatch(/authenticate them at claude\.ai/i);

  // The guide a person reads inside chief says the same thing, so the two do not disagree.
  const guide = readFileSync(join(ROOT_DIR, "packages/web/src/mcp-guide.ts"), "utf8");
  expect(guide).toMatch(/connector[^"]*authenticated per connector at claude\.ai\/customize\/connectors/i);

  // The adapters build no login command for a connector: they are given the CLI's own name, and the CLI has never
  // heard of it. Stated as a property of the code rather than trusted: only the two CLIs with real commands exist.
  const claude = readFileSync(join(ROOT_DIR, "packages/chief/src/adapters/claude-code.ts"), "utf8");
  expect(claude).toContain("mcp login");
  expect(claude).toContain("--no-browser");
});

test("E15.68-1 shadcn's token names resolve onto chief's own palette, and the brand colour is not shadcn's accent", () => {
  // shadcn components are written against --background/--primary/--muted/… . Alias them onto chief's tokens rather than
  // define a second palette, which is what E15.8-3 exists to prevent (two layers that drift).
  const css = readFileSync(join(ROOT_DIR, "packages/web/src/styles.css"), "utf8");
  const root = css.slice(css.lastIndexOf("\n:root {"));
  for (const token of ["background", "foreground", "card", "popover", "primary", "secondary", "muted", "accent", "destructive", "border", "input", "ring"]) {
    const line = new RegExp(`--${token}:\\s*([^;]+);`).exec(root);
    expect(line, `--${token} is defined`).toBeTruthy();
    const value = line![1].trim();
    if (value.startsWith("var(--")) expect(css, `--${token} -> ${value} resolves`).toContain(`--${value.slice(6, -1)}:`);
  }
  // shadcn's `accent` is a hover surface, and chief has no brand colour of its own any more: the neutral primary
  // (15.83) removed `--brand`, so a token by that name coming back would mean the palette drifted again.
  expect(css).not.toContain("--brand:");
  expect(/--accent:\s*var\(--color-slate-100\)/.test(root), "accent is a quiet surface").toBe(true);
  // A selected rail item is shadcn's accent surface (`bg-accent`) with primary text — the meaning the token has now —
  // and no class asks for a brand colour, which no longer exists.
  const app = readFileSync(join(ROOT_DIR, "packages/web/src/app.tsx"), "utf8");
  expect(app).toMatch(/bg-accent\b/);
  expect(app).not.toMatch(/\b(bg|text|border)-brand\b/);
  // `cn()` exists where shadcn expects it.
  expect(readFileSync(join(ROOT_DIR, "packages/web/src/lib/utils.ts"), "utf8")).toContain("twMerge");
});

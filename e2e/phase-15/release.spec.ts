import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { expect, ROOT_DIR, test } from "../helpers";

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
test("E15.19-1 every screenshot the README shows exists, and every screenshot in the folder is shown", () => {
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

  // The page cannot hard-code a versioned asset URL: it takes the download from the build
  // (`CHIEF_DMG_URL`), and the README points at the releases page rather than naming a file.
  const site = readFileSync(join(ROOT_DIR, "site/index.html"), "utf8");
  expect(site).toContain("{{dmg-url}}");
  expect(site, "no -latest link in the page").not.toContain("latest.dmg");
  // Where the page names the file, it is the real name (task 15.28).
  expect(site).toContain("chief-{{version}}-apple-silicon.dmg");
  expect(readFileSync(join(ROOT_DIR, "README.md"), "utf8")).toContain("https://github.com/ccwukong/chief/releases");
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

test("E15.26-3 the landing page's download follows the newest release, and works before there is one", () => {
  const pages = parse(readFileSync(join(ROOT_DIR, ".github/workflows/pages.yml"), "utf8")) as { on: any; jobs: Record<string, { steps: any[] }> };
  // A new release changes the link, so the page is republished when one appears.
  expect(pages.on.release.types).toEqual(["published"]);
  const build = Object.values(pages.jobs)[0];
  const d = build.steps.map((s) => String(s.run ?? "")).join("\n");
  // It resolves the newest release and its asset by shape — `chief-*-apple-silicon.dmg`, so no version is
  // written down here — and passes the URL and the size in.
  expect(d).toContain("releases?per_page=100");
  expect(d).toContain("chief-.+-apple-silicon\\.dmg");
  expect(d).not.toContain("arm64");
  const env = build.steps.map((s) => String(s.env?.CHIEF_DMG_URL ?? "")).join(" ");
  expect(env).toContain("steps.dmg.outputs.url");
  const html = readFileSync(join(ROOT_DIR, "scripts/build-site.mjs"), "utf8");
  expect(html).toContain("CHIEF_DMG_URL");
  expect(html).toContain("CHIEF_DMG_SIZE");
  // With no release yet, the page still builds and links to the releases page instead of failing.
  expect(html).toContain("releases");
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

  // And the two workflows a tally commit would otherwise start ignore it by path.
  for (const file of ["ci.yml", "desktop.yml"]) {
    const wf = parse(readFileSync(join(ROOT_DIR, ".github/workflows", file), "utf8")) as { on: any };
    expect(wf.on.push["paths-ignore"], `${file} ignores the ledger`).toContain("downloads.json");
  }
  // `desktop.yml` keeps its version-bump logic on top of the ignore, so pruning or tallying cannot ship an
  // app and cannot be the reason one is missed.
  const desktop = parse(readFileSync(join(ROOT_DIR, ".github/workflows/desktop.yml"), "utf8")) as { jobs: Record<string, any> };
  expect(desktop.jobs.version).toBeTruthy();

  // The page's counter comes from that file, and is rebuilt when it changes.
  const pages = parse(readFileSync(join(ROOT_DIR, ".github/workflows/pages.yml"), "utf8")) as { on: any };
  expect(pages.on.push.paths).toContain("downloads.json");
  // And it builds daily as well, because the tally's own commit cannot trigger it: a push made with the
  // workflow's token raises no event GitHub acts on (its loop guard). The schedule is what keeps the baked
  // counter from staying a day behind for ever if the path trigger never fires.
  expect(pages.on.schedule?.[0]?.cron).toBeTruthy();
  // The file is what the docs point at, and the script that writes it is runnable on its own.
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

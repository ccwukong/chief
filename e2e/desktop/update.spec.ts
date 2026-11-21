import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, ROOT_DIR } from "./helpers";
import { checkForUpdate, downloadDmg, isNewer, newestRelease, parts } from "../../packages/desktop/src/update.ts";

/**
 * Phase 15, task 15.33: chief tells you when a newer version exists.
 *
 * What it is not: a silent installer. Squirrel.Mac — Electron's updater — verifies the running app's
 * code signature against a Developer ID before applying anything, and chief is signed ad hoc
 * (`codesign --sign -`), so it would refuse. The app therefore offers the release's `.dmg` and opens
 * it, which is the same drag-to-Applications window as a first install.
 *
 * These cases are the decision itself (which release, compared how) and the download; the dialog and
 * the menu item are wiring, checked as text because a native dialog cannot be clicked by Playwright.
 */
const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  html_url: `https://github.com/ccwukong/chief/releases/tag/${tag}`,
  published_at: "2026-11-21T00:00:00Z",
  assets: [{ name: `chief-${tag.slice(1)}-apple-silicon.dmg`, browser_download_url: `https://example.test/${tag}.dmg` }],
  ...extra,
});

test("E15.34-1 a version is compared by its numbers, so 0.10.0 is newer than 0.9.0", () => {
  expect(parts("0.2.3")).toEqual([0, 2, 3]);
  expect(parts("v1.12.0")).toEqual([1, 12, 0]);
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("0.9.0", "0.10.0")).toBe(false);
  expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  expect(isNewer("0.2.3", "0.2.3")).toBe(false);
  // Anything that is not three numbers can never be "newer": the rolling `latest` tag of 0.2.0 is not
  // a version, and an unparseable one must not turn into "an update is available".
  expect(isNewer("latest", "0.2.3")).toBe(false);
  expect(isNewer("0.2.3", "not a version")).toBe(false);
});

test("E15.34-2 the newest release is chosen by version, skipping drafts, prereleases and non-version tags", () => {
  const list = [
    rel("v0.9.0"),
    rel("v0.10.0"), // newer than 0.9.0, though it sorts lower as text
    rel("v0.11.0", { draft: true }),
    rel("v0.12.0", { prerelease: true }),
    rel("latest", { assets: [{ name: "chief-arm64.dmg", browser_download_url: "https://example.test/old.dmg" }] }),
    rel("v0.10.1"),
  ];
  const best = newestRelease(list)!;
  expect(best.version).toBe("0.10.1");
  expect(best.tag).toBe("v0.10.1");
  expect(best.dmgName).toBe("chief-0.10.1-apple-silicon.dmg");
  expect(best.dmg).toBe("https://example.test/v0.10.1.dmg");
  expect(best.page).toContain("/releases/tag/v0.10.1");
  // A release whose assets do not include the installer is still the newest version, just with nothing
  // to download: the page is offered instead of a file.
  expect(newestRelease([rel("v1.0.0", { assets: [] })])).toMatchObject({ version: "1.0.0", dmg: null, dmgName: null });
  expect(newestRelease([])).toBeNull();
  expect(newestRelease({ message: "Not Found" })).toBeNull();
});

test("E15.34-3 the check offers only a strictly newer release, and a refusal is an error to log, not a dialog", async () => {
  const serve = (body: unknown, status = 200) => new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = createServer((_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/releases`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
  const newer = await serve([rel("v0.2.4"), rel("v0.2.3")]);
  const same = await serve([rel("v0.2.3")]);
  const broken = await serve({ message: "rate limited" }, 403);
  try {
    expect(await checkForUpdate("0.2.3", { url: newer.url })).toMatchObject({ version: "0.2.4" });
    // The version it is running is not an update to itself; and a 403 is thrown so the caller logs a
    // line instead of interrupting somebody who is offline or rate-limited.
    expect(await checkForUpdate("0.2.4", { url: newer.url })).toBeNull();
    expect(await checkForUpdate("0.2.3", { url: same.url })).toBeNull();
    await expect(checkForUpdate("0.2.3", { url: broken.url })).rejects.toThrow("403");
  } finally {
    await newer.close();
    await same.close();
    await broken.close();
  }
});

test("E15.34-4 the installer is fetched to disk under the release's own name, and a broken download is deleted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chief-update-"));
  const bytes = Buffer.alloc(64 * 1024, 7);
  const server = createServer((req, res) => {
    if (req.url === "/half.dmg") {
      // Announce the whole length, send half, then drop the connection: a truncated download.
      res.writeHead(200, { "content-length": String(bytes.length) });
      res.write(bytes.subarray(0, bytes.length / 2));
      res.destroy();
      return;
    }
    res.writeHead(200, { "content-length": String(bytes.length) });
    res.end(bytes);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const release = { version: "0.2.4", tag: "v0.2.4", page: "https://example.test", dmg: `http://127.0.0.1:${port}/full.dmg`, dmgName: "chief-0.2.4-apple-silicon.dmg", published: null };
    const got = await downloadDmg(release, dir);
    expect(got.name).toBe("chief-0.2.4-apple-silicon.dmg");
    expect(readFileSync(got.path).byteLength).toBe(bytes.length);

    // A download that stops early must not leave a file that looks like an installer.
    const truncated = { ...release, dmg: `http://127.0.0.1:${port}/half.dmg`, dmgName: "chief-0.2.5-apple-silicon.dmg" };
    await expect(downloadDmg(truncated, dir)).rejects.toBeTruthy();
    expect(() => readFileSync(join(dir, "chief-0.2.5-apple-silicon.dmg"))).toThrow();

    // A release with no installer is the release page, not a crash.
    await expect(downloadDmg({ ...release, dmg: null, dmgName: null }, dir)).rejects.toThrow("no .dmg");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E15.34-5 the app checks at launch and offers it in the menu, and the check can be turned off", () => {
  const main = readFileSync(join(ROOT_DIR, "packages/desktop/src/main.ts"), "utf8");
  // At launch, after the server is up: a slow or failed check must not hold up chief starting.
  expect(main).toMatch(/await boot\(\);[\s\S]{0,300}void checkForUpdates\(\)/);
  // The menu item, next to About, as every Mac app has it.
  expect(main).toContain('label: "Check for Updates…"');
  expect(main).toMatch(/role: "about"[\s\S]{0,300}Check for Updates…/);
  // Off with an environment variable, and the URL overridable so a case (or a mirror) can point it
  // somewhere else. The check never installs: it offers the .dmg the release publishes.
  expect(main).toContain("CHIEF_NO_UPDATE_CHECK");
  expect(main).toContain("CHIEF_UPDATE_URL");
  expect(main).toContain("downloadDmg");
  expect(main).not.toContain("autoUpdater");
});

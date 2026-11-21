import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, ROOT_DIR, test } from "../helpers";

/**
 * Phase 15, task 15.29: the download total is persistent, and survives pruning old releases.
 *
 * GitHub's `download_count` belongs to the release asset, so a total read from GitHub drops when an old
 * release is deleted — and a pruned version has no count at all. `downloads.json` is the answer: a
 * committed ledger where each version keeps the highest count ever seen, and the total is their sum. Its
 * history is git's, and it is a file rather than a database or a service.
 *
 * The script takes the releases JSON as an argument, so all of this is tested without the network: the
 * merge rule is the whole design, and it is what these cases check. Each case gets its own copy of the
 * script and a ledger of its own in a temporary directory, so they can run in parallel and never touch the
 * repository's real `downloads.json`.
 */
const tray = () => {
  // The script keeps the ledger one folder above itself, exactly as it does in the repository: the copy
  // goes into `<tmp>/scripts/` so `<tmp>/downloads.json` is its ledger and the real one is never touched.
  const dir = mkdtempSync(join(tmpdir(), "chief-tally-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(ROOT_DIR, "scripts/download-tally.mjs"), join(dir, "scripts/download-tally.mjs"));
  writeFileSync(join(dir, "downloads.json"), JSON.stringify({ updated: null, total: 0, versions: {} }, null, 2));
  const run = (releases: unknown, extra: string[] = []) => {
    const file = join(dir, `releases-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(releases));
    // The ledger is written beside the script's own folder, so `--check` and the merge both see it.
    const r = spawnSync(process.execPath, [join(dir, "scripts/download-tally.mjs"), ...extra, file], { encoding: "utf8" });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, ledger: JSON.parse(readFileSync(join(dir, "downloads.json"), "utf8")) };
  };
  return { dir, run, done: () => rmSync(dir, { recursive: true, force: true }) };
};
const release = (tag: string, count: number, name = `chief-${tag.replace(/^v/, "")}-apple-silicon.dmg`, more: object = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: [{ name, download_count: count }],
  ...more,
});

test("E15.29-1 the tally records a version's downloads, and running it again changes nothing", () => {
  const t = tray();
  try {
    const first = t.run([release("v0.1.0", 30)]);
    expect(first.status).toBe(0);
    expect(first.ledger.total).toBe(30);
    expect(first.ledger.versions).toEqual({ "0.1.0": 30 });
    expect(first.out).toContain("tally: 1 versions, 30 downloads, +30 0.1.0");

    // Idempotent: the same input twice is one ledger, not two entries or a doubled total.
    const again = t.run([release("v0.1.0", 30)]);
    expect(again.status).toBe(0);
    expect(again.ledger.total).toBe(30);
    expect(again.ledger.versions).toEqual({ "0.1.0": 30 });
    expect(again.out).toContain("+0");
  } finally {
    t.done();
  }
});

test("E15.29-2 pruning a release does not lower the total: the number is the maximum ever seen, per version", () => {
  const t = tray();
  try {
    t.run([release("v0.1.0", 30), release("v0.2.0", 12)]);
    expect(t.run([]).ledger.total).toBe(42);

    // 0.1.0's release deleted and a lower count for 0.2.0: neither may lower the ledger, because the
    // maximum was recorded while both still existed. This is the whole point of the ledger.
    const after = t.run([release("v0.2.0", 5)]);
    expect(after.status).toBe(0);
    expect(after.ledger.versions).toEqual({ "0.2.0": 12, "0.1.0": 30 });
    expect(after.ledger.total).toBe(42);

    // A new version adds to the same total, and a higher count still raises its own number.
    const grown = t.run([release("v0.2.0", 20), release("v0.3.0", 8)]);
    expect(grown.ledger.versions).toEqual({ "0.3.0": 8, "0.2.0": 20, "0.1.0": 30 });
    expect(grown.ledger.total).toBe(58);
  } finally {
    t.done();
  }
});

test("E15.29-3 only a published version's .dmg is counted: drafts, prereleases, checksums and other tags are not", () => {
  const t = tray();
  try {
    const r = t.run([
      release("v0.1.0", 10),
      // A checksum is a second download of the same file, not another download of the app.
      { tag_name: "v0.1.0", draft: false, prerelease: false, assets: [{ name: "chief-0.1.0-apple-silicon.dmg.sha256", download_count: 900 }] },
      release("v0.2.0", 700, "chief-0.2.0-apple-silicon.dmg", { draft: true }),
      release("v0.3.0-rc.1", 600, "chief-0.3.0-rc.1-apple-silicon.dmg", { prerelease: true }),
      // The old rolling release is not a version, so it is not a row in the ledger.
      release("latest", 500, "chief-arm64.dmg"),
    ]);
    expect(r.status).toBe(0);
    // The bare `v0.1.0` release above has two assets: only the .dmg is counted, so 10 + 0.
    expect(r.ledger.versions).toEqual({ "0.1.0": 10 });
    expect(r.ledger.total).toBe(10);

    // A tag without the `v` is the same version.
    const bare = t.run([release("0.1.0", 40)]);
    expect(bare.ledger.versions).toEqual({ "0.1.0": 40 });
  } finally {
    t.done();
  }
});

test("E15.29-4 --check writes nothing and exits 1 when the ledger is stale, 0 when it is current", () => {
  const t = tray();
  try {
    t.run([release("v0.1.0", 30)]);

    const current = t.run([release("v0.1.0", 30)], ["--check"]);
    expect(current.status, "up to date").toBe(0);

    const stale = t.run([release("v0.1.0", 55)], ["--check"]);
    expect(stale.status, "stale is a failure a person or a case can act on").toBe(1);
    expect(stale.out).toContain("stale");
    // Nothing was written: --check compares, it never repairs.
    expect(stale.ledger.versions).toEqual({ "0.1.0": 30 });
    expect(stale.ledger.total).toBe(30);

    // A malformed answer is an error, not a zero: writing 0 over a good ledger cannot be undone.
    const file = join(t.dir, "bad.json");
    writeFileSync(file, JSON.stringify({ message: "Not Found" }));
    const bad = spawnSync(process.execPath, [join(t.dir, "scripts/download-tally.mjs"), file], { encoding: "utf8" });
    expect(bad.status).toBe(1);
    expect(`${bad.stdout}${bad.stderr}`).toContain("expected a JSON array");
    expect(JSON.parse(readFileSync(join(t.dir, "downloads.json"), "utf8")).total).toBe(30);
  } finally {
    t.done();
  }
});


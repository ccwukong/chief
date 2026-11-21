#!/usr/bin/env node
/**
 * The download ledger: `downloads.json` at the repository root, and this script that keeps it current.
 *
 * GitHub counts downloads per release asset. That is the only place the number exists, it belongs to the
 * asset, and deleting a release deletes its count and its assets — so a total read live from GitHub goes
 * **down** when old releases are pruned, and a version that has been pruned has no count at all. The
 * ledger fixes both: each version's highest count ever seen is written down, and the total is the sum of
 * that record. It is a plain JSON file in git, not a database and not a service — it needs no host, it
 * survives pruning, and its `git log` is the audit trail.
 *
 *   node scripts/download-tally.mjs releases.json     # merge a `gh api .../releases` response
 *   gh api repos/o/r/releases | node scripts/download-tally.mjs
 *   node scripts/download-tally.mjs --check releases.json   # compare, write nothing, exit 1 if stale
 *
 * The rule is monotonic, per version: a version's number is `max(recorded, seen now)` and is never
 * lowered, and `total` is the sum of the versions. So deleting a release cannot lower the total: the
 * maximum was recorded while the release still existed. That is the whole design, and it is why this file
 * can be pruned around without losing a count.
 *
 * What counts: `.dmg` assets of published, non-prerelease releases whose tag is a version (`v0.1.1` or
 * `0.1.1`). Not `.sha256` — that is a second download of the same thing, and not every asset is a
 * download of the app. A tag that is not a version is not counted, and a malformed response is an error
 * rather than a zero: a tally that wrote 0 over a good ledger would be a lie that could not be undone.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledger = join(root, "downloads.json");

const args = process.argv.slice(2);
const check = args.includes("--check");
const file = args.find((a) => !a.startsWith("-"));

/** A version tag, `v0.1.1` or `0.1.1`; anything else (a branch name, `latest`, a build label) is ignored. */
const versionOf = (tag) => {
  const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(String(tag ?? "").trim());
  return m ? m[1] : null;
};

/** The `.dmg` assets of a release, and only those: a checksum is not a second download of the app. */
const dmgCount = (release) =>
  (Array.isArray(release?.assets) ? release.assets : [])
    .filter((a) => /\.dmg$/.test(String(a?.name ?? "")))
    .reduce((n, a) => n + (Number(a.download_count) || 0), 0);

/** Read the releases JSON from a file argument or stdin, and merge it into the ledger. */
function readReleases() {
  const text = file ? readFileSync(resolve(process.cwd(), file), "utf8") : readFileSync(0, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`not JSON: ${e.message}`);
  }
  // `gh api .../releases` answers an array; `?per_page=` paging may hand over an object with a message.
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array of releases (gh api repos/<owner>/<repo>/releases)");
  return parsed;
}

function readLedger() {
  if (!existsSync(ledger)) return { updated: null, total: 0, versions: {} };
  const l = JSON.parse(readFileSync(ledger, "utf8"));
  if (typeof l.total !== "number" || typeof l.versions !== "object" || l.versions === null) {
    throw new Error(`${ledger} is not a ledger: { updated, total, versions }`);
  }
  return l;
}

function main() {
  const before = readLedger();
  const releases = readReleases();

  const seen = new Map();
  for (const r of releases) {
    if (!r || r.draft === true || r.prerelease === true) continue;
    const version = versionOf(r.tag_name);
    if (!version) continue;
    const n = dmgCount(r);
    // Two releases could name the same version; the larger count is the one that happened.
    seen.set(version, Math.max(seen.get(version) ?? 0, n));
  }

  const versions = { ...before.versions };
  const gained = [];
  for (const [version, n] of seen) {
    const was = Number(versions[version]) || 0;
    if (n > was) {
      versions[version] = n;
      gained.push(`${n - was} ${version}`);
    }
  }

  // Newest first, so a diff of the file reads like a changelog rather than a bag of keys.
  const ordered = Object.fromEntries(
    Object.entries(versions).sort(([a], [b]) => {
      const p = (v) => v.split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
      const [x, y] = [p(a), p(b)];
      for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
      return 0;
    }),
  );
  const total = Object.values(ordered).reduce((n, v) => n + (Number(v) || 0), 0);

  const changed = total !== before.total || JSON.stringify(ordered) !== JSON.stringify(before.versions);
  const delta = gained.length ? `+${gained.join(", +")}` : "+0";
  const summary = `tally: ${Object.keys(ordered).length} versions, ${total.toLocaleString("en-US")} downloads, ${delta}`;

  if (check) {
    if (changed) {
      console.error(`${summary} — ${ledger} is stale; run: gh api repos/o/r/releases | node scripts/download-tally.mjs`);
      process.exit(1);
    }
    console.log(`${summary} — up to date`);
    return;
  }

  if (changed) {
    const next = { updated: new Date().toISOString(), total, versions: ordered };
    writeFileSync(ledger, JSON.stringify(next, null, 2) + "\n");
  }
  console.log(summary + (changed ? "" : " (unchanged)"));
}

try {
  main();
} catch (e) {
  console.error(`tally: ${e.message}`);
  process.exit(1);
}

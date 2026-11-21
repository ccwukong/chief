/**
 * Finding a newer chief, and fetching its installer. No Electron imports: the main process shows the
 * dialog and opens the file, and everything here is a function of (release list) → (what to offer).
 *
 * There is no auto-installer. Electron's `autoUpdater` on macOS is Squirrel.Mac, which verifies the
 * running app's signature against a Developer ID before it applies an update; chief is signed ad hoc
 * (`codesign --sign -`, no identity), so Squirrel refuses it. What is possible — and what this does —
 * is download the *installer* the release publishes and open it, so the person drags chief onto
 * Applications as they did the first time. Replacing a running bundle behind a signature check would
 * be the dishonest version of "automatic", not the convenient one.
 *
 * The check is the one network request chief makes that is not the agent CLI's own. It is documented
 * as such (README, the landing page) and can be switched off with `CHIEF_NO_UPDATE_CHECK=1`.
 */

export interface Release {
  /** The version without the `v`, e.g. "0.2.3". */
  version: string;
  /** The tag, e.g. "v0.2.3". */
  tag: string;
  /** The release page, for a person who wants the notes. */
  page: string;
  /** The installer's download URL, when the release has one. */
  dmg: string | null;
  /** Bare asset name, so the saved file is the same name the release uses. */
  dmgName: string | null;
  /** When it was published, ISO 8601. */
  published: string | null;
}

/** Every release is one version on its own tag, and the installer is named for it (dev plan 15.26). */
const API = "https://api.github.com/repos/ccwukong/chief/releases";
const DMG = /^chief-(.+)-apple-silicon\.dmg$/;

/** The three numbers of a version, so `0.10.0` beats `0.9.0` (which a string comparison gets wrong). */
export const parts = (v: string): number[] => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [];
};

/** Is `a` a later version than `b`? Both must be plain `x.y.z` (an unparseable one is never later). */
export function isNewer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * The newest release to offer, from GitHub's list (newest first, but not trusted to be). Drafts,
 * prereleases and tags that are not `v<x.y.z>` are skipped: a prerelease is not "the latest version",
 * and the rolling `latest` tag this project used before 0.2.0 is not a version at all.
 */
export function newestRelease(json: unknown): Release | null {
  if (!Array.isArray(json)) return null;
  let best: Release | null = null;
  for (const r of json) {
    if (!r || typeof r !== "object") continue;
    const rel = r as Record<string, any>;
    if (rel.draft || rel.prerelease) continue;
    const tag = typeof rel.tag_name === "string" ? rel.tag_name.trim() : "";
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue;
    const version = tag.slice(1);
    if (best && !isNewer(version, best.version)) continue;
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const dmg = assets.find((a: any) => a && typeof a.name === "string" && DMG.test(a.name));
    best = {
      version,
      tag,
      page: typeof rel.html_url === "string" ? rel.html_url : `https://github.com/ccwukong/chief/releases/tag/${tag}`,
      dmg: typeof dmg?.browser_download_url === "string" ? dmg.browser_download_url : null,
      dmgName: typeof dmg?.name === "string" ? dmg.name : null,
      published: typeof rel.published_at === "string" ? rel.published_at : null,
    };
  }
  return best;
}

/** What to offer, given the version that is running. `null` means there is nothing newer. */
export async function checkForUpdate(current: string, opts: { fetch?: typeof fetch; url?: string; timeoutMs?: number } = {}): Promise<Release | null> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(opts.url ?? API, {
    // GitHub's API wants a User-Agent; it answers unauthenticated at 60 requests an hour, which one
    // check per launch is nowhere near.
    headers: { accept: "application/vnd.github+json", "user-agent": "chief-desktop" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the release list`);
  const latest = newestRelease(await res.json());
  return latest && isNewer(latest.version, current) ? latest : null;
}

/**
 * Download the installer into `dir` and return its path. The bytes are streamed to the file rather
 * than held in memory: the image is ~130 MB. A download that stops early is deleted, so a half file
 * is never offered to the person as an installer.
 */
export async function downloadDmg(
  release: Release,
  dir: string,
  opts: { fetch?: typeof fetch; onProgress?: (got: number, total: number | null) => void } = {},
): Promise<{ path: string; name: string }> {
  if (!release.dmg || !release.dmgName) throw new Error(`release ${release.tag} has no .dmg to download`);
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(release.dmg, { headers: { "user-agent": "chief-desktop" } });
  if (!res.ok || !res.body) throw new Error(`the download answered ${res.status}`);
  const total = Number(res.headers.get("content-length")) || null;
  const { createWriteStream, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const path = join(dir, release.dmgName);
  const out = createWriteStream(path);
  let got = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.byteLength;
      opts.onProgress?.(got, total);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    rmSync(path, { force: true });
    throw e;
  }
  return { path, name: release.dmgName };
}

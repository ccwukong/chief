/**
 * The app bundle a development run launches: Electron's own, renamed chief and carrying chief's icon,
 * so the menu bar and the Dock show chief rather than Electron. macOS takes the name at the top of the
 * menu bar from the bundle (`CFBundleName` and the executable it names), never from `app.setName`, so a
 * development run that starts `Electron.app` can only say "Electron".
 *
 * The copy lives in `dist/` (git-ignored), is made with `cp -cR` (an APFS clone: no second 250 MB is
 * written), and is reused until the Electron version or the icon changes. Changing the plist and the
 * executable breaks the signature Electron ships with, and an app on Apple silicon does not start
 * without one, so the bundle is signed ad hoc afterwards (`codesign --sign -`, which is no identity).
 *
 * Development only: the packaged app gets its name and icon from `scripts/build.ts` and the packager.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DevBundleOptions {
  /** `node_modules/electron/dist/Electron.app` */
  electronApp: string;
  /** Where the result goes, e.g. `dist/desktop-dev/chief.app`. */
  out: string;
  /** `packages/desktop/assets/icon.icns` */
  icon: string;
  /** The Electron version, so a new Electron gets a new bundle. */
  electronVersion: string;
}

const plist = (app: string) => join(app, "Contents/Info.plist");
const digest = (file: string) => createHash("sha1").update(readFileSync(file)).digest("hex");

function run(command: string, args: string[]): { ok: boolean; output: string } {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Is the bundle there, and is it this Electron's and this icon's? */
function fresh({ out, icon, electronVersion }: DevBundleOptions): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(out, "Contents/Resources/chief-dev.json"), "utf8"));
    return marker.electron === electronVersion && marker.icon === digest(icon) && existsSync(join(out, "Contents/MacOS/chief"));
  } catch { return false; }
}

export function ensureDevBundle(opts: DevBundleOptions): string {
  const executable = join(opts.out, "Contents/MacOS/chief");
  if (fresh(opts)) return executable;

  rmSync(opts.out, { recursive: true, force: true });
  // A clone keeps the framework symlinks right and costs no space on the same volume; `ditto` is the
  // fallback for a dist folder on another one.
  if (!run("cp", ["-cR", opts.electronApp, opts.out]).ok && !run("ditto", [opts.electronApp, opts.out]).ok) {
    throw new Error(`could not copy ${opts.electronApp} to ${opts.out}`);
  }
  renameSync(join(opts.out, "Contents/MacOS/Electron"), executable);
  const info = plist(opts.out);
  for (const [key, value] of [["CFBundleName", "chief"], ["CFBundleDisplayName", "chief"], ["CFBundleExecutable", "chief"], ["CFBundleIdentifier", "dev.chief.app"]] as const) {
    const r = run("plutil", ["-replace", key, "-string", value, info]);
    if (!r.ok) throw new Error(`could not set ${key} in ${info}: ${r.output}`);
  }
  if (!run("plutil", ["-replace", "CFBundleIconFile", "-string", "icon.icns", info]).ok) throw new Error(`could not set the icon in ${info}`);
  const iconOut = join(opts.out, "Contents/Resources/icon.icns");
  const copied = run("cp", [opts.icon, iconOut]);
  if (!copied.ok) throw new Error(`could not copy ${opts.icon}: ${copied.output}`);
  writeFileSync(join(opts.out, "Contents/Resources/chief-dev.json"), JSON.stringify({ electron: opts.electronVersion, icon: digest(opts.icon) }) + "\n");
  const signed = run("codesign", ["--force", "--deep", "--sign", "-", opts.out]);
  if (!signed.ok) throw new Error(`the renamed bundle could not be signed ad hoc: ${signed.output}`);
  return executable;
}

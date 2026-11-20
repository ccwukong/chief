/**
 * Build the desktop app, in two steps that can be run apart:
 *
 *   node scripts/build.ts            stage: `dist/desktop/app/` (the Electron main process, one file)
 *                                    and `dist/desktop/server/` (the server bundle `dist/chief.mjs` and
 *                                    its migrations). Enough to run with `electron dist/desktop/app`.
 *   node scripts/build.ts --package  stage, then the macOS app `dist/chief.app` and `dist/chief.dmg`
 *                                    (unsigned apart from the ad-hoc signature Apple silicon requires).
 *
 * The server is the one the CLI runs (`npm run build` first); it is JavaScript, so the app runs it on
 * the Node inside Electron (`ELECTRON_RUN_AS_NODE=1`), and nothing here is a second implementation.
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const root = resolve(pkg, "../..");
const dist = join(root, "dist");
const stage = join(dist, "desktop");
const bundle = join(dist, "chief.mjs");
if (!existsSync(bundle)) {
  console.error("dist/chief.mjs is missing. Run `npm run build` first (or `npm run build:desktop`, which does).");
  process.exit(1);
}
const version: string = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
const electronVersion: string = JSON.parse(readFileSync(join(root, "node_modules/electron/package.json"), "utf8")).version;
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "app"), { recursive: true });
await build({
  entryPoints: [join(pkg, "src/main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22",
  outfile: join(stage, "app/main.cjs"), external: ["electron"], sourcemap: false,
});
writeFileSync(join(stage, "app/package.json"), JSON.stringify({ name: "chief", productName: "chief", version, main: "main.cjs", description: "chief for macOS", license: "Apache-2.0" }, null, 2) + "\n");
  cpSync(bundle, join(stage, "server/chief.mjs"));
  cpSync(join(dist, "migrations"), join(stage, "server/migrations"), { recursive: true });
  // The licence files sit beside the bundle in dist/ (the server build writes them there); the app ships
  // the whole server folder, so they end up in Contents/Resources/server/ inside the .dmg (task 15.18).
  for (const name of ["LICENSE", "THIRD-PARTY-NOTICES.md"]) {
    if (existsSync(join(dist, name))) cpSync(join(dist, name), join(stage, "server", name));
  }
console.log(`staged ${stage} (app/main.cjs, server/chief.mjs, ${version})`);

/** How `hdiutil info` describes an attached image: the disk, and where it is mounted, if it is. */
interface Attachment {
  /** The whole disk, e.g. `/dev/disk5`; empty only when `hdiutil info` did not name one. */
  device: string;
  /** The mount point, e.g. `/Volumes/chief — drag to Applications 1`; empty while it is released. */
  mount: string;
}

/**
 * The image at `image` as `hdiutil info` sees it, or `null` when it is not attached.
 *
 * The **image path** is the identity, never the volume's name. A name is not unique: attaching a
 * second volume called `chief — drag to Applications` mounts it as `… 1`, so a substring test on the
 * name answers "attached" about the other disk, and `hdiutil detach` by that name ejects the other
 * volume. Both were reproduced on a machine that had the published `.dmg` mounted while a build ran.
 *
 * The plist is the authority; the text output is the fallback for a `hdiutil` that will not answer one.
 */
function attachment(image: string): Attachment | null {
  const info = spawnSync("hdiutil", ["info", "-plist"], { encoding: "utf8", timeout: 60_000 });
  if (info.status === 0) {
    const json = spawnSync("plutil", ["-convert", "json", "-o", "-", "-"], { encoding: "utf8", input: info.stdout ?? "", timeout: 60_000 });
    if (json.status === 0) {
      try {
        const parsed = JSON.parse(json.stdout || "{}") as {
          images?: { "image-path"?: string; "system-entities"?: { "dev-entry"?: string; "mount-point"?: string }[] }[];
        };
        const found = parsed.images?.find((i) => i["image-path"] === image);
        if (!found) return null;
        const entities = found["system-entities"] ?? [];
        const mounted = entities.find((e) => e["mount-point"]);
        return { device: entities[0]?.["dev-entry"] ?? mounted?.["dev-entry"] ?? "", mount: mounted?.["mount-point"] ?? "" };
      } catch {
        // Not JSON after all: the text output below carries the same facts.
      }
    }
  }
  const blocks = (spawnSync("hdiutil", ["info"], { encoding: "utf8", timeout: 60_000 }).stdout ?? "").split(/^=+$/m);
  const block = blocks.find((b) => b.split("\n").some((l) => /^\s*image-path\s*:/.test(l) && l.slice(l.indexOf(":") + 1).trim() === image));
  if (!block) return null;
  return { device: /\/dev\/disk\d+/.exec(block)?.[0] ?? "", mount: /\/Volumes\/[^\t\n]+/.exec(block)?.[0].trim() ?? "" };
}

/** A failure a second attempt may not have: the volume was still being released. */
class TransientImageError extends Error {}

/**
 * Make `dist/chief.dmg` with the layout an installer is expected to have: chief on the left, an
 * `Applications` shortcut on the right, and the instruction written on the window. A bare
 * `-srcfolder dist/chief.app` puts exactly one item on the volume, so there is nowhere to drop the app
 * and the README has to explain the drag in words.
 *
 * The hint is given three times, because each layer reaches a machine the others do not:
 *
 *  - the **volume name** says it. Finder shows it in the window's title bar, and it is there even when
 *    Finder never runs the layout script (CI, a headless session, an automation permission refused).
 *  - the **background picture** says it in words, beside the arrow that points at the shortcut. It is a
 *    committed PNG (`assets/dmg-background.png`, rendered once from an SVG/HTML mock — drawing text with
 *    `sips` is not possible and a headless browser is not a build dependency), so the build only copies it.
 *  - the **Finder layout** puts the two icons where the picture expects them. That step is the only one
 *    that needs a display session, and it is allowed to fail.
 */
function makeDmg(): void {
  const app = join(dist, "chief.app");
  const dmg = join(dist, "chief.dmg");
  // Where the two icons go, in the window's own coordinates. The background picture is drawn for
  // exactly this: its text sits above `chief.app`, its arrow points between the icons at `Applications`.
  const VOLUME = "chief — drag to Applications";
  const WINDOW = { left: 200, top: 120, right: 800, bottom: 520 };
  const ICON_SIZE = 128;
  const CHIEF_AT = { x: 170, y: 190 };
  const APPLICATIONS_AT = { x: 460, y: 190 };
  // What goes on the volume, not the volume itself. `Applications` is a symlink to the real folder,
  // never a copy of it: dragging `chief.app` onto it hands the app to `/Applications`, where a copied
  // folder would leave a second, empty one behind.
  const layout = join(stage, "dmg");
  rmSync(layout, { recursive: true, force: true });
  mkdirSync(join(layout, ".background"), { recursive: true });
  symlinkSync("/Applications", join(layout, "Applications"));
  // The picture Finder shows behind the icons. `.background` is a dot-folder, so the volume looks like
  // two items; Finder keeps the reference in the `.DS_Store` and needs the file to stay in the image.
  const backgroundName = "dmg-background.png";
  const background = join(pkg, "assets", backgroundName);
  // It is committed, not drawn here, so a build from a bad checkout must say which file is missing.
  if (!existsSync(background)) throw new Error(`${background} is missing: the installer's background picture is a committed asset (docs/desktop.md).`);
  cpSync(background, join(layout, ".background", backgroundName));
  // `verbatimSymlinks` keeps the framework links inside the bundle exactly as they were signed; a
  // rewritten link invalidates the signature, and macOS then refuses to start the copy.
  cpSync(app, join(layout, "chief.app"), { recursive: true, verbatimSymlinks: true });
  console.log(`staged the install folder ${layout} (chief.app, Applications → /Applications, .background/${backgroundName})`);

  // A synchronous pause (no shell, no timer).
  const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const output = (r: SpawnSyncReturns<string>) => `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
  // The answers `hdiutil` gives while a volume, or the image behind it, is still being released.
  const transient = (r: SpawnSyncReturns<string>) => /Resource\s+(temporarily\s+unavailable|busy)|couldn.t unmount .*- Resource busy/i.test(output(r));
  const step = (what: string, r: SpawnSyncReturns<string>): void => {
    if (r.status === 0) return;
    const detail = output(r) || r.error?.message || "";
    const message = `${what} failed${detail ? `: ${detail}` : ""}`;
    // A busy image is worth another attempt; a bad path or a full disk is not.
    throw transient(r) ? new TransientImageError(message) : new Error(message);
  };

  // Patience is free: a DMG build may take minutes, and a loaded runner can take tens of seconds to
  // release a 128 MB volume. The ten seconds the old loop allowed is what failed the E10.5-1 case on
  // CI (run 44762380794) with a detach that had nothing left to wait for but was not there yet.
  const ATTACH_WAIT_MS = 20_000;
  const DETACH_GENTLE_MS = 12_000;
  const DETACH_TOTAL_MS = 45_000;
  const CONVERT_RELEASE_MS = 45_000;
  const IMAGE_BUDGET_MS = 240_000;

  /**
   * Why the volume would not go away, with the evidence: `hdiutil`'s own stderr (asked again without
   * `-quiet`, which is why CI's message had none) and whatever `lsof` finds holding it.
   */
  const whyStillAttached = (image: string, at: Attachment, said: string, elapsed: number): TransientImageError => {
    const where = at.device || at.mount;
    const probe = where ? spawnSync("hdiutil", ["detach", where], { encoding: "utf8", timeout: 120_000 }) : null;
    const holders = at.mount
      ? (spawnSync("lsof", ["+c", "0", "+D", at.mount], { encoding: "utf8", timeout: 120_000 }).stdout ?? "").trim()
      : "";
    // Both matter: the loop's last answer may be a deprecation warning (macOS 27 prints one on success
    // too), and the probe's answer is the real reason this time. Neither is allowed to hide the other.
    const spoken = [...new Set([said, probe ? output(probe) : ""].map((s) => s.trim()).filter(Boolean))].join("\n");
    return new TransientImageError([
      `hdiutil detach failed after ${secs(elapsed)}: ${where || image}${at.mount ? ` (${at.mount})` : ""} is still attached to ${image}`,
      spoken ? `hdiutil said: ${spoken}` : "",
      holders ? `processes holding it (lsof):\n${holders.split("\n").slice(0, 12).join("\n")}` : "lsof found no process holding a file in it",
    ].filter(Boolean).join("\n"));
  };

  /**
   * Detach the image and do not return until `hdiutil info` no longer lists it: the mount point going
   * away is not the same as the image being released, and `hdiutil convert` answers "Resource
   * temporarily unavailable" while it is (the 0.2.1 build failed exactly there). The first detaches are
   * gentle, because a volume Finder is still writing deserves them; forced ones start after
   * DETACH_GENTLE_MS. It is detached by **device**, taken from `hdiutil info`, so a name another mounted
   * volume also carries can neither be mistaken for ours nor be ejected in ours.
   */
  const detach = (image: string): void => {
    const started = Date.now();
    let said = "";
    for (;;) {
      const at = attachment(image);
      if (!at) {
        console.log(`hdiutil detach: released after ${secs(Date.now() - started)}`);
        return;
      }
      const where = at.device || at.mount;
      if (!where) throw new TransientImageError(`hdiutil detach failed: ${image} is attached but hdiutil info names neither a device nor a mount point for it`);
      const elapsed = Date.now() - started;
      if (elapsed >= DETACH_TOTAL_MS) {
        const why = whyStillAttached(image, at, said, elapsed);
        // The probe inside the message is itself a real, unforced attempt: it may have been the one that worked.
        if (!attachment(image)) {
          console.log(`hdiutil detach: released after ${secs(Date.now() - started)}`);
          return;
        }
        throw why;
      }
      const forced = elapsed >= DETACH_GENTLE_MS;
      const r = spawnSync("hdiutil", ["detach", where, ...(forced ? ["-force"] : [])], { encoding: "utf8", timeout: 120_000 });
      const text = output(r);
      if (text) said = text;
      pause(forced ? 1_000 : 250);
    }
  };

  /** One attempt: a fresh scratch image, through create → attach → layout → detach → convert. */
  const buildImage = (attempt: number): void => {
    const scratch = mkdtempSync(join(tmpdir(), "chief-dmg-"));
    const rw = join(scratch, "chief-rw.dmg");
    const started = Date.now();
    try {
      const createStart = Date.now();
      step(`hdiutil create (attempt ${attempt})`, spawnSync("hdiutil", ["create", "-volname", VOLUME, "-srcfolder", layout, "-ov", "-format", "UDRW", "-fs", "HFS+", rw], { encoding: "utf8", timeout: 600_000 }));
      console.log(`hdiutil create: ${secs(Date.now() - createStart)} → ${rw}`);

      const attachStart = Date.now();
      step(`hdiutil attach (attempt ${attempt})`, spawnSync("hdiutil", ["attach", "-readwrite", "-noverify", "-noautoopen", rw], { encoding: "utf8", timeout: 120_000 }));
      // The attach status is not the mount: wait until `hdiutil info` knows the image and where it is.
      // The mount point is `/Volumes/<the volume's name>`, or `… 1` when that name is taken, which is
      // also the name Finder needs; it comes from `hdiutil info` rather than a guess at the output.
      let at: Attachment | null = null;
      for (let waited = 0; waited < ATTACH_WAIT_MS; waited += 250) {
        at = attachment(rw);
        if (at?.mount) break;
        pause(250);
      }
      if (!at?.mount) throw new TransientImageError(`hdiutil attach reported success but ${rw} is not mounted after ${secs(ATTACH_WAIT_MS)}`);
      const mount = at.mount;
      console.log(`hdiutil attach: ${secs(Date.now() - attachStart)} → ${mount} (${at.device || "no device named"})`);
      const disk = basename(mount);
      try {
        // Finder writes the `.DS_Store` that makes the positions and the picture stick. A build machine has
        // no Finder (and nobody to grant the automation permission), so a failure here is a warning and the
        // build goes on: the volume still holds the app, the shortcut and the `Applications` in its own
        // name, which is the hint a person reads when the window cannot be arranged.
        const script = [
          'tell application "Finder"',
          `  tell disk "${disk}"`,
          "    open",
          "    set current view of container window to icon view",
          "    set toolbar visible of container window to false",
          "    set statusbar visible of container window to false",
          `    set the bounds of container window to {${WINDOW.left}, ${WINDOW.top}, ${WINDOW.right}, ${WINDOW.bottom}}`,
          "    set theViewOptions to the icon view options of container window",
          "    set arrangement of theViewOptions to not arranged",
          `    set icon size of theViewOptions to ${ICON_SIZE}`,
          // The picture is inside the volume, so the path Finder records in the `.DS_Store` travels with it.
          `    set background picture of theViewOptions to file ".background:${backgroundName}"`,
          `    set position of item "chief.app" of container window to {${CHIEF_AT.x}, ${CHIEF_AT.y}}`,
          `    set position of item "Applications" of container window to {${APPLICATIONS_AT.x}, ${APPLICATIONS_AT.y}}`,
          "    update without registering applications",
          "    delay 1",
          "    close",
          "  end tell",
          "end tell",
        ].join("\n");
        const look = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 60_000 });
        if (look.status !== 0) {
          const detail = (look.error?.message ?? String(look.stderr || look.stdout || "")).trim();
          console.warn(`warning: Finder did not lay out the installer window${detail ? `: ${detail}` : ""}. The volume still says "${VOLUME}" and holds chief.app and the Applications shortcut.`);
        }
        // Finder's writes are still reaching the image when the script returns.
        spawnSync("sync", [], { timeout: 30_000 });
      } finally {
        detach(rw);
      }

      // `hdiutil convert` answers "Resource temporarily unavailable" while the image it is reading is still
      // being released. Only that answer is retried — long enough for a loaded runner to finish releasing —
      // and anything else (a bad path, no space) is a real error and is reported at once.
      const convertStart = Date.now();
      let conv = spawnSync("hdiutil", ["convert", rw, "-format", "UDZO", "-ov", "-o", dmg], { encoding: "utf8", timeout: 600_000 });
      while (conv.status !== 0 && transient(conv) && Date.now() - convertStart < CONVERT_RELEASE_MS) {
        pause(1_000);
        conv = spawnSync("hdiutil", ["convert", rw, "-format", "UDZO", "-ov", "-o", dmg], { encoding: "utf8", timeout: 600_000 });
      }
      if (conv.status !== 0) {
        const detail = output(conv) || conv.error?.message || "";
        const message = `hdiutil convert failed${detail ? `: ${detail}` : ""}`;
        if (transient(conv)) throw new TransientImageError(`${message} (after ${secs(Date.now() - convertStart)} waiting for the image to be released)`);
        throw new Error(message);
      }
      console.log(`hdiutil convert: ${secs(Date.now() - convertStart)} → ${dmg}`);
      console.log(`made ${dmg} in ${secs(Date.now() - started)} (attempt ${attempt})`);
    } finally {
      // Best effort, and it must not hide the error that got here: this runs after a failure too. It
      // never detaches `""` — a mount point that was never resolved is not a path (an empty string is a
      // substring of everything, which is how the old loop could spin on a volume it could not name).
      const left = attachment(rw);
      const target = left ? left.device || left.mount : "";
      if (target) spawnSync("hdiutil", ["detach", target, "-force"], { encoding: "utf8", timeout: 120_000 });
      if (!target) {
        rmSync(scratch, { recursive: true, force: true });
      } else if (attachment(rw)) {
        // Unlinking the file behind a still-mounted volume would leave macOS with a disk whose image is
        // gone. Leave both, and say where, so a person can see what happened instead of chasing a phantom.
        console.warn(`warning: ${rw} is still attached as ${target} (attempt ${attempt}); its scratch folder ${scratch} is left in place rather than deleting the image behind a mounted volume`);
      } else {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  };

  // One attempt, then one retry — only when the volume refused to go, and with a fresh scratch folder
  // and a fresh image. A genuinely broken build (no space, a bad path) fails at once, with its message.
  const deadline = Date.now() + IMAGE_BUDGET_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      buildImage(attempt);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof TransientImageError) || Date.now() + 40_000 > deadline) throw err;
      console.warn(`warning: ${message}\nwarning: making the disk image again in a fresh scratch folder (attempt ${attempt + 1})`);
      pause(2_000);
    }
  }
}

if (process.argv.includes("--package")) {
  const { packager } = await import("@electron/packager");
  rmSync(join(dist, "chief.app"), { recursive: true, force: true });
  rmSync(join(dist, "chief.dmg"), { force: true });
  const out = join(dist, "desktop-package");
  rmSync(out, { recursive: true, force: true });
  const icon = join(pkg, "assets/icon.icns");
  const [appPath] = await packager({
    dir: join(stage, "app"), out, name: "chief", platform: "darwin", arch: process.arch as "arm64" | "x64", overwrite: true,
    appBundleId: "dev.chief.app", appVersion: version, electronVersion, appCategoryType: "public.app-category.developer-tools",
    ...(existsSync(icon) ? { icon } : {}), extraResource: [join(stage, "server")],
    prune: false, asar: false, quiet: true,
  });
  // A rename, not a copy: the frameworks inside are symlinks, which a recursive copy would break.
  renameSync(join(appPath, "chief.app"), join(dist, "chief.app"));
  rmSync(out, { recursive: true, force: true });
  // No Developer ID, no notarization, no hardened runtime (dev plan §3 "Distribution"). Changing the
  // bundle's Info.plist and adding the server invalidates the signature Electron ships with, and an
  // app on Apple silicon does not start without one, so the whole bundle is signed ad hoc: identity
  // "-", which is no identity at all. Nothing nested needs separate signing: the server is JavaScript.
  const sign = spawnSync("codesign", ["--force", "--deep", "--sign", "-", join(dist, "chief.app")], { encoding: "utf8" });
  if (sign.status !== 0) { console.error(sign.stderr || sign.stdout); process.exit(1); }
  try {
    makeDmg();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log(`built ${join(dist, "chief.app")} and ${join(dist, "chief.dmg")}`);
}

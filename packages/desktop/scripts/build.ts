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

  // Neither the read-write image nor its mount point goes in dist/: they are scratch, not an artifact,
  // and the volume is detached before this returns.
  const scratch = mkdtempSync(join(tmpdir(), "chief-dmg-"));
  const rw = join(scratch, "chief-rw.dmg");
  // Attached where macOS mounts volumes (`/Volumes/<the volume's name>`), not under the scratch folder:
  // Finder only sees a disk that is in `/Volumes`, and Finder is the one that writes the layout.
  let mount = "";
  let attached = false;
  const fail = (what: string, r: SpawnSyncReturns<string>): never => {
    const detail = (r.error?.message ?? String(r.stderr || r.stdout || "")).trim();
    throw new Error(`${what} failed${detail ? `: ${detail}` : ""}`);
  };
  // A synchronous pause for the retry loop below (no shell, no timer).
  const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  // Still attached? `hdiutil info` lists every attached image and its mount point.
  const stillAttached = (where: string): boolean =>
    (spawnSync("hdiutil", ["info"], { encoding: "utf8", timeout: 60_000 }).stdout ?? "").includes(where);
  // Detach, and do not return until the image is really gone. A volume that is still attached a moment
  // later makes the conversion below fail with "Resource temporarily unavailable" — which is what CI
  // showed once the installer work began writing to the image through Finder, so the detach is verified
  // rather than assumed.
  const detach = (where: string): void => {
    let last = spawnSync("hdiutil", ["detach", where, "-quiet"], { encoding: "utf8", timeout: 120_000 });
    for (let i = 0; i < 40 && stillAttached(where); i++) {
      if (i % 8 === 0) last = spawnSync("hdiutil", ["detach", where, "-quiet", "-force"], { encoding: "utf8", timeout: 120_000 });
      pause(250);
    }
    if (stillAttached(where)) fail("hdiutil detach", last);
  };
  try {
    const hdi = spawnSync("hdiutil", ["create", "-volname", VOLUME, "-srcfolder", layout, "-ov", "-format", "UDRW", "-fs", "HFS+", rw], { encoding: "utf8", timeout: 600_000 });
    if (hdi.status !== 0) fail("hdiutil create", hdi);
    const at = spawnSync("hdiutil", ["attach", "-readwrite", "-noverify", "-noautoopen", rw], { encoding: "utf8", timeout: 120_000 });
    if (at.status !== 0) fail("hdiutil attach", at);
    attached = true;
    // The mount point is the last column of the attach output's last line (`/Volumes/<name>`, or
    // `/Volumes/<name> 1` when that name was already taken).
    mount = /\t(\/Volumes\/[^\t\n]+)\s*$/m.exec(at.stdout ?? "")?.[1]?.trim() ?? join("/Volumes", VOLUME);
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
      if (attached) {
        detach(mount);
        attached = false;
      }
    }
    const conv = spawnSync("hdiutil", ["convert", rw, "-format", "UDZO", "-ov", "-o", dmg], { encoding: "utf8", timeout: 600_000 });
    if (conv.status !== 0) fail("hdiutil convert", conv);
  } finally {
    // Best effort: this runs after a failure too, and must not hide the error that got here.
    if (attached && stillAttached(mount)) spawnSync("hdiutil", ["detach", mount, "-quiet", "-force"], { encoding: "utf8", timeout: 120_000 });
    rmSync(scratch, { recursive: true, force: true });
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

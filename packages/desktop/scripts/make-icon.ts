/**
 * Make `assets/icon.icns` from the web UI's logo (`packages/web/public/logo.svg`): the logo on a
 * rounded white square in the size macOS uses, rendered by Chromium and packed with `iconutil`.
 * Run it again only when the logo changes; the result is committed.
 */
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(resolve(pkg, "../web/public/logo.svg"), "utf8");
const set = join(pkg, "assets/icon.iconset");
rmSync(set, { recursive: true, force: true });
mkdirSync(set, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<body style="margin:0;background:transparent"><div style="position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:185px;background:#fff;box-shadow:0 12px 30px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center"><div style="width:600px;height:600px">${svg.replace("<svg ", '<svg width="600" height="600" ')}</div></div></body>`);
await page.screenshot({ path: join(set, "master.png"), omitBackground: true });
await browser.close();
const sizes: [string, number][] = [["16x16", 16], ["16x16@2x", 32], ["32x32", 32], ["32x32@2x", 64], ["128x128", 128], ["128x128@2x", 256], ["256x256", 256], ["256x256@2x", 512], ["512x512", 512], ["512x512@2x", 1024]];
for (const [name, px] of sizes) spawnSync("sips", ["-z", String(px), String(px), join(set, "master.png"), "--out", join(set, `icon_${name}.png`)], { stdio: "ignore" });
rmSync(join(set, "master.png"));
const r = spawnSync("iconutil", ["-c", "icns", set, "-o", join(pkg, "assets/icon.icns")], { encoding: "utf8" });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
rmSync(set, { recursive: true, force: true });
console.log("wrote packages/desktop/assets/icon.icns");

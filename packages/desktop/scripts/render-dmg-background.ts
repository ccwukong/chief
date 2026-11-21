// Draws `assets/dmg-background.png` from `assets/dmg-background.html`.
//
// **The picture is exactly the window's size in pixels: 600×400 for `WINDOW` in `build.ts`, at 72 dpi.**
// Finder draws a background picture at its natural point size, and a point is a pixel at 72 dpi — so a
// 1200×800 picture is drawn twice the size of a 600×400 window and a person sees the top-left quarter of it
// (that is what the first version did: a 60 pt sentence running off the right edge, reported twice on
// 2026-11-20). Rendering at 2× only helps if the DPI is declared as 144, and whether Finder honours that is
// not something this repository can check without a screen; the size that is drawn correctly is the size
// that is written.
//
// This is a development tool, not a build step: the PNG is committed, and `build.ts` only copies it. It
// needs the Playwright Chromium the e2e suite already installs (`npx playwright install chromium`), which
// is why the app build does not run it — a build machine has no browser and no reason to draw text.
//
//     npm run render:dmg-background --workspace desktop
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "assets");
const WINDOW = { width: 600, height: 400 };
// One image pixel per point (see the note at the top): 2 would draw at twice the window's size.
const SCALE = 1;
// The two icons, exactly as `build.ts` places them, and the size Finder draws them at. The picture has to
// leave this space empty: Finder's icons are drawn over it, not beside it.
const ICON = 128;
const CHIEF_AT = { x: 170, y: 190 };
const APPLICATIONS_AT = { x: 460, y: 190 };
const iconRects = [CHIEF_AT, APPLICATIONS_AT].map((c) => ({
  left: c.x - ICON / 2, top: c.y - ICON / 2, right: c.x + ICON / 2, bottom: c.y + ICON / 2,
}));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: WINDOW,
    deviceScaleFactor: SCALE,
    // No scrollbars, no focus ring: the page is a picture.
    colorScheme: "light",
  });
  await page.setContent(readFileSync(join(assets, "dmg-background.html"), "utf8"), { waitUntil: "load" });
  // A fixed file name, so a second run is a diff of the picture and nothing else.
  const out = join(assets, "dmg-background.png");
  await page.screenshot({ path: out, fullPage: false });

  // The size is the contract: *the window's* size, in pixels, at 1× — not 2×, which is drawn at 2× and
  // cropped (see the note at the top of this file).
  const box = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  if (box.w !== WINDOW.width || box.h !== WINDOW.height) {
    throw new Error(`the mock is ${box.w}×${box.h}, but the installer window is ${WINDOW.width}×${WINDOW.height}`);
  }

  // And the words must be legible where they are drawn: on the page at all, and not underneath an icon
  // Finder puts on top of them. The first version of this picture failed both (a 60 pt sentence running off
  // the right edge and through the Applications icon), which a person found by opening the .dmg; these two
  // checks are what would have said so without opening it.
  for (const sel of [".hint", ".arrow"]) {
    const r = await page.locator(sel).boundingBox();
    if (!r) throw new Error(`${sel} is not on the page`);
    if (r.x < 0 || r.y < 0 || r.x + r.width > WINDOW.width || r.y + r.height > WINDOW.height) {
      throw new Error(`${sel} runs off the ${WINDOW.width}×${WINDOW.height} window: ${JSON.stringify(r)}`);
    }
    const hit = iconRects.find((i) => r.x < i.right && r.x + r.width > i.left && r.y < i.bottom && r.y + r.height > i.top);
    if (hit) throw new Error(`${sel} is drawn under an icon Finder puts at ${JSON.stringify(hit)}: ${JSON.stringify(r)}`);
  }
  console.log(`wrote ${out} (${WINDOW.width * SCALE}×${WINDOW.height * SCALE})`);
} finally {
  await browser.close();
}

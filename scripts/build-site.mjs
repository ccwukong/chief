#!/usr/bin/env node
/**
 * Assembles the landing page into `site/dist/`: the HTML and CSS from `site/`, chief's logo, and the
 * screenshots the README already shows — one source of truth for the pictures, so a page and a README
 * cannot disagree about what the app looks like.
 *
 *   node scripts/build-site.mjs           # build
 *   node scripts/build-site.mjs --serve   # build, then serve it on 127.0.0.1:8099 to look at it
 *
 * The page in `site/` carries placeholders, and this fills them:
 *
 *   {{version}}   the version in packages/desktop/package.json
 *   {{dmg-url}}   the download: CHIEF_DMG_URL when it is set (the Pages workflow resolves the newest
 *                 release's asset, `chief-<version>-apple-silicon.dmg`), otherwise the releases page — so
 *                 a local build still produces a page that works.
 *   {{dmg-size}}  CHIEF_DMG_SIZE when it is set, or the size of a `dist/chief*.dmg` built here, or an
 *                 honest approximation.
 *
 * The output is what `.github/workflows/pages.yml` publishes. Nothing here is a second implementation of
 * anything: it copies files and substitutes three strings.
 */
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "site");
// `site/dist` unless told otherwise: `CHIEF_SITE_OUT` lets two cases build at the same time without one
// publishing over the other's folder (E15.20-1, E15.20-3).
const out = process.env.CHIEF_SITE_OUT ? resolve(process.env.CHIEF_SITE_OUT) : join(src, "dist");
const version = JSON.parse(readFileSync(join(root, "packages/desktop/package.json"), "utf8")).version;
if (!version) throw new Error("no version in packages/desktop/package.json");

/** The .dmg this repository built, if it did: `chief-0.1.0-apple-silicon.dmg`, or `chief.dmg` locally. */
function builtDmg() {
  for (const dir of [join(root, "dist"), root]) {
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((n) => /^chief(-[\d.]+)?(-apple-silicon)?\.dmg$/.test(n));
    if (hit) return join(dir, hit);
  }
  return null;
}

// The download. `CHIEF_DMG_URL` comes from the Pages workflow, which reads it from the release, so the link
// names the exact versioned file. Without it, the releases page is where a person finds the newest one.
const dmgUrl = process.env.CHIEF_DMG_URL?.trim() || "https://github.com/ccwukong/chief/releases";
const built = builtDmg();
const size = process.env.CHIEF_DMG_SIZE?.trim() || (built ? `${Math.round(statSync(built).size / 1e6)} MB` : "~130 MB");

// No download counter on the page: the number is kept in `downloads.json` (task 15.29) for the
// repository's own record, and shown to nobody. A public total invites reading it as a measure of the
// product, and it counts downloads of a build, not people using it.

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "assets/screenshots"), { recursive: true });

let html = readFileSync(join(src, "index.html"), "utf8")
  .replaceAll("{{version}}", version)
  .replaceAll("{{dmg-url}}", dmgUrl)
  .replaceAll("{{dmg-size}}", size);
if (/\{\{/.test(html)) throw new Error(`a placeholder was left in the page: ${html.match(/\{\{[^}]*\}\}/)?.[0]}`);
writeFileSync(join(out, "index.html"), html);
cpSync(join(src, "styles.css"), join(out, "styles.css"));

// The logo, and every screenshot, from where the repository already keeps them.
cpSync(join(root, "packages/web/public/logo.svg"), join(out, "assets/logo.svg"));
const shots = join(root, "docs/screenshots");
for (const name of readdirSync(shots)) if (name.endsWith(".png")) cpSync(join(shots, name), join(out, "assets/screenshots", name));

// Pages serves 404s for unknown paths; a single page needs none, and .nojekyll stops Jekyll touching it.
writeFileSync(join(out, "404.html"), readFileSync(join(out, "index.html")));
writeFileSync(join(out, ".nojekyll"), "");

const files = readdirSync(join(out, "assets/screenshots")).length;
console.log(`built ${out} (v${version}, ${size}, ${files} screenshots, download ${dmgUrl})`);

if (process.argv.includes("--serve")) {
  const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = join(out, path === "/" ? "index.html" : path);
    if (!file.startsWith(out) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(readFileSync(join(out, "404.html")));
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  server.listen(8099, "127.0.0.1", () => console.log("serving on http://127.0.0.1:8099"));
}

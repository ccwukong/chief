#!/usr/bin/env node
/**
 * Put a `chief` command on the PATH, from the bundle this checkout builds.
 *
 * Run it after `npm run build`:
 *
 *     npm run install:cli            # ~/.local/bin/chief
 *     npm run install:cli -- --dir ~/bin
 *
 * Why a script and not a `bin` entry: `bin` publishes the *source*, which Node can run only because
 * this project's Node erases TypeScript in place — a dependency of the checkout, not of an install.
 * The bundle at `dist/chief.mjs` is one file that runs anywhere Node 22.18+ is, so the command people
 * get is the thing the repository actually ships (dev plan §11.5).
 *
 * The wrapper is a two-line shell script, not a symlink: a symlink to `dist/chief.mjs` breaks the
 * moment `dist/` is rebuilt into a new file, and one to `packages/chief/src/cli.ts` would run the
 * source. It points at the bundle's absolute path and re-resolves nothing.
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const bundle = join(root, "dist/chief.mjs");

const argv = process.argv.slice(2);
const dirIndex = argv.indexOf("--dir");
const target = resolve(dirIndex >= 0 ? argv[dirIndex + 1] ?? "" : join(homedir(), ".local", "bin"));

if (!existsSync(bundle)) {
  console.error(`dist/chief.mjs is missing. Run \`npm run build\` first (it builds the web UI and the bundle).`);
  process.exit(1);
}
if (dirIndex >= 0 && !argv[dirIndex + 1]) {
  console.error("--dir needs a directory, e.g. --dir ~/bin");
  process.exit(1);
}

// The bundle has to be able to start before it is put on the PATH: installing something that throws is
// worse than installing nothing.
try {
  execFileSync(process.execPath, [bundle, "--help"], { stdio: "pipe" });
} catch (e) {
  console.error(`dist/chief.mjs does not run: ${String(e?.stderr ?? e?.message ?? e).trim().slice(0, 400)}`);
  process.exit(1);
}

const wrapper = join(target, "chief");
const script = `#!/bin/sh
# chief — installed by \`npm run install:cli\` from ${root}
# It runs the bundle this checkout built, so rebuild (\`npm run build\`) to update it.
exec "${process.execPath}" "${bundle}" "$@"
`;

mkdirSync(target, { recursive: true });
// Only replace a file this script wrote: an unrelated `chief` in the target directory is left alone.
if (existsSync(wrapper)) {
  const current = readFileSync(wrapper, "utf8");
  if (!current.includes("installed by `npm run install:cli`")) {
    console.error(`${wrapper} already exists and was not installed by this script; leaving it alone.`);
    console.error(`Install somewhere else with: npm run install:cli -- --dir <directory>`);
    process.exit(1);
  }
}
writeFileSync(wrapper, script);
chmodSync(wrapper, 0o755);

console.log(`installed ${wrapper}`);
console.log(`  runs ${bundle}`);
// The most common way for this to look broken: the directory is not on PATH.
const path = (process.env.PATH ?? "").split(":").map((p) => resolve(p));
if (!path.includes(target)) {
  console.log("");
  console.log(`${dirname(wrapper)} is not on your PATH. Add this to ~/.zshrc (or ~/.bashrc):`);
  console.log(`  export PATH="${target}:$PATH"`);
}

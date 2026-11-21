import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function newest(dir: string): number {
  let t = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    t = Math.max(t, s.isDirectory() ? newest(p) : s.mtimeMs);
  }
  return t;
}

/** Build the web UI when it is missing or older than its sources, so UI cases test the current code. */
export default function globalSetup() {
  const web = join(ROOT, "packages/web");
  const index = join(web, "dist/index.html");
  if (!existsSync(join(web, "src"))) return;
  // Everything that ends up in the build: the sources, the page, the dependencies and the static files in public/.
  const sources = Math.max(newest(join(web, "src")), existsSync(join(web, "public")) ? newest(join(web, "public")) : 0, statSync(join(web, "index.html")).mtimeMs, statSync(join(web, "package.json")).mtimeMs);
  if (existsSync(index) && statSync(index).mtimeMs >= sources) return;
  execSync("npm run build:web", { cwd: ROOT, stdio: "inherit" });
}

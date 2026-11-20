import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, ROOT_DIR, test } from "../helpers";
const read = (p: string) => readFileSync(join(ROOT_DIR, p), "utf8");
test("E10.5-2 the README says the app is unsigned and gives the one-time quarantine command", () => {
  const readme = read("README.md");
  const section = readme.slice(readme.indexOf("## The desktop app (macOS)"), readme.indexOf("## How a workflow is built"));
  expect(section.length).toBeGreaterThan(500);
  // Compared as flowing text: a sentence is what is promised, not where the line happens to wrap.
  const flow = section.replace(/\s+/g, " ");
  expect(flow).toContain("not signed or notarized");
  expect(flow).toContain("xattr -dr com.apple.quarantine /Applications/chief.app");
  expect(flow).toMatch(/warning is expected/);
  expect(flow).toMatch(/`chief serve` and the browser work exactly as before/);
  expect(flow).toContain("docs/desktop.md");
  // Exactly the one command, nowhere altered.
  expect(readme.match(/xattr -dr [^\n]*/g)).toEqual(["xattr -dr com.apple.quarantine /Applications/chief.app"]);
});
test("E10.6-1 the rules and docs state what the desktop app does, and say what is true of the build", () => {
  const agents = read("AGENTS.md");
  expect(agents).toContain("The home is `~/.chief/state`");
  expect(agents).toMatch(/the desktop app reads the same folder as the CLI/);
  expect(agents).toContain("`logs/`");
  expect(agents).toContain("`desktop/`");
  expect(agents).toMatch(/Nothing goes to `~\/Library\/Application Support`/);
  const plan = read("docs/dev-plan.md");
  expect(plan).not.toMatch(/planned and not built/);
  expect(plan).not.toContain("<userData>");
  // The one place the plan may name Application Support is to say it is not used.
  for (const line of plan.split("\n").filter((l) => l.includes("Application Support"))) expect(line, line.slice(0, 120)).toMatch(/Nothing lands in|nothing in|no `Library|moved|reversing|not Application|instead of|Nothing goes/i);
  // docs/desktop.md only names what exists.
  const doc = read("docs/desktop.md");
  for (const m of doc.matchAll(/^\| `((?:src|scripts)\/[^`]+)`/gm)) expect(existsSync(join(ROOT_DIR, "packages/desktop", m[1])), m[1]).toBe(true);
  expect(existsSync(join(ROOT_DIR, "packages/desktop/assets/icon.icns"))).toBe(true);
  const root = JSON.parse(read("package.json")).scripts;
  const desktop = JSON.parse(read("packages/desktop/package.json")).scripts;
  expect(root["build:desktop"]).toContain("package --workspace desktop");
  expect(desktop.build).toBeTruthy();
  expect(desktop.package).toBeTruthy();
  for (const cmd of doc.matchAll(/npm run ([\w:-]+)(?: --workspace (\w+))?/g)) {
    const scripts = cmd[2] === "desktop" ? desktop : root;
    expect(scripts[cmd[1]], cmd[0]).toBeTruthy();
  }
});

import { execSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { CLI, FAKE_CLAUDE, fake } from "../helpers";
import { expect, test, APP_DIR, ELECTRON_BIN, ROOT_DIR, VERSION } from "./helpers";
/**
 * The macOS desktop app (dev plan §3 "Desktop application", Phase 10): an Electron window over the
 * server it starts itself. Every case here launches the built app (`dist/desktop/app`), with the fake
 * agent CLI of the other suites. The cases run one after another in one worker (they share the build).
 */
test.describe.configure({ mode: "serial" });
test("E10.1-1 one window from the app's own server, and a second launch does not open another", async ({ desktop }) => {
  const d = await desktop.launch();
  expect(d.page.url()).not.toMatch(/^file:/);
  expect(await d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))).toEqual(["chief"]);
  await expect(d.page.getByRole("link", { name: "Runs" }).first()).toBeVisible({ timeout: 15_000 });
  const meta = await d.api("/api/meta");
  expect(meta.api).toBeGreaterThanOrEqual(14);
  expect(meta.adapters.length).toBeGreaterThan(0);
  // A second launch of the same app: no window, and the first one is still where it was.
  const url = d.page.url();
  const second = spawn(ELECTRON_BIN, [APP_DIR], { env: { ...desktop.env() }, stdio: "ignore" });
  const code = await new Promise<number | null>((res) => second.once("exit", res));
  expect(code).toBe(0);
  expect(d.app.windows().length).toBe(1);
  expect(d.page.url()).toBe(url);
  await expect.poll(() => d.log()).toContain("another chief window is already open");
  expect(await d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});
test("E10.1-2 the window comes back where it was, the menu is there, and the page has no node integration", async ({ desktop }) => {
  const first = await desktop.launch();
  // No Node in the page.
  expect(await first.page.evaluate(() => [typeof require, typeof process, typeof module].join(","))).toBe("undefined,undefined,undefined");
  expect(await first.app.evaluate(({ BrowserWindow }) => { const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(); return [p.nodeIntegration, p.contextIsolation]; })).toEqual([false, true]);
  // The menu.
  // The menu is the app's own, not Electron's default one (the whole of it is E10.8-2).
  const top = await first.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((i) => i.label));
  expect(top).toEqual(["chief", "File", "Edit", "View", "Window", "Help"]);
  // Move and resize, wait until the whole choice is in the database (not just the width: the move event
  // and the debounced save are separate, and y arrives last), quit, launch again. The rectangle is fitted
  // to this screen's work area — a window taller than the screen is clamped by macOS, and that is the
  // window manager being right, not the app being wrong (task 15.19).
  const work = await first.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const want = { x: work.x + 40, y: work.y + 40, width: Math.min(1040, work.width - 80), height: Math.min(700, work.height - 80) };
  await first.app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b), want);
  await expect.poll(async () => (await first.api("/api/drafts"))["desktop.window"]).toMatchObject(want);
  await first.quit();
  const again = await desktop.launch();
  await expect.poll(() => again.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())).toMatchObject(want);
});
/** Processes whose parent is `pid`: [pid, command]. */
const childrenOf = (pid: number): [number, string][] =>
  execSync("ps -axo pid=,ppid=,command=").toString().split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m && Number(m[2]) === pid).map((m) => [Number(m[1]), m[3]]);
const sidecarsOf = (pid: number) => childrenOf(pid).filter(([, cmd]) => /chief\.mjs serve --port 0 --no-open/.test(cmd));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
test("E10.2-1 one sidecar per app, on a port from its own stdout, over SSE", async ({ desktop, chief }) => {
  chief.importWorkflow(`name: one\nnodes:\n  - { id: a, type: agent, prompt: 'A ${fake({ sleep_ms: 1500, cost: 0.1, output: { answer: 42 } })}' }\n`);
  const d = await desktop.launch();
  const pid = d.app.process().pid!;
  const sidecars = sidecarsOf(pid);
  expect(sidecars.length).toBe(1);
  // The port in the window is the one the server printed on its stdout.
  expect(d.log()).toContain(`chief is serving on ${d.url}`);
  expect(d.log()).toContain(`server is up on ${d.url}`);
  // The server runs on the database of the home it was given, and the app's own log is beside it.
  expect(d.log()).toContain(`database ${join(chief.home, "chief.db")}`);
  expect(d.logPath).toBe(join(desktop.root, "logs", "chief.log"));
  // A run started in the window: running, then completed, without a reload (server-sent events).
  await d.page.goto(d.url + "/#/runs");
  await d.page.getByTestId("new-run-workflow").selectOption("one");
  await d.page.evaluate(() => { (window as any).__notReloaded = true; });
  await d.page.getByTestId("new-run-start").click();
  await expect(d.page.getByTestId("run-title")).toContainText("Run #1 · one");
  await expect(d.page.locator('[data-node-id="a"]')).toHaveAttribute("data-status", "running");
  await expect(d.page.getByTestId("run-status")).toHaveText("completed");
  expect(await d.page.evaluate(() => (window as any).__notReloaded)).toBe(true);
  expect(sidecarsOf(pid).map(([p]) => p)).toEqual(sidecars.map(([p]) => p));
});
test("E10.2-2 quitting mid-run leaves the run interrupted and no agent CLI behind", async ({ desktop, chief }) => {
  chief.importWorkflow(`name: slow\nnodes:\n  - { id: a, type: agent, prompt: 'A ${fake({ sleep_ms: 60000, output: { answer: 1 } })}' }\n`);
  const d = await desktop.launch();
  const pid = d.app.process().pid!;
  const sidecar = sidecarsOf(pid)[0][0];
  const started = await fetch(d.url + "/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflow: "slow" }) });
  const runId = (await started.json()).run.id;
  await expect.poll(() => chief.calls().length, { timeout: 15_000 }).toBe(1);
  const agent = chief.calls()[0].pid;
  expect(alive(agent)).toBe(true);
  const t0 = Date.now();
  // A run is in flight, so Quit asks first (15.3); this case is about what quitting does, so it answers.
  await d.app.evaluate(({ dialog }) => { (globalThis as any).__quitDetail = null; (dialog as any).showMessageBox = async (o: any) => { (globalThis as any).__quitDetail = o.detail; return { response: 0 }; }; });
  await d.quit();
  expect(Date.now() - t0).toBeLessThan(15_000);
  expect(d.log()).toContain("quitting with 1 run(s) in progress");
  await expect.poll(() => alive(sidecar)).toBe(false);
  await expect.poll(() => alive(agent), { timeout: 10_000 }).toBe(false);
  expect(existsSync(d.logPath)).toBe(true);
  // The next launch finds the run interrupted, and it can be resumed from there.
  const again = await desktop.launch();
  const run = await again.api(`/api/runs/${runId}`);
  expect(run.run.status).toBe("interrupted");
});
test("E10.2-3 a sidecar that dies is restarted, and the window says so", async ({ desktop, chief }) => {
  chief.importWorkflow(`name: quick\nnodes:\n  - { id: a, type: agent, prompt: 'A ${fake({ output: { ok: true } })}' }\n`);
  chief.run(["run", "quick"]);
  const d = await desktop.launch();
  await d.page.goto(d.url + "/#/runs");
  await expect(d.page.getByTestId("run-row-1")).toContainText("completed");
  const pid = d.app.process().pid!;
  const [old] = sidecarsOf(pid)[0];
  process.kill(old, "SIGKILL");
  await expect(d.page.getByTestId("desktop-status")).toContainText("The chief server stopped");
  // A new server, on a new port, and the window is on the page it was on, with the runs it had.
  await expect.poll(() => sidecarsOf(pid).map(([p]) => p).filter((p) => p !== old).length, { timeout: 30_000 }).toBe(1);
  await expect(d.page.getByTestId("run-row-1")).toContainText("completed", { timeout: 30_000 });
  expect(d.page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#\/runs/);
  expect(d.log()).toContain("server is back");
});
test("E10.2-4 a sidecar that cannot start shows its last lines, not a blank window", async ({ desktop }) => {
  // A file where the server's home should be: it cannot create the folder and ends at once.
  const blocked = join(desktop.root, "blocked-home");
  writeFileSync(blocked, "not a folder");
  const d = await desktop.launch({ env: { CHIEF_HOME: blocked }, waitForServer: false });
  await expect(d.page.getByTestId("desktop-status")).toContainText("could not start its server", { timeout: 30_000 });
  await expect(d.page.getByTestId("desktop-status-lines")).toContainText("EEXIST");
  await expect(d.page.getByTestId("desktop-status")).toContainText(d.logPath);
  expect(await d.page.locator("body").innerText()).not.toBe("");
  // It does not retry behind the person's back.
  await d.page.waitForTimeout(3500);
  expect(d.log().match(/starting .*chief\.mjs serve/g)?.length).toBe(1);
  expect(sidecarsOf(d.app.process().pid!).length).toBe(0);
});
test("E10.3-1 the app finds the agent CLI the login shell finds, and the same doctor agrees", async ({ desktop }) => {
  // A `claude` that only the person's own shell profile can find.
  const bin = join(desktop.root, "login-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const zshrc = join(desktop.fakeHome, ".zshrc");
  writeFileSync(zshrc, `export PATH="${bin}:${dirname(process.execPath)}:$PATH"\n`);
  // What Finder gives an app: no profile, a bare PATH, and no variable that points at the CLI.
  const finder = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", CHIEF_CLAUDE_BIN: undefined };
  const claudeOf = (doctor: any) => doctor.adapters.find((a: any) => a.name === "claude-code");
  const d = await desktop.launch({ env: finder });
  const inApp = claudeOf(await d.api("/api/doctor"));
  expect(inApp.found).toBe(true);
  expect(inApp.path).toBe(join(bin, "claude"));
  // The same check in a login shell of the same person.
  const env = { ...desktop.env() } as Record<string, string>;
  delete env.CHIEF_CLAUDE_BIN;
  const r = spawnSync("/bin/zsh", ["-ilc", `"${process.execPath}" "${CLI}" doctor --json`], { env, encoding: "utf8" });
  const inShell = claudeOf(JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))));
  expect(inApp).toMatchObject({ found: inShell.found, path: inShell.path, version: inShell.version, ok: inShell.ok });
  // The shell's environment withheld (a shell that cannot answer): a *fresh* home, so nothing found by
  // the first launch is remembered, reports the CLI missing — the shell is what found it, not luck.
  // (Since 15.14 a detected path is stored, so the same home would keep finding it; that is the point
  // of the feature, and this case must isolate the environment to stay honest.)
  await d.quit();
  const fresh = join(desktop.root, "bare-home");
  mkdirSync(fresh, { recursive: true });
  const bare = await desktop.launch({ env: { ...finder, SHELL: "/usr/bin/false", CHIEF_HOME: fresh } });
  expect(claudeOf(await bare.api("/api/doctor")).found).toBe(false);
  expect(bare.log()).toContain("environment from the app's own environment");
});
test("E10.4-1 links go to the default browser, and the window cannot be navigated away", async ({ desktop, chief }) => {
  const reply = 'Done, see [the docs](https://example.test/docs).\n\n```json\n{"status": "ok", "side_effects": [{"kind": "doc", "ref": "d1", "url": "https://example.test/d1", "how_to_undo": "delete d1"}]}\n```';
  chief.importWorkflow(`name: links\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'A ${fake({ text: reply })}' }\n`);
  const d = await desktop.launch();
  // The default browser is stubbed: what it would have been asked to open is recorded.
  await d.app.evaluate(({ shell }) => { (globalThis as any).__opened = []; (shell as any).openExternal = async (u: string) => { (globalThis as any).__opened.push(u); }; });
  const opened = () => d.app.evaluate(() => (globalThis as any).__opened as string[]);
  await fetch(d.url + "/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflow: "links" }) });
  await d.page.goto(d.url + "/#/runs/1");
  await expect(d.page.getByTestId("run-status")).toHaveText("completed");
  const home = d.page.url();
  await d.page.getByTestId("side-effects").getByRole("link", { name: "link" }).click();
  await expect.poll(opened).toEqual(["https://example.test/d1"]);
  const node = (await d.page.locator('[data-testid^="node-run-"][data-node-id="a"]').getAttribute("data-testid"))!.replace("node-run-", "");
  await d.page.getByTestId(`node-io-${node}`).click();
  await d.page.getByTestId("node-reply").getByRole("link", { name: "the docs" }).click();
  await expect.poll(opened).toEqual(["https://example.test/d1", "https://example.test/docs"]);
  expect(d.app.windows().length).toBe(1);
  expect(d.page.url()).toBe(home);
  // The window itself cannot be sent elsewhere. A mailto: link is refused and logged; a file: link never reaches
  // the app (Chromium itself refuses it from an http page); neither opens anything.
  await d.page.evaluate(() => { location.href = "https://example.test/away"; });
  await d.page.evaluate(() => {
    // Links as the page has them: an anchor that asks for a new window.
    for (const href of ["file:///etc/hosts", "mailto:someone@example.test"]) {
      const a = document.createElement("a");
      a.href = href; a.target = "_blank"; a.textContent = href; a.dataset.testid = "probe-link";
      document.body.append(a);
      a.click();
    }
  });
  await expect.poll(() => d.log()).toContain("refused to navigate the window to https://example.test/away");
  await expect.poll(() => d.log()).toContain("refused to open mailto:someone@example.test");
  expect(await opened()).toEqual(["https://example.test/d1", "https://example.test/docs"]);
  expect(d.app.windows().length).toBe(1);
  expect(d.page.url()).toBe(home);
});
test("E10.4-2 exporting a workflow asks where to save the file", async ({ desktop }) => {
  const d = await desktop.launch();
  await d.page.goto(d.url + "/#/designer");
  await d.page.getByTestId("btn-import").click();
  await d.page.getByTestId("import-yaml").fill("name: exported\nnodes:\n  - { id: only, type: agent, prompt: x }\n");
  await d.page.getByTestId("import-load").click();
  await d.page.getByTestId("btn-export").click();
  const shown = await d.page.getByTestId("export-yaml").inputValue();
  expect(shown).toContain("id: only");
  // The save dialog is stubbed: first the person cancels, then picks a file.
  const target = join(desktop.root, "chosen", "my-workflow.yaml");
  await d.app.evaluate(({ dialog }, target) => {
    const g = globalThis as any;
    g.__dialogs = [];
    g.__answers = [{ canceled: true }, { canceled: false, filePath: target }];
    (dialog as any).showSaveDialog = async (...a: any[]) => { g.__dialogs.push(a.map((x) => x?.defaultPath).filter(Boolean)[0]); return g.__answers.shift(); };
  }, target);
  const dialogs = () => d.app.evaluate(() => (globalThis as any).__dialogs as string[]);
  await d.page.getByTestId("export-download").click();
  await expect.poll(async () => (await dialogs()).length).toBe(1);
  expect(existsSync(target)).toBe(false);
  await d.page.getByTestId("export-download").click();
  await expect.poll(() => existsSync(target)).toBe(true);
  expect(readFileSync(target, "utf8")).toBe(shown);
  expect((await dialogs()).map((p) => p.split("/").pop())).toEqual(["exported.yaml", "exported.yaml"]);
  // Nothing was written to the downloads folder behind the dialog's back.
  expect(existsSync(join(desktop.fakeHome, "Downloads", "exported.yaml"))).toBe(false);
  expect(d.app.windows().length).toBe(1);
});
test("E10.5-3 the desktop app keeps its state in ~/.chief, not in Application Support or the checkout", async ({ desktop }) => {
  // A fresh home, and no CHIEF_HOME: the paths the person's own machine would use.
  const home = join(desktop.fakeHome, "fresh");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".zshrc"), "");
  const checkout = (name: string) => join(ROOT_DIR, name);
  const before = existsSync(checkout(".chief"));
  const d = await desktop.launch({ env: { HOME: home, CHIEF_HOME: undefined } });
  await d.page.goto(d.url + "/#/settings");
  await d.api("/api/doctor");
  const state = join(home, ".chief");
  expect(existsSync(join(state, "state", "chief.db"))).toBe(true);
  expect(existsSync(join(state, "logs", "chief.log"))).toBe(true);
  expect(existsSync(join(state, "desktop"))).toBe(true);
  // The workflow folders are made when a workflow needs one; where they will be is ~/.chief/workspace.
  expect((await d.api("/api/meta")).workspace_dir).toBe(join(state, "workspace"));
  await d.quit();
  // Nothing of the app's is in Application Support or anywhere else in the home, and nothing was written into the checkout.
  expect(readdirSync(home).filter((n) => n !== ".zshrc" && n !== ".chief").sort()).toEqual([]);
  expect(existsSync(checkout(".chief"))).toBe(before);
});
test("E10.5-1 the .dmg holds an ad-hoc signed app, and a copy of it outside the repo runs", async ({ desktop }) => {
  execSync("npm run package --workspace desktop", { cwd: ROOT_DIR, stdio: "pipe" });
  const app = join(ROOT_DIR, "dist/chief.app");
  const plist = (key: string) => execSync(`plutil -extract ${key} raw -o - "${join(app, "Contents/Info.plist")}"`).toString().trim();
  expect(plist("CFBundleIdentifier")).toBe("dev.chief.app");
  expect(plist("CFBundleName")).toBe("chief");
  expect(plist("CFBundleDisplayName")).toBe("chief");
  expect(plist("CFBundleExecutable")).toBe("chief");
  expect(plist("CFBundleShortVersionString")).toBe(VERSION);
  // The icon macOS shows in the Dock and in the About panel is chief's, not the one Electron ships.
  expect(execSync(`shasum "${join(app, "Contents/Resources", plist("CFBundleIconFile"))}"`).toString().split(" ")[0])
    .toBe(execSync(`shasum "${join(ROOT_DIR, "packages/desktop/assets/icon.icns")}"`).toString().split(" ")[0]);
  expect(existsSync(join(app, "Contents/Resources/server/chief.mjs"))).toBe(true);
  expect(readdirSync(join(app, "Contents/Resources/server/migrations")).filter((n) => n.endsWith(".sql")).length).toBeGreaterThanOrEqual(5);
  // Ad-hoc signed (no identity, no team) and intact; nothing else to sign: the server is JavaScript.
  const sig = spawnSync("codesign", ["-dv", app], { encoding: "utf8" }).stderr;
  expect(sig).toContain("Signature=adhoc");
  expect(sig).toContain("TeamIdentifier=not set");
  expect(spawnSync("codesign", ["--verify", "--deep", "--strict", app]).status).toBe(0);
  // The .dmg mounts and the app in it copies out.
  const work = mkdtempSync(join(tmpdir(), "chief-dmg-"));
  const mount = join(work, "mnt");
  mkdirSync(mount);
  const dmg = join(ROOT_DIR, "dist/chief.dmg");
  expect(statSync(dmg).size).toBeGreaterThan(1_000_000);
  execSync(`hdiutil attach "${dmg}" -mountpoint "${mount}" -nobrowse -readonly -quiet`);
  const copy = join(work, "Applications", "chief.app");
  try {
    expect(existsSync(join(mount, "chief.app/Contents/MacOS/chief"))).toBe(true);
    // The volume is an installer, not a folder holding one item: `Applications` beside the app is what a
    // person drags chief onto, and it has to be a link to the real folder, not an empty copy of one (15.31).
    expect(lstatSync(join(mount, "Applications")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(mount, "Applications"))).toBe("/Applications");
    mkdirSync(join(work, "Applications"));
    execSync(`ditto "${join(mount, "chief.app")}" "${copy}"`);
  } finally {
    spawnSync("hdiutil", ["detach", mount, "-quiet", "-force"]);
  }
  try {
    // Run from the copy, outside the repo: its server is the one inside the bundle.
    const d = await desktop.launch({ executable: join(copy, "Contents/MacOS/chief") });
    await expect(d.page.getByRole("link", { name: "Runs" }).first()).toBeVisible({ timeout: 20_000 });
    expect(d.log()).toContain(join(copy, "Contents/Resources/server/chief.mjs"));
    expect((await d.api("/api/meta")).adapters.length).toBeGreaterThan(0);
    // A release has no console to open: the developer tools are a development run's only (E10.8-2).
    const view = await d.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.find((i) => i.label === "View")!.submenu!.items.map((i) => i.label));
    expect(view).not.toContain("Toggle Developer Tools");
    await d.quit();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
test("E15.31-1 the .dmg is an installer: its name and background say drag, and Applications is beside the app", async () => {
  execSync("npm run package --workspace desktop", { cwd: ROOT_DIR, stdio: "pipe" });
  const dmg = join(ROOT_DIR, "dist/chief.dmg");
  const work = mkdtempSync(join(tmpdir(), "chief-dmg-layout-"));
  const mount = join(work, "mnt");
  const background = "dmg-background.png";
  mkdirSync(mount);
  try {
    execSync(`hdiutil attach "${dmg}" -mountpoint "${mount}" -nobrowse -readonly -quiet`);
    // The hint a person reads even when Finder never runs the layout script (CI, a headless session):
    // the volume's own name is in the window's title bar.
    const name = execSync(`diskutil info -plist "${mount}" | plutil -extract VolumeName raw -o - -`).toString().trim();
    expect(name.toLowerCase()).toContain("applications");
    // A volume with chief.app as its only item has nowhere to drop the app; the shortcut beside it is
    // the whole difference between a folder with one file and an installer window (15.31).
    expect(readdirSync(mount).filter((n) => !n.startsWith(".")).sort()).toEqual(["Applications", "chief.app"]);
    expect(existsSync(join(mount, "chief.app/Contents/MacOS/chief"))).toBe(true);
    // A link to the real folder, not a copy of it: dragging onto a copied folder would install nothing.
    expect(lstatSync(join(mount, "Applications")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(mount, "Applications"))).toBe("/Applications");
    // The picture in words, shipped inside the volume (the `.DS_Store` points at it there). It is a
    // committed asset, not generated by the build: the build must work where no browser can draw text.
    expect(statSync(join(ROOT_DIR, "packages/desktop/assets", background)).size).toBeGreaterThan(1_000);
    expect(existsSync(join(mount, ".background", background))).toBe(true);
    // Its size is the contract, and it is the part a person notices when it is wrong: Finder draws the
    // picture at its natural point size, which is its pixel size at 72 dpi, so a picture that is not the
    // window's size is cropped or padded. The first was 1200×800 for a 600×400 window and a person saw the
    // top-left quarter of it — twice, on 2026-11-20 (task 15.31).
    const size = execSync(`sips -g pixelWidth -g pixelHeight -g dpiWidth "${join(ROOT_DIR, "packages/desktop/assets", background)}"`).toString();
    const dim = (key: string) => Number(new RegExp(`${key}:\\s*([\\d.]+)`).exec(size)?.[1]);
    // 600×400 for the 600×400 window, and 72 dpi so that "natural size" means exactly that.
    expect([dim("pixelWidth"), dim("pixelHeight"), dim("dpiWidth")]).toEqual([600, 400, 72]);
    // And it has a source in the tree, so the words can be fixed without editing a binary.
    expect(existsSync(join(ROOT_DIR, "packages/desktop/assets/dmg-background.html"))).toBe(true);
    // Finder writes the layout into this file; without one, a mount would show the icons wherever it
    // likes. A build machine cannot write it, so its absence alone is not a failure — the name, the
    // shortcut and the picture above are the parts that must always be there.
    if (existsSync(join(mount, ".DS_Store"))) expect(statSync(join(mount, ".DS_Store")).size).toBeGreaterThan(0);
  } finally {
    spawnSync("hdiutil", ["detach", mount, "-quiet", "-force"]);
    rmSync(work, { recursive: true, force: true });
  }
});
/** Vite is the web package's dependency and need not be hoisted to the root. */
const VITE_BIN = join(dirname(createRequire(join(ROOT_DIR, "packages/web/package.json")).resolve("vite/package.json")), "bin/vite.js");
/** A port nothing holds: bound once to learn its number, then released for the process that will use it. */
const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((res) => probe.listen(0, "127.0.0.1", res));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((res) => probe.close(() => res()));
  return port;
};
test("E10.7-1 the development mode shows the given page and starts no server of its own", async ({ desktop }) => {
  // A stand-in for Vite: `npm run dev:desktop` runs the real one, but what the app must do with the URL is the same.
  const page = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>dev</title><p data-testid=\"dev-page\">from the dev server</p>");
  });
  await new Promise<void>((res) => page.listen(0, "127.0.0.1", res));
  const port = (page.address() as AddressInfo).port;
  try {
    const d = await desktop.launch({ env: { CHIEF_DESKTOP_DEV_URL: `http://127.0.0.1:${port}` } });
    expect(d.page.url()).toBe(`http://127.0.0.1:${port}/`);
    await expect(d.page.getByTestId("dev-page")).toHaveText("from the dev server");
    expect(d.log()).toContain("development mode");
    // The server belongs to the development loop: the app starts no sidecar of its own.
    expect(sidecarsOf(d.app.process().pid!).length).toBe(0);
    // Restart Server reloads this page instead of starting one.
    const reloaded = d.page.waitForEvent("load", { timeout: 15_000 });
    await d.app.evaluate(({ Menu }) => {
      const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
        for (const i of items) { if (i.label === "Restart Server") return i; const f = i.submenu && find(i.submenu.items); if (f) return f; }
      };
      find(Menu.getApplicationMenu()!.items)!.click();
    });
    await reloaded;
    await expect(d.page.getByTestId("dev-page")).toHaveText("from the dev server");
    expect(d.log()).toContain("development mode: reloading the page");
    expect(sidecarsOf(d.app.process().pid!).length).toBe(0);
  } finally {
    await new Promise<void>((res) => page.close(() => res()));
  }
});
test("E10.7-2 the development proxy reaches the API as the API's own host and origin", async () => {
  // The server's guard accepts only its own Host and Origin (packages/chief/src/server/app.ts); the
  // page is on Vite's port, so the proxy has to be the server's stand-in for both or every write is a 403.
  let seen: { host?: string; origin?: string } = {};
  const api = createServer((req, res) => {
    seen = { host: req.headers.host, origin: req.headers.origin };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((res) => api.listen(0, "127.0.0.1", res));
  const apiPort = (api.address() as AddressInfo).port;
  const webPort = await freePort();
  const web = spawn(process.execPath, [VITE_BIN, "--port", String(webPort), "--strictPort"], {
    cwd: join(ROOT_DIR, "packages/web"),
    env: { ...process.env, CHIEF_DEV_API: `http://127.0.0.1:${apiPort}` },
    stdio: "ignore",
  });
  try {
    const base = `http://127.0.0.1:${webPort}`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (web.exitCode !== null) throw new Error(`vite exited (code ${web.exitCode}) before it answered`);
      try { if ((await fetch(`${base}/`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`vite did not answer on ${base} within 60 s`);
      await new Promise((res) => setTimeout(res, 250));
    }
    // A write, sent with the page's origin, exactly as a browser at the Vite address would.
    const res = await fetch(`${base}/api/meta`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual({ host: `127.0.0.1:${apiPort}`, origin: `http://127.0.0.1:${apiPort}` });
  } finally {
    web.kill("SIGTERM");
    await new Promise<void>((res) => api.close(() => res()));
  }
});
test("E15.3-1 closing the window keeps chief, its runs and its scheduler alive until Quit", async ({ desktop, chief }) => {
  chief.importWorkflow(`name: slow\nnodes:\n  - { id: a, type: agent, prompt: 'A ${fake({ sleep_ms: 4000, output: { answer: 1 } })}' }\n`);
  chief.importWorkflow(`name: tick\nnodes:\n  - { id: a, type: agent, prompt: 'A ${fake({ output: { tick: true } })}' }\n`);
  // A tick every second: the scheduler inside the sidecar, with no window to show for it.
  const d = await desktop.launch({ env: { CHIEF_SCHEDULER_TICK_MS: "1000" } });
  const pid = d.app.process().pid!;
  const sidecar = sidecarsOf(pid)[0][0];
  const start = (workflow: string) => fetch(d.url + "/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflow }) }).then((r) => r.json());
  const slow = await start("slow");
  const page = d.page.url();
  // Closing the window is not quitting: the window goes away, the app and its server stay.
  await d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => [w.isVisible(), w.isDestroyed()]))).toEqual([[false, false]]);
  expect(alive(sidecar)).toBe(true);
  await expect.poll(() => d.log()).toContain("chief keeps running in the background");
  // The run finishes with no window open: the page is a viewer, the run is the server's.
  await expect.poll(async () => (await d.api(`/api/runs/${slow.run.id}`)).run.status, { timeout: 30_000 }).toBe("completed");
  // So does a scheduled run: the scheduler is in the sidecar, which is still running.
  const created = await fetch(d.url + "/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflow: "tick", cron: "* * * * *" }) });
  expect(created.status).toBe(201);
  await expect.poll(async () => (await d.api("/api/runs?workflow=tick")).filter((r: any) => r.status === "completed").length, { timeout: 60_000 }).toBe(1);
  // Clicking the Dock icon brings the same page back, not a new one.
  await d.app.evaluate(({ app }) => app.emit("activate"));
  await expect.poll(() => d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([true]);
  expect(d.page.url()).toBe(page);
  // Quit asks while a run is in flight; Keep Running leaves everything as it was.
  await start("slow");
  await d.app.evaluate(({ app, dialog }) => {
    (globalThis as any).__questions = 0;
    (dialog as any).showMessageBox = async () => { (globalThis as any).__questions++; return { response: 1 }; };
    app.quit();
  });
  await expect.poll(() => d.app.evaluate(() => (globalThis as any).__questions)).toBe(1);
  expect(d.log()).toContain("quit cancelled: 1 run(s) in progress");
  expect(alive(sidecar)).toBe(true);
  // Quit Anyway really quits, and the server goes with it.
  await d.app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 0 }); });
  await d.quit();
  await expect.poll(() => alive(sidecar), { timeout: 15_000 }).toBe(false);
  expect(d.log()).toContain("quitting with 1 run(s) in progress");
});
test("E15.112-1 closing the window from fullscreen gives up the Space and hides the window", async ({ desktop }) => {
  // Reported 2026-11-23: *"why everytime i closed the chief desktop app from the fullscreen mode, it just shows a
  // black screen … the close button should close the window instead of showing a black screen"*. On macOS a window
  // in native fullscreen owns a Space of its own, and hiding it there leaves the Space with nothing drawn in it.
  // The window has to leave fullscreen **first**, and the hide waits for macOS to finish the transition.
  const d = await desktop.launch();
  const winState = () => d.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { full: w.isFullScreen(), visible: w.isVisible(), destroyed: w.isDestroyed() };
  });
  await d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
  // The transition is asynchronous; wait for it rather than for a timer.
  await expect.poll(winState, { timeout: 15_000 }).toMatchObject({ full: true, visible: true });

  await d.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  // Out of the Space **and** hidden: with the old close path the window stayed fullscreen, which is the black screen.
  await expect.poll(winState, { timeout: 15_000 }).toEqual({ full: false, visible: false, destroyed: false });
  // Closing is still not quitting: the server answers and the app is alive.
  expect((await d.api("/api/meta")).api, "the server still answers").toBeGreaterThan(0);

  // The Dock icon brings it back — at a normal size, because the Space was given up rather than hidden inside.
  await d.app.evaluate(({ app }) => app.emit("activate"));
  await expect.poll(winState, { timeout: 15_000 }).toMatchObject({ full: false, visible: true });
  expect(d.page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
});

test("E10.8-1 the development loop runs chief, not Electron, in the menu bar and the Dock", async ({ desktop }) => {
  // macOS names the app menu and the Dock icon from the bundle, never from `app.setName` (src/main.ts), so
  // the loop launches a copy of Electron.app renamed chief, with chief's icon.
  const apiPort = await freePort();
  const webPort = await freePort();
  const dev = spawn(process.execPath, [join(ROOT_DIR, "packages/desktop/scripts/dev.ts")], {
    cwd: ROOT_DIR,
    env: { ...desktop.env(), CHIEF_DEV_API: `http://127.0.0.1:${apiPort}`, CHIEF_DEV_WEB_PORT: String(webPort) },
    stdio: "ignore",
  });
  const children: number[] = [];
  try {
    const logPath = join(desktop.root, "logs", "chief.log");
    const appLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
    await expect.poll(appLog, { timeout: 120_000 }).toContain(`development mode: showing http://127.0.0.1:${webPort}`);
    // Everything the loop started, still running under it: the app, the server and Vite.
    const kids = spawnSync("pgrep", ["-P", String(dev.pid)], { encoding: "utf8" });
    children.push(...(kids.stdout ?? "").trim().split("\n").map(Number).filter(Boolean));
    const commands = children.map((pid) => spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());
    expect(commands.length).toBeGreaterThanOrEqual(3);
    // The window is a chief.app, never an Electron.app.
    expect(commands.filter((c) => c.includes(join(ROOT_DIR, "dist/desktop-dev/chief.app/Contents/MacOS/chief"))).length).toBe(1);
    expect(commands.some((c) => c.includes("node_modules/electron/dist/Electron.app"))).toBe(false);
    // The bundle it launches: chief's name, chief's executable, chief's icon.
    const bundle = join(ROOT_DIR, "dist/desktop-dev/chief.app");
    const plist = (key: string) => execSync(`plutil -extract ${key} raw -o - "${join(bundle, "Contents/Info.plist")}"`).toString().trim();
    expect(plist("CFBundleName")).toBe("chief");
    expect(plist("CFBundleDisplayName")).toBe("chief");
    expect(plist("CFBundleExecutable")).toBe("chief");
    expect(existsSync(join(bundle, "Contents/MacOS/chief"))).toBe(true);
    expect(execSync(`shasum "${join(bundle, "Contents/Resources/icon.icns")}"`).toString().split(" ")[0])
      .toBe(execSync(`shasum "${join(ROOT_DIR, "packages/desktop/assets/icon.icns")}"`).toString().split(" ")[0]);
    // Changing the plist and the executable breaks Electron's signature, and Apple silicon refuses that.
    expect(spawnSync("codesign", ["--verify", "--deep", "--strict", bundle]).status).toBe(0);
  } finally {
    dev.kill("SIGTERM");
    await expect.poll(() => dev.signalCode !== null || dev.exitCode !== null, { timeout: 30_000 }).toBe(true);
    // Stopping the loop stops what it started: no app, server or Vite of its own is left behind.
    for (const pid of children) await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
  }
});
test("E10.8-2 the app menu is chief's own, and its items do what they say", async ({ desktop }) => {
  const d = await desktop.launch();
  const menu = await d.app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items
    .map((i) => [i.label, (i.submenu?.items ?? []).map((s) => s.label || `(${s.type})`)] as [string, string[]]));
  const top = Object.fromEntries(menu);
  expect(Object.keys(top)).toEqual(["chief", "File", "Edit", "View", "Window", "Help"]);
  // The app menu as macOS expects it: About, Settings…, Services, the Hide items and Quit.
  for (const want of ["About chief", "Settings…", "Services", "Hide chief", "Hide Others", "Show All", "Quit chief"]) expect(top.chief, want).toContain(want);
  // The app's own actions, and the window's.
  for (const want of ["Open in Browser", "Restart Server", "Close Window"]) expect(top.File, want).toContain(want);
  for (const want of ["Reload Page", "Actual Size", "Zoom In", "Zoom Out", "Toggle Full Screen"]) expect(top.View, want).toContain(want);
  for (const want of ["Minimize", "Zoom", "Bring All to Front"]) expect(top.Window, want).toContain(want);
  for (const want of ["Copy Diagnostics", "Reveal Log in Finder"]) expect(top.Help, want).toContain(want);
  // A staged (unpackaged) run may open the developer tools; the release menu does not have them (E10.5-1's
  // plist is the packaged app; here the presence is what a development run is allowed to have).
  expect(top.View).toContain("Toggle Developer Tools");
  // About chief is the native About panel (the `about` role), not an alert of the app's own.
  const about = await d.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) { if (i.label === "About chief") return i; const f = i.submenu && find(i.submenu.items); if (f) return f; }
    };
    const item = find(Menu.getApplicationMenu()!.items)!;
    return { role: item.role, click: typeof item.click };
  });
  expect(about).toEqual({ role: "about", click: "function" });
  // Settings… opens the Settings page of the app in the window.
  await d.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) { if (i.label === "Settings…") return i; const f = i.submenu && find(i.submenu.items); if (f) return f; }
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  });
  await expect(d.page.getByTestId("page-settings")).toBeVisible({ timeout: 15_000 });
  expect(d.page.url()).toBe(`${d.url}/#/settings`);
  // Copy Diagnostics puts what a bug report needs on the clipboard.
  await d.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const i of items) { if (i.label === "Copy Diagnostics") return i; const f = i.submenu && find(i.submenu.items); if (f) return f; }
    };
    find(Menu.getApplicationMenu()!.items)!.click();
  });
  const copied = await d.app.evaluate(({ clipboard }) => clipboard.readText());
  const electron = await d.app.evaluate(() => process.versions.electron);
  expect(copied).toContain(`chief ${VERSION}`);
  expect(copied).toContain(`Electron ${electron}`);
  expect(copied).toContain(`state ${desktop.root}`);
  expect(copied).toContain(`log ${d.logPath}`);
});

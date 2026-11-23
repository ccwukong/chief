import { app, BrowserWindow, clipboard, dialog, Menu, nativeTheme, screen, session, shell, type MenuItemConstructorOptions, type Rectangle } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chiefRoot, logFile, profileDir } from "./locations.ts";
import { Log } from "./log.ts";
import { loginEnvironment } from "./login-env.ts";
import { decideNavigation, decideWindowOpen, readDataUrl } from "./navigation.ts";
import { Sidecar, SidecarError } from "./sidecar.ts";
import { statusPage } from "./status-page.ts";
import { checkForUpdate, downloadDmg, type Release } from "./update.ts";
/**
 * The main process: a window over a `chief serve` it starts itself (dev plan §3 "Desktop
 * application"). The page is the web UI, loaded over HTTP like in a browser, so the REST API and
 * the SSE stream work unchanged; nothing in the window has Node.
 */
const root = chiefRoot();
// Electron's profile (cache, cookies, its own preferences) goes under ~/.chief too, not Application Support.
app.setPath("userData", profileDir(root));
app.setName("chief");
const log = new Log(logFile(root));
const WINDOW_KEY = "desktop.window";
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
let win: BrowserWindow | null = null;
let sidecar: Sidecar | null = null;
let serverEnv: NodeJS.ProcessEnv = process.env;
let lastPath = "/";
let quitting = false;
let confirmingQuit = false;
let restarts = 0;
let restarting = false;
/** Where the bundled server is: beside the app's resources when packaged, `server/` beside the app folder otherwise. */
function serverScript(): string {
  if (process.env.CHIEF_DESKTOP_SERVER) return process.env.CHIEF_DESKTOP_SERVER;
  const packaged = join(process.resourcesPath, "server", "chief.mjs");
  return existsSync(packaged) ? packaged : join(app.getAppPath(), "..", "server", "chief.mjs");
}
const origin = () => (sidecar?.port ? `http://127.0.0.1:${sidecar.port}` : "");
/**
 * `npm run dev:desktop` sets this to the Vite page. The window is then that page and starts no server
 * of its own: the development loop runs the server from source and the UI keeps its own hot reload.
 */
const devUrl = process.env.CHIEF_DESKTOP_DEV_URL?.trim() ?? "";
/** What the window is allowed to be: its own page's origin, which in a development run is Vite's. */
const appOrigin = () => origin() || (devUrl ? new URL(devUrl).origin : "");
/** The app's own page, wherever it is today: the server's URL, or Vite's in a development run. */
function homeUrl(): string {
  if (devUrl) return devUrl + (lastPath === "/" ? "" : lastPath);
  return origin() ? `${origin()}${lastPath}` : "";
}
function show(page: string) {
  win?.loadURL(page).catch(() => { /* replaced by a newer page while loading */ });
  if (win && !win.isVisible()) win.show();
}
/** A page of the app, e.g. `#/settings`, wherever the app is today: the server's URL or Vite's. */
function openInApp(path: string) {
  const base = devUrl || origin();
  if (base) show(`${base}${path}`);
}
// ── window geometry, kept in the database like the web UI's other choices about itself ──
interface Saved { x: number; y: number; width: number; height: number; maximized?: boolean }
async function loadBounds(): Promise<Saved | null> {
  try {
    const res = await fetch(`${origin()}/api/drafts`, { signal: AbortSignal.timeout(3000) });
    const v = (await res.json())?.[WINDOW_KEY];
    return v && [v.x, v.y, v.width, v.height].every(Number.isFinite) ? v : null;
  } catch { return null; }
}
async function saveBounds() {
  if (!win || win.isDestroyed() || !sidecar?.port) return;
  const b = win.getNormalBounds();
  const value: Saved = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
  try {
    await fetch(`${origin()}/api/drafts/${encodeURIComponent(WINDOW_KEY)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }), signal: AbortSignal.timeout(3000) });
  } catch { /* the server is gone; the next launch uses the default */ }
}
/** A saved position is used only when it is still on a screen (a disconnected monitor must not hide the window). */
function visible(b: Rectangle): boolean {
  const d = screen.getDisplayMatching(b).workArea;
  return b.x + b.width > d.x + 60 && b.x < d.x + d.width - 60 && b.y >= d.y - 5 && b.y < d.y + d.height - 60;
}
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 900, minWidth: 480, minHeight: 400, show: false, title: "chief", backgroundColor: nativeTheme.shouldUseDarkColors ? PAGE_DARK : PAGE_LIGHT,
    // The page is a plain web page: no Node, isolated context, sandboxed renderer.
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  const w = win;
  // The page's own <title> is "chief"; keep the window's title that regardless of the page.
  w.on("page-title-updated", (e) => e.preventDefault());
  let timer: NodeJS.Timeout | undefined;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => void saveBounds(), 400); };
  w.on("resize", later);
  w.on("move", later);
  w.on("closed", () => { win = null; });
  /**
   * Hide the window and leave chief running. Quit (⌘Q) is what stops the server.
   *
   * On macOS a window in **native fullscreen** does not live on the desktop: it has a Space of its own, and
   * `hide()` on a window inside that Space leaves the Space there with nothing drawn in it — a black screen
   * that only Quit gets rid of (reported 2026-11-23: *"why everytime i closed the chief desktop app from the
   * fullscreen mode, it just shows a black screen"*). So the Space has to be given up **first**, and the window
   * hidden after macOS has finished the transition: `setFullScreen(false)` is asynchronous and returns
   * immediately, so hiding straight after it hides a window that is still in the Space.
   */
  const hideToBackground = () => {
    w.hide();
    void saveBounds();
    log.note("window closed; chief keeps running in the background (runs and schedules continue until Quit)");
  };
  let leavingFullScreen = false;
  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    if (leavingFullScreen) return; // a second ⌘W while the Space is closing is not a second close
    if (!w.isFullScreen()) { hideToBackground(); return; }
    leavingFullScreen = true;
    // The animation takes a moment. The listener is `once` and also catches the case macOS drops the window out
    // of the Space on its own.
    w.once("leave-full-screen", () => {
      leavingFullScreen = false;
      // The window may have been asked to quit while the Space was closing.
      if (!win || win.isDestroyed() || quitting) return;
      hideToBackground();
    });
    w.setFullScreen(false);
  });
  const wc = w.webContents;
  wc.on("did-navigate", (_e, url) => remember(url));
  wc.on("did-navigate-in-page", (_e, url) => remember(url));
  // A click on a link, `window.open`, `target="_blank"`: external pages go to the default browser, nothing else is opened.
  wc.setWindowOpenHandler(({ url }) => {
    const d = decideWindowOpen(url, appOrigin());
    if (d.action === "external") { log.note(`opened in the default browser: ${d.url}`); void shell.openExternal(d.url); }
    else if (d.action === "allow") w.loadURL(url).catch(() => { /* replaced by a newer page */ });
    else if (d.action === "refuse") log.note(`refused to open ${url}: ${d.reason}`);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    const d = decideNavigation(url, appOrigin());
    if (d.action === "allow") return;
    e.preventDefault();
    log.note(`refused to navigate the window to ${url}: ${d.reason}`);
  });
  // Page-initiated reloads are the page's own; ⌘R reloads the page, never the process (the menu's role).
  return w;
}
function remember(url: string) {
  const app = appOrigin();
  if (!app || !url.startsWith(app)) return;
  lastPath = url.slice(app.length) || "/";
}
// ── downloads: a save dialog, never a silent write ──
function watchDownloads() {
  session.defaultSession.on("will-download", (event, item) => {
    const name = item.getFilename() || "download";
    const url = item.getURL();
    const data = url.startsWith("data:") ? readDataUrl(url) : null;
    if (!data) { item.setSaveDialogOptions({ defaultPath: join(app.getPath("downloads"), name) }); return; }
    // The designer's Download is a data: URL; the bytes are in hand, so write them where the person says.
    event.preventDefault();
    void (async () => {
      const r = await dialog.showSaveDialog(win ?? undefined as any, { defaultPath: join(app.getPath("downloads"), name) });
      if (r.canceled || !r.filePath) { log.note(`download of ${name} cancelled`); return; }
      try {
        mkdirSync(dirname(r.filePath), { recursive: true });
        writeFileSync(r.filePath, data);
        log.note(`saved ${name} to ${r.filePath}`);
      } catch (e: any) {
        log.note(`could not save ${name} to ${r.filePath}: ${e?.message}`);
        void dialog.showMessageBox({ type: "error", message: `Could not save ${name}`, detail: String(e?.message ?? e) });
      }
    })();
  });
}
// ── the server ──
function newSidecar(): Sidecar {
  return new Sidecar({
    runtime: process.execPath, script: serverScript(), env: serverEnv, log,
    onLost: (why) => void recoverFromLoss(why.lines),
  });
}
/**
 * The colour behind the page while it loads, so the window never flashes the other theme. It is known
 * for certain once the server has answered (`applyWindowTheme`); before that the system's own setting
 * is the best guess, and it is right for everyone who chose "system" (task 15.8).
 */
const PAGE_LIGHT = "#f6f7f9";
const PAGE_DARK = "#080c12";
/** Start the server, then show the app. A server that does not start gets a page that says why. */
async function boot(): Promise<boolean> {
  if (devUrl) {
    // The development loop owns the server; the window is only the page, so nothing is started or waited for.
    log.note(`development mode: showing ${devUrl} and starting no server of its own`);
    show(homeUrl());
    return true;
  }
  sidecar = newSidecar();
  const slow = setTimeout(() => show(statusPage({ title: "Starting chief…", message: "Starting the chief server.", busy: true })), 1500);
  try {
    await sidecar.start();
  } catch (e) {
    clearTimeout(slow);
    const lines = e instanceof SidecarError ? e.lines : [String((e as Error)?.message ?? e)];
    log.note(`the server did not start: ${(e as Error).message}`);
    show(statusPage({ title: "chief could not start its server", message: (e as Error).message, lines, logPath: log.file }));
    return false;
  }
  clearTimeout(slow);
  restarts = 0;
  const saved = await loadBounds();
  if (saved && win) {
    const b = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    if (visible(b)) win.setBounds(b); else win.setSize(b.width, b.height);
    if (saved.maximized) win.maximize();
  }
  show(`${origin()}${lastPath}`);
  await applyWindowTheme();
  return true;
}
/** The server ended on its own: say so in the window, start it again with a growing delay, and come back to the same page. */
async function recoverFromLoss(lines: string[]) {
  if (quitting || restarting) return;
  restarting = true;
  try {
    for (const wait of BACKOFF_MS) {
      show(statusPage({ title: "The chief server stopped", message: `Starting it again in ${wait / 1000} s. Runs that were in progress are marked interrupted and can be resumed.`, lines, logPath: log.file, busy: true }));
      await new Promise((r) => setTimeout(r, wait));
      if (quitting) return;
      sidecar = newSidecar();
      try {
        await sidecar.start();
        restarts++;
        log.note(`server is back (restart ${restarts})`);
        show(`${origin()}${lastPath}`);
        return;
      } catch (e) {
        lines = e instanceof SidecarError ? e.lines : [String((e as Error)?.message ?? e)];
      }
    }
    show(statusPage({ title: "chief could not bring its server back", message: "It stopped and did not start again after several tries.", lines, logPath: log.file }));
  } finally { restarting = false; }
}
/** Bring the window back, from the Dock icon, a second launch or the Dock's own menu. */
function revealWindow() {
  if (!win) {
    if (!app.isReady()) return;
    createWindow();
    show(homeUrl() || statusPage({ title: "chief", message: "Starting…", busy: true }));
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
/**
 * Quit stops the server, and with it any run in progress (it is marked interrupted and can be
 * resumed). So a run in flight is worth one question; sitting at a gate is not, since nothing is
 * being executed for it.
 */
async function confirmAndQuit(): Promise<void> {
  confirmingQuit = true;
  try {
    const running = await runningCount();
    if (!quitting && running > 0) {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        message: `${running} run${running === 1 ? " is" : "s are"} in progress.`,
        detail: "Quitting stops the chief server and interrupts " + (running === 1 ? "that run" : "those runs") + ". They can be resumed next time; schedules stop until chief runs again.",
        buttons: ["Quit Anyway", "Keep Running"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) {
        log.note(`quit cancelled: ${running} run(s) in progress`);
        return;
      }
    }
    quitting = true;
    if (running > 0) log.note(`quitting with ${running} run(s) in progress; they are marked interrupted`);
    await saveBounds();
    await sidecar?.stop();
    app.exit(0);
  } finally {
    confirmingQuit = false;
  }
}
/**
 * Keep the window's own background in the theme the person chose (Settings › Appearance). Only the
 * moment before the page paints can show it; the page itself is themed by the web UI.
 */
async function applyWindowTheme(): Promise<void> {
  const base = devUrl || origin();
  if (!base || !win || win.isDestroyed()) return;
  let theme = "system";
  try {
    const res = await fetch(`${base}/api/settings`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) theme = String(((await res.json()) as Record<string, unknown>).theme ?? "system");
  } catch { /* the server is not up yet: the system's setting is the guess */ }
  const dark = theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  win.setBackgroundColor(dark ? PAGE_DARK : PAGE_LIGHT);
}
async function restartServer() {
  if (restarting) return;
  if (devUrl) {
    // No server here to restart: the development loop owns it (and restarts it on a change).
    log.note("development mode: reloading the page; the server is the development loop's");
    win?.webContents.reload();
    return;
  }
  restarting = true;
  try {
    show(statusPage({ title: "Restarting the chief server…", message: "Stopping the server and starting it again.", busy: true }));
    await sidecar?.stop();
  } finally { restarting = false; }
  await boot();
}
// ── menu ──
/** What a bug report needs: the versions, where the state is, and which page the window shows. */
function diagnostics(): string {
  return [
    `chief ${app.getVersion()}`,
    `Electron ${process.versions.electron}, Node ${process.versions.node}, Chromium ${process.versions.chrome}`,
    `macOS ${process.getSystemVersion()}`,
    `state ${root}`,
    `log ${log.file}`,
    `app ${app.isPackaged ? `packaged (${app.getAppPath()})` : `development (${app.getAppPath()})`}`,
    `page ${homeUrl() || "(no server)"}`,
  ].join("\n");
}
function buildMenu() {
  const version = app.getVersion();
  // The native About panel, as every macOS app has it: chief's icon, name and version. No copyright
  // line and no person's name: the notice that has to travel with a copy of chief is in the app's own
  // `LICENSE` (`Contents/Resources/server/LICENSE`), which is where Apache-2.0 §4 asks for it. A name in
  // a menu adds nothing a licence file does not already say, and the licence is the copy that travels.
  app.setAboutPanelOptions({
    applicationName: "chief",
    applicationVersion: version,
    credits: "A local-first workflow orchestrator for agent CLIs. Apache-2.0.",
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: "chief",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Check for Updates…", click: () => void checkForUpdates({ manual: true }) },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => openInApp("/#/settings") },
        { type: "separator" },
        // Services is where the system puts the person's own services (an AppleScript, a shortcut).
        { role: "services", submenu: [] },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Open in Browser", accelerator: "Shift+CmdOrCtrl+O", click: () => { const url = homeUrl(); if (url) void shell.openExternal(url); } },
        { type: "separator" },
        { label: "Restart Server", accelerator: "Shift+CmdOrCtrl+R", click: () => void restartServer() },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload", label: "Reload Page" },
        { type: "separator" },
        { role: "resetZoom", label: "Actual Size" },
        { role: "zoomIn", label: "Zoom In" },
        { role: "zoomOut", label: "Zoom Out" },
        { type: "separator" },
        { role: "togglefullscreen" },
        // A development run may open them; a release has no console to open.
        ...(app.isPackaged ? [] : [{ type: "separator" } as const, { role: "toggleDevTools" } as const]),
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Copy Diagnostics", click: () => clipboard.writeText(diagnostics()) },
        { label: "Reveal Log in Finder", click: () => shell.showItemInFolder(log.file) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // No window open? The Dock icon is how chief is found and quit (right-click it), which is the whole
  // point of keeping the app running in the background.
  app.dock?.setMenu(Menu.buildFromTemplate([
    { label: "Open chief", click: () => revealWindow() },
    { type: "separator" },
    { role: "quit", label: "Quit chief" },
  ]));
}
/**
 * Ask GitHub for the newest release and offer it. This is the one request chief makes on its own: it
 * is in the README and on the landing page as such, and `CHIEF_NO_UPDATE_CHECK=1` turns it off.
 *
 * There is no silent install (see `update.ts`: Squirrel needs a Developer ID, and chief is signed
 * ad hoc). It downloads the `.dmg` the release publishes and opens it, so the same drag-to-Applications
 * window appears as on a first install — the update is one drag, not an invisible swap.
 */
let checking = false;
async function checkForUpdates(opts: { manual?: boolean } = {}): Promise<void> {
  if (checking) return;
  if (!opts.manual && process.env.CHIEF_NO_UPDATE_CHECK) return;
  const current = app.getVersion();
  checking = true;
  try {
    const release = await checkForUpdate(current, { url: process.env.CHIEF_UPDATE_URL || undefined });
    if (!release) {
      if (opts.manual) await dialog.showMessageBox({ type: "info", message: `chief ${current} is the newest version.`, detail: "You are up to date.", buttons: ["OK"] });
      return;
    }
    log.note(`chief ${release.version} is available (this is ${current})`);
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: `chief ${release.version} is available.`,
      detail: `You have ${current}. chief will download the installer and open it: drag chief onto Applications, replacing the old copy. Your workflows, runs and settings stay in ~/.chief and are not touched.`,
      buttons: ["Download and Open", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    await offerDownload(release);
  } catch (e: any) {
    // A check that cannot reach GitHub is not an error a person needs: the app works offline.
    log.note(`could not check for updates: ${e?.message ?? e}`);
    if (opts.manual) await dialog.showMessageBox({ type: "warning", message: "Could not check for updates.", detail: String(e?.message ?? e), buttons: ["OK"] });
  } finally {
    checking = false;
  }
}
/** Download to ~/Downloads and open it (which mounts the image and shows the installer window). */
async function offerDownload(release: Release): Promise<void> {
  const dir = app.getPath("downloads");
  try {
    const file = await downloadDmg(release, dir);
    log.note(`downloaded ${file.name} to ${dir}`);
    const err = await shell.openPath(file.path);
    if (err) throw new Error(err);
  } catch (e: any) {
    log.note(`could not download chief ${release.version}: ${e?.message ?? e}`);
    await dialog.showMessageBox({
      type: "warning",
      message: `Could not download chief ${release.version}.`,
      detail: `${e?.message ?? e}\n\nThe release page opens instead, where the installer can be downloaded by hand.`,
      buttons: ["Open Release Page", "OK"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => { if (response === 0) void shell.openExternal(release.page); });
  }
}
/**
 * How many runs are in flight right now (a run being driven, not one waiting at a gate or paused).
 * Read from the server, so it is the engine's own answer; 0 when the server is not up.
 */async function runningCount(): Promise<number> {
  const base = devUrl || origin();
  if (!base) return 0;
  try {
    const res = await fetch(`${base}/api/runs?limit=200`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return 0;
    const runs = (await res.json()) as { status: string }[];
    return runs.filter((r) => r.status === "running").length;
  } catch { return 0; }
}
// ── lifecycle ──
if (!app.requestSingleInstanceLock()) {
  // Two windows would be two servers and two schedulers over one database.
  log.note("another chief window is already open; leaving it to that one");
  app.exit(0);
} else {
  app.on("second-instance", () => {
    revealWindow();
  });
  app.on("before-quit", (e) => {
    if (quitting || confirmingQuit) return;
    e.preventDefault();
    void confirmAndQuit();
  });
  // Closing the window is not quitting: chief keeps its server, its runs and its scheduler until
  // Quit (⌘Q, the Dock's menu, or chief → Quit chief). Schedules that only fire while a window is
  // open would be no schedule at all, and a run in progress must not be cut by a closed window.
  app.on("window-all-closed", () => { /* macOS keeps the app running; nothing to do */ });
  app.on("activate", () => {
    if (!app.isReady()) return;
    if (!win) { createWindow(); show(homeUrl() || statusPage({ title: "chief", message: "Starting…", busy: true })); return; }
    revealWindow();
  });
  void app.whenReady().then(async () => {
    log.note(`chief ${app.getVersion()} starting (Electron ${process.versions.electron}, Node ${process.versions.node}); state in ${root}`);
    buildMenu();
    watchDownloads();
    createWindow();
    if (!devUrl) {
      // In a development run there is no sidecar to hand an environment to.
      const login = await loginEnvironment(process.env);
      log.note(`environment from ${login.from}`);
      serverEnv = login.env;
    }
    await boot();
    // After the server and the window: a check that fails or is slow must never delay chief starting.
    void checkForUpdates();
  });
}

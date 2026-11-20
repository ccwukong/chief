import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  // Playwright's five-second default is what a case waits for the page to catch up, and a loaded macOS
  // runner (four workers, each with a fake agent and a browser) needs more than that: a run page whose
  // record takes a second to arrive missed it twice on CI while passing every time locally. Fifteen
  // seconds is the allowance, not the assertion — a case that measures speed says so itself (`Date.now()`
  // in E15.23-1, an explicit `expect.poll` timeout, and so on), so the guarantees are still tested.
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 4,
  reporter: [["list"]],
  // Browser cases run headed (a visible Chromium window) by default; CHIEF_E2E_HEADLESS=1 hides it.
  // Cases that call the real agent CLI are opt-in: CHIEF_E2E_REAL=1.
  grepInvert: process.env.CHIEF_E2E_REAL ? undefined : /@real/,
  use: { browserName: "chromium", headless: !!process.env.CHIEF_E2E_HEADLESS, trace: "retain-on-failure" },
  projects: [
    { name: "cli-api", testIgnore: [/ui\.spec\.ts$/, /e2e\/desktop\//] },
    // Browser cases drag things with the mouse. Each file runs its cases one after another, so at
    // most two visible windows compete for the pointer; more than that made drags miss.
    { name: "browser", testMatch: /ui\.spec\.ts$/, fullyParallel: false },
    // The desktop app: Electron windows, one case after another (they share one build and one pointer).
    // The app is macOS only (dev plan §3), so Linux CI does not run these cases. The allowance is five
    // minutes because the .dmg cases build the image, and that build may now wait out a volume macOS is
    // still releasing and, failing that, make one fresh image (15.31) — patience the case never asserts.
    ...(process.platform === "darwin" ? [{ name: "desktop", testMatch: /e2e\/desktop\/.*\.spec\.ts$/, fullyParallel: false, timeout: 300_000 }] : []),
  ],
});

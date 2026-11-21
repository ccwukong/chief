import tseslint from "typescript-eslint";
import { plugin as local } from "./eslint.local-rules.js";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "e2e/.tmp/**", "playwright-report/**", "test-results/**"] },
  ...tseslint.configs.recommended,
  {
    plugins: { local },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // A comment cannot enforce anything; the rule can. Every TODO must name the task that owns it.
      "local/task-id-in-todos": "error",
    },
  },
  {
    // The web UI is a plain page in a browser and in the desktop window: it must not reach into the
    // engine, the store, Node or Electron. This is the renderer/main boundary (dev plan §3): the page
    // talks to the server over HTTP, and the desktop wrapper talks to the same server.
    files: ["packages/web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/packages/chief/**", "**/chief/src/**", "@chief/*"], message: "The web UI talks to the engine over HTTP only. Importing engine or store code would pull Node and the database into the page (see dev plan §3, \"Desktop application\")." },
          { group: ["node:*", "fs", "path", "os", "child_process", "crypto", "http", "https", "url"], message: "No Node built-ins in the page: it runs in the browser and in the desktop window, which has no Node." },
          // `**/desktop/src/**` as well as the package path: an import written relatively
          // (`../../desktop/src/main.ts`) does not contain "packages/desktop" and slipped through.
          { group: ["electron", "electron/*", "**/packages/desktop/**", "**/desktop/src/**"], message: "The page is the same in a browser and in the desktop window: it never imports Electron. The wrapper reaches it over HTTP and through the window's own events." },
        ],
      }],
    },
  },
  {
    // Timers are a design decision, so they live in one reviewed module (packages/web/src/polling.ts).
    files: ["packages/web/src/**/*.{ts,tsx}"],
    ignores: ["packages/web/src/polling.ts"],
    rules: { "local/no-raw-timers": "error" },
  },
  {
    // The mirror of the rule above: the engine never imports the UI.
    files: ["packages/chief/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/packages/web/**", "**/web/src/**", "@web/*"], message: "The engine is headless: it never imports the web UI. The two talk over HTTP (packages/chief/src/server/app.ts)." },
          { group: ["electron", "electron/*", "**/packages/desktop/**"], message: "The engine runs as the CLI, as `chief serve` and inside the desktop app's child process: it never imports Electron. The app starts it as a program (packages/desktop/src/sidecar.ts)." },
        ],
      }],
    },
  },
  {
    // The desktop wrapper starts the server as a program and talks to it over HTTP. It never links the
    // engine, the store or the page, so the two can be changed and shipped apart.
    files: ["packages/desktop/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/packages/chief/**", "**/chief/src/**", "**/packages/web/**", "**/web/src/**", "@chief/*"], message: "The desktop app runs the bundled server as a child process and talks to it over HTTP; it does not import the engine or the page." },
          { group: ["node:sqlite", "bun:sqlite"], message: "Only the server opens the database. The app asks it over HTTP, so there is one owner of chief.db." },
        ],
      }],
    },
  },
);

/**
 * Appearance: the colour theme and the text size (task 15.8).
 *
 * Both are choices about chief itself, so they live in chief's own settings (the `system` schema, the
 * same place as `notify`), not in browser storage: the desktop window and the browser show the same
 * theme, and clearing a browser's data does not lose it. `main.tsx` reads them together with the
 * drafts, before anything renders, so a dark window never flashes white.
 *
 * Where the theme is painted: <html data-theme="light|dark" data-theme-choice="light|dark|system">, and
 * `styles.css` holds both palettes. The `system` choice re-applies itself when macOS changes.
 */
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";
/**
 * The neutral ramp, in the five base colours shadcn offers. `neutral` is chief's default: pure grey, no blue cast.
 *
 * It is not a second theme system: light and dark still decide *contrast direction*, and this decides only the **tint**
 * of the greys. The token that carries it is `--color-slate-*`, whichever family is chosen (see `styles.css`).
 */
export const BASE_COLORS = { neutral: "Neutral", gray: "Gray", slate: "Slate", stone: "Stone", zinc: "Zinc" } as const;
export type BaseColor = keyof typeof BASE_COLORS;
/**
 * The text sizes. **`default` is 0.9 — the step that used to be called `small`** — because that is the size chief is meant
 * to ship at: at 1 it reads larger than a terminal and a code editor, which is not the size this app's own author asked
 * for as his default (asked 2026-11-22: *"the small font size … should be the default font size"*, and again when it had
 * been read as a page-level restyle). The other three keep the numbers they always had, so no one's text changes size
 * on upgrade: `large` is the old 1, `larger` the old 1.15, `largest` the old 1.3. Migration 007 moves the stored names.
 */
export const TEXT_SCALES = { default: 0.9, large: 1, larger: 1.15, largest: 1.3 } as const;
export type TextScale = keyof typeof TEXT_SCALES;

export const isTheme = (v: unknown): v is Theme => v === "light" || v === "dark" || v === "system";
export const isBaseColor = (v: unknown): v is BaseColor => typeof v === "string" && v in BASE_COLORS;
export const isTextScale = (v: unknown): v is TextScale => typeof v === "string" && v in TEXT_SCALES;

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** What `theme` comes to right now: `system` is resolved against the operating system. */
export const resolvedTheme = (theme: Theme): "light" | "dark" => (theme === "system" ? (systemDark() ? "dark" : "light") : theme);

// The choice in force. It lives here, not in a component: the system listener outlives every render and
// a page change must not leave it applying the choice of an unmounted component.
let current: { theme: Theme; scale: TextScale; base: BaseColor } = { theme: "system", scale: "default", base: "neutral" };

/** The choice in force, for anything that needs to read it back. */
export const appearanceNow = () => ({ ...current });

// Anything that draws itself in colours (the workflow canvas) asks for these instead of reading a class.
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

/** Paint `<html>` for a theme, a text scale and a base colour. */
export function applyAppearance(theme: Theme, scale: TextScale, base: BaseColor = "neutral"): void {
  current = { theme, scale, base };
  const html = document.documentElement;
  const dark = resolvedTheme(theme) === "dark";
  html.dataset.theme = dark ? "dark" : "light";
  html.dataset.themeChoice = theme;
  html.dataset.base = base;
  // Also the class shadcn's own components expect: a component pasted from its docs uses `dark:` variants, and those
  // need an ancestor with `.dark`. chief's own CSS never uses them — it reads `[data-theme]` — so this is only for
  // compatibility with pasted code, and it costs one class.
  html.classList.toggle("dark", dark);
  html.style.setProperty("--ui-scale", String(TEXT_SCALES[scale]));
  notify();
}

let following: MediaQueryList | null = null;
/**
 * Follow the operating system while the choice is `system` (it can change at sunset). One listener for
 * the app's lifetime, applying whatever choice is in force when it fires — which is why the choice is
 * module state and not a component's.
 */
export function followSystem(): void {
  if (following) return;
  following = window.matchMedia("(prefers-color-scheme: dark)");
  following.addEventListener("change", () => applyAppearance(current.theme, current.scale, current.base));
}

/** The theme as it is painted right now, for a component that must draw in those colours (React Flow's canvas). */
export function useAppTheme(): "light" | "dark" {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
    () => "light",
  );
}

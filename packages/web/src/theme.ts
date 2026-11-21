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
export const TEXT_SCALES = { small: 0.9, default: 1, large: 1.15, "extra-large": 1.3 } as const;
export type TextScale = keyof typeof TEXT_SCALES;

export const isTheme = (v: unknown): v is Theme => v === "light" || v === "dark" || v === "system";
export const isTextScale = (v: unknown): v is TextScale => typeof v === "string" && v in TEXT_SCALES;

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** What `theme` comes to right now: `system` is resolved against the operating system. */
export const resolvedTheme = (theme: Theme): "light" | "dark" => (theme === "system" ? (systemDark() ? "dark" : "light") : theme);

// The choice in force. It lives here, not in a component: the system listener outlives every render and
// a page change must not leave it applying the choice of an unmounted component.
let current: { theme: Theme; scale: TextScale } = { theme: "system", scale: "default" };

/** The choice in force, for anything that needs to read it back. */
export const appearanceNow = () => ({ ...current });

// Anything that draws itself in colours (the workflow canvas) asks for these instead of reading a class.
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

/** Paint `<html>` for a theme and a text scale. */
export function applyAppearance(theme: Theme, scale: TextScale): void {
  current = { theme, scale };
  const html = document.documentElement;
  html.dataset.theme = resolvedTheme(theme);
  html.dataset.themeChoice = theme;
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
  following.addEventListener("change", () => applyAppearance(current.theme, current.scale));
}

/** The theme as it is painted right now, for a component that must draw in those colours (React Flow's canvas). */
export function useAppTheme(): "light" | "dark" {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
    () => "light",
  );
}

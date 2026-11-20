import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";
import { loadDrafts } from "./ui";
import { applyAppearance, isTextScale, isTheme } from "./theme";

// Drafts and the appearance are read before anything renders: every field starts with its draft, and
// the window is already in its theme (no white flash in a dark one).
Promise.all([
  loadDrafts(),
  fetch("/api/settings").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
]).then(([, settings]) => {
  const s = settings as Record<string, unknown>;
  applyAppearance(isTheme(s.theme) ? s.theme : "system", isTextScale(s["font-size"]) ? s["font-size"] : "default");
  createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
});

/**
 * What the window may do with a URL. Pure, so it is decided in one place and tested without a window.
 *
 * The page is the server's own (`http://127.0.0.1:<port>`). A link to anywhere else is for the
 * default browser, only over http(s); every other scheme (`file:`, `mailto:`, `javascript:`) opens
 * nothing; and the window itself never leaves its own origin, so a link can never replace the app
 * with a web page.
 */
export type Decision =
  | { action: "allow" }
  | { action: "external"; url: string }
  | { action: "refuse"; reason: string };
const parse = (url: string): URL | null => { try { return new URL(url); } catch { return null; } };
/** The window itself is about to navigate to `url`. */
export function decideNavigation(url: string, appOrigin: string): Exclude<Decision, { action: "external" }> {
  const u = parse(url);
  if (!u) return { action: "refuse", reason: "not a URL" };
  if (u.origin === appOrigin) return { action: "allow" };
  return { action: "refuse", reason: `the window stays on ${appOrigin}; ${u.protocol}//${u.host} is outside it` };
}
/** A link with `target="_blank"` or a `window.open` asks for a new window. */
export function decideWindowOpen(url: string, appOrigin: string): Decision {
  const u = parse(url);
  if (!u) return { action: "refuse", reason: "not a URL" };
  if (u.origin === appOrigin) return { action: "allow" };
  if (u.protocol === "http:" || u.protocol === "https:") return { action: "external", url: u.toString() };
  return { action: "refuse", reason: `${u.protocol} links are not opened` };
}
/** The text and file name of a `data:` URL, which is how the designer's Download hands over a workflow. */
export function readDataUrl(url: string): Buffer | null {
  const m = /^data:([^,]*?),(.*)$/s.exec(url);
  if (!m) return null;
  return /;base64$/i.test(m[1]) ? Buffer.from(m[2], "base64") : Buffer.from(decodeURIComponent(m[2]), "utf8");
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/**
 * A page the app shows itself when there is no server to show: while it starts, when it did not
 * start (with what it printed last) and while it comes back. Never a blank window.
 */
export function statusPage(o: { title: string; message: string; lines?: string[]; logPath?: string; busy?: boolean }): string {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>chief</title>
<style>
  body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f6f7f9;color:#1c1f26}
  main{max-width:720px;padding:32px}
  h1{font-size:20px;margin:0 0 8px}
  p{margin:6px 0;line-height:1.5}
  pre{background:#11141a;color:#e6e8ee;padding:12px;border-radius:8px;overflow:auto;max-height:40vh;font-size:12px;white-space:pre-wrap}
  .path{font-family:ui-monospace,Menlo,monospace;font-size:12px}
</style></head><body><main data-testid="desktop-status">
<h1>${esc(o.title)}</h1>
<p>${esc(o.message)}</p>
${o.lines?.length ? `<pre data-testid="desktop-status-lines">${esc(o.lines.join("\n"))}</pre>` : ""}
${o.logPath ? `<p>Log: <span class="path">${esc(o.logPath)}</span> (Help menu, Reveal Log in Finder)</p>` : ""}
${o.busy ? "" : "<p>Choose File, Restart Server to try again.</p>"}
</main></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

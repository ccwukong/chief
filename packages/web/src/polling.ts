import { useEffect, useRef, useState } from "react";

/**
 * The one place the web UI may own a timer (`local/no-raw-timers`); the reason is in
 * docs/guardrails.md, rule 2. A missing "the data changed" signal belongs in the SSE stream or a
 * callback; a missing "the render is done" signal belongs in an effect; debouncing a keystroke is a
 * `setTimeout` with a real delay, and is allowed.
 */

/** Run `run` now, then every `everyMs`, for as long as the component is mounted. */
export function usePolling(run: () => void, everyMs: number | null, deps: readonly unknown[] = []) {
  // The interval calls whatever the latest render passed, so a new closure does not re-arm it.
  const latest = useRef(run);
  useEffect(() => { latest.current = run; });

  useEffect(() => {
    if (everyMs == null) return;
    let live = true;
    const tick = () => { if (live) latest.current(); };
    tick();
    const t = setInterval(tick, everyMs);
    return () => { live = false; clearInterval(t); };
  }, [everyMs, ...deps]);
}

/**
 * `reveal("node-run-12")` scrolls that element into view once the render that set it has been
 * painted. Call it in the same handler that opens the row: the effect runs after the row exists,
 * so there is nothing to race.
 */
export function useReveal(): (testid: string | null) => void {
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!target) return;
    document.querySelector(`[data-testid="${target}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTarget(null);
  }, [target]);
  return setTarget;
}

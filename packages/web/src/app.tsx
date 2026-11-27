import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { agentList, get } from "./api";
import { Designer } from "./pages/designer";
import { RunDetail } from "./pages/run-detail";
import { Runs } from "./pages/runs";
import { Settings } from "./pages/settings";
import { Schedules } from "./pages/schedules";
import { Assistant } from "./assistant";
import { useDraft, useHashRoute, useWindowWidth } from "./ui";
import { cn } from "./lib/utils";
import { usePolling } from "./polling";
import { Button } from "./components/ui/button";
import { Separator } from "./components/ui/separator";

/** The API level this page was built for (see API_LEVEL in the server). */
const REQUIRED_API = 18;

/**
 * The rail's destinations, in Figma's order: the working pages, then a divider, then the settings at the bottom.
 *
 * `SETTINGS` is apart because it is a different kind of place — you go there to change the app, not to do the work —
 * and Figma draws exactly that line: its gear sits at the foot of the rail under a rule (asked 2026-11-22).
 */
const NAV = [["runs", "Runs"], ["designer", "Designer"], ["schedules", "Schedules"]] as const;
const SETTINGS = ["settings", "Settings"] as const;
/** The rule that separates groups in the rail; it spans the glyph column, not the whole width. */
/**
 * The rule between groups in the rail.
 *
 * It needs room on **both** sides to read as a divider: with `my-1.5` and the nav's `gap-1` it sat flush under the item
 * above it and looked like an underline of that row (reported 2026-11-22: "look at the divider lines on the left navbar").
 * `mx-2` keeps it clear of the rail's edges, and `bg-border` is the one the rest of the app draws between surfaces.
 */
const RAIL_RULE = "mx-2 my-2.5 w-auto";

/**
 * A rail item when the sidebar is collapsed: the icon on top and its name underneath, at 64 px wide.
 *
 * The name is not decoration — an unlabelled gear could be anything, and chief bot's sparkle says nothing at all
 * to a new person (asked 2026-11-22: "it also needs short text description as figma's left nav bar shows").
 */
const NAV_ITEM_COMPACT = "flex-col gap-0.5 px-0 py-1.5 md:justify-center md:px-0 text-[10px] leading-none";
/** A caption that fits 64 px or wraps to a second line that breaks the layout: one line, no overflow. */
// `w-full` + `min-w-0` so a long name truncates inside the item instead of pushing past its highlight; `px-0.5` keeps a
// character of air on each side, so even a name at the limit does not touch the tinted edge.
const CAPTION = "block w-full min-w-0 truncate px-0.5 text-center leading-[1.1]";
/**
 * What "you are here" looks like in the rail: a tint and a dark label, not a filled accent block.
 *
 * A saturated pill around an icon and a two-line caption read as a button — or as an alert — among flat neighbours
 * (reported 2026-11-22 with the screenshot: "you really think this design is good?"). The tint says the same thing
 * without shouting, and the icon keeps its colour.
 */
/**
 * "You are here": one tinted block around the **icon and its name**, as Figma's rail does.
 *
 * It was briefly the icon alone, on the reasoning that a tint behind the caption made it look like a button. With the rail
 * widened to 72 px and the name inset, a single block for both reads as one selected destination rather than as a label
 * on a coloured tile — which is what was asked for on 2026-11-22: "include the text of the highlight background".
 */
const SELECTED = "bg-accent text-primary";
/**
 * The icon's own tile when an item is current: the highlight is on the **icon**, not on the icon and its caption.
 *
 * A background behind both turned the caption into a label on a coloured block, which is why the active item read as a
 * button — and at 64 px it wrapped out of its own highlight (asked 2026-11-22: "the active background should only apply
 * to the icon not including the text on the left nav bar"). In the expanded sidebar the whole row is still tinted,
 * because there the caption is *on* the row rather than under the glyph.
 */
/** The icon's box in the rail: it holds the glyph, not the highlight (the highlight covers the name too). */
const ICON_BOX = "flex items-center justify-center py-0.5 w-full";

/** Small outline icons (24 px grid, stroke drawn in the current text colour). */
const PATHS: Record<string, string> = {
  runs: "M4 6h16M4 12h16M4 18h10",
  designer: "M6 4h4v4H6zM14 16h4v4h-4zM8 8v4a4 4 0 0 0 4 4h2",
  schedules: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  gates: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  menu: "M4 6h16M4 12h16M4 18h16",
  collapse: "M11 17l-5-5 5-5M18 17l-5-5 5-5",
  expand: "M13 17l5-5-5-5M6 17l5-5-5-5",
  close: "M6 6l12 12M18 6L6 18",
};
/**
 * The icons' own scale, so they *look* the same size.
 *
 * A 24-unit viewBox does not make two glyphs the same weight: the gear's path spans 18 units and the menu's spans 16, so
 * at one box size the gear read noticeably larger — "the setting's icon looks larger than other icons, which is wrong"
 * (reported 2026-11-22). Each entry scales its path about the centre; the box stays the same, so nothing reflows.
 */
const ICON_SCALE: Record<string, number> = { settings: 0.86 };

const Icon = ({ name, className = "h-5 w-5" }: { name: string; className?: string }) => (
  <svg viewBox="0 0 24 24" className={`shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={PATHS[name]} transform={ICON_SCALE[name] ? `translate(12 12) scale(${ICON_SCALE[name]}) translate(-12 -12)` : undefined} />
  </svg>
);

/** The sparkle every AI feature in chief carries; the logo already means "you are home" at the top of the rail. */
function Sparkle() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 shrink-0">
      <path d="M8 1.5l1.4 3.9 3.9 1.4-3.9 1.4L8 12.1 6.6 8.2 2.7 6.8l3.9-1.4z" fill="currentColor" />
      <path d="M12.6 10.4l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" fill="currentColor" />
    </svg>
  );
}

/**
 * One rail item. Every destination and the agent are rendered by this, which is why they cannot drift apart.
 *
 * The highlight covers the icon **and** the name — one tinted block for a selected destination (asked 2026-11-22). The
 * name sits a hair under the glyph and is inset, so the block has air on both sides instead of ending at the letters.
 */
function RailItem({ text, icon, href, testid, captionTestid, collapsed, active, pressed, title, onClick, ...rest }: {
  text: string; icon: ReactNode; href?: string; testid: string; captionTestid: string; collapsed: boolean;
  active: boolean; pressed?: boolean; title?: string; onClick?: () => void;
  "aria-current"?: "page"; "aria-controls"?: string;
}) {
  const inner = (
    <>
      {/* The tint is the **item's**, caption included: "the active background should only apply to the icon" came first, and
          the person changed their mind the same day — "the text of the highlight background of the navbar item … should be
          included" (task 15.73, E15.73-1). The rail is one column of icons with names under them, and a tint that covered
          half an item read as a box around a glyph rather than as the place you are. */}
      <span className={collapsed ? ICON_BOX : "contents"}>{icon}</span>
      {collapsed
        ? <span data-testid={captionTestid} className={cn("hidden md:block", CAPTION)}>{text}</span>
        : <span className="truncate">{text}</span>}
    </>
  );
  const className = cn(
    "group flex items-center rounded-md text-sm font-medium transition-colors",
    collapsed ? NAV_ITEM_COMPACT : "gap-3 px-3 py-2",
    active ? SELECTED : "text-slate-700 hover:bg-slate-100",
  );
  return href
    ? <a href={href} data-testid={testid} title={title} onClick={onClick} className={className} {...rest}>{inner}</a>
    // `h-auto` because a Button's size brings `h-9` (36 px), and an icon plus a caption under it is taller than that:
    // the caption was clipped to a hairline (reported the same day). `cn` would not settle it — `h-9` and `h-auto` do
    // different jobs, not the same one — so the height is set here, where the item's shape is decided.
    : <Button variant="ghost" type="button" data-testid={testid} title={title} onClick={onClick} aria-pressed={pressed} className={cn("h-auto text-left", className)} {...rest}>{inner}</Button>;
}

export function App() {
  const route = useHashRoute();
  const page = route[0] ?? "runs";
  const [waiting, setWaiting] = useState<{ id: number; run_id: number; node_id: string | null; kind: string; reason: string; payload: any }[]>([]);
  /** Set when the server answering this page is older than the page itself. */
  const [stale, setStale] = useState(false);
  /**
   * The agent CLIs chief may use, from `/api/meta` (which offers only the ones found and switched on).
   * Empty means chief cannot run anything: said in a warning bar and counted on the bell, because a
   * person who has just installed chief would otherwise only find out when the first run was refused
   * (task 15.15).
   */
  const [adapters, setAdapters] = useState<string[] | null>(null);
  /** The CLIs detection found, switched on or not: it is what tells the two warning wordings apart. */
  const [found, setFound] = useState<string[]>([]);
  const routeKey = route.join("/");
  // Asked again when the page changes: Settings › Agent CLIs has the switch that fixes it, and coming
  // back to a page must not need a reload.
  useEffect(() => {
    get("/api/meta").then((m) => {
      setStale(!(Number(m?.api) >= REQUIRED_API));
      setAdapters(Array.isArray(m?.usable_adapters) ? m.usable_adapters : null);
      setFound(Array.isArray(m?.found_providers) ? m.found_providers : []);
    }).catch(() => { setStale(true); setAdapters(null); setFound([]); });
  }, [routeKey]);
  // Nothing to run a step with: either no CLI is installed, or every one that is was switched off. Both
  // stop a run, and both must be said — but they need different words, or an installed CLI looks missing.
  const noAgent = adapters !== null && adapters.length === 0;

  // The bell asks every couple of seconds: a gate can open in a run driven by another process.
  const loadGates = useCallback(() => { void get("/api/gates").then(setWaiting).catch(() => {}); }, []);
  usePolling(loadGates, 2500);

  /** Collapsed to icons on wide windows; kept across reloads (in chief's database, like drafts). */
  // Collapsed by default (asked 2026-11-22): on a 14-inch screen the working area matters more than the labels, and
  // every destination is one click away on the rail. A person who expands it keeps it expanded everywhere.
  /**
   * The rail does not expand: it is always the 64 px icon column, with each destination's name under its icon.
   *
   * It used to have a collapse/expand button, and on a 14-inch window it started collapsed anyway — so the button was
   * a choice nobody wanted, between a state they were already in and a state that pushed the working area aside
   * (asked 2026-11-22: "remove this, let the left navbar not expandable"). The names are permanent, which is what made
   * expanding unnecessary in the first place.
   */
  const collapsed = true;
  const width = useWindowWidth();
  /** The navigation opened over the page on narrow windows. */
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * chief bot is a place in the app, not a bubble over it: it opens as a panel of its own beside the page, and the
   * rail button is what opens it (asked 2026-11-22 — "their agent isn't a floating icon, it lives in a static panel
   * on the left … a main feature"). Whether it is open is kept, like the sidebar's width.
   */
  const [assistantOpen, setAssistantOpen] = useDraft("ui:assistant-open", false);
  /**
   * A page can ask for the panel by name (`chief:open-assistant`), rather than reaching for its rail item's DOM: the
   * Schedules page says that chief bot can write a schedule and offers to open it, and that is a thing about the app
   * shell, not about the rail. The panel's own state stays here, where it always was.
   */
  useEffect(() => {
    const on = () => setAssistantOpen(true);
    window.addEventListener("chief:open-assistant", on);
    return () => window.removeEventListener("chief:open-assistant", on);
  }, []);
  useEffect(() => setMenuOpen(false), [routeKey]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // The bell counts both: gates waiting for an answer, and the one thing that stops chief working at all.
  const badgeCount = waiting.length + (noAgent ? 1 : 0);
  const gatesHref = waiting.length ? `#/runs/${waiting[0].run_id}` : noAgent ? "#/settings" : "#/runs";
  const gatesText = noAgent && !waiting.length ? "No agent CLI configured" : `${waiting.length} gate${waiting.length === 1 ? "" : "s"} waiting`;
  const gatesTone = noAgent && !waiting.length ? "bg-red-100 text-red-900" : waiting.length ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-500";
  /** Hidden from sight, not from screen readers or tests, when the sidebar is collapsed on a wide window. */
  /**
 * A short name for the rail, shown under the icon even when it is collapsed — Figma labels each item, and an icon
 * on its own leaves a person guessing (asked 2026-11-22). "Chief bot" is the one that cannot be guessed at all.
 */
  const label = collapsed ? "md:sr-only" : "";

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Narrow windows: a top bar with the menu button instead of the sidebar. */}
      <header className="flex items-center gap-3 border-b border-slate-200 bg-surface px-4 py-2 md:hidden" data-testid="mobile-bar">
        <Button variant="outline" className="p-1.5" data-testid="nav-menu" aria-label="Open the navigation" aria-expanded={menuOpen} aria-controls="sidenav" onClick={() => setMenuOpen(true)}>
          <Icon name="menu" />
        </Button>
        <a href="#/runs" className="text-lg font-bold tracking-tight">chief</a>
        <a href={gatesHref} data-testid="gates-badge-bar" data-count={badgeCount} data-no-agent={noAgent || undefined} className={`ml-auto rounded px-2 py-1 text-xs font-semibold ${gatesTone}`}>{gatesText}</a>
      </header>
      {menuOpen && <div data-testid="nav-backdrop" className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={() => setMenuOpen(false)} />}

      <aside id="sidenav" data-testid="sidenav" data-collapsed={collapsed} data-open={menuOpen}
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-surface transition-transform md:static md:z-auto md:translate-x-0 md:transition-[width] ${menuOpen ? "translate-x-0 shadow-xl" : "-translate-x-full"} ${collapsed ? "md:w-[72px]" : "md:w-52"}`}>
        {/* The brand, and in the top right corner the icon button that collapses (or, on narrow windows, closes) the sidebar. */}
        <div className={`flex items-center justify-between gap-2 py-3 pl-5 pr-3 ${collapsed ? "md:flex-col md:px-0" : ""}`}>
          <a href="#/runs" className="flex items-center gap-2 py-1 text-lg font-bold tracking-tight" data-testid="brand" title="chief">
            <img src="/logo.svg" alt="" data-testid="brand-logo" className="h-7 w-7 shrink-0 rounded-md" /><span className={label}>chief</span>
          </a>
          <Button variant="outline" className="p-1.5 md:hidden" data-testid="nav-close" aria-label="Close the navigation" title="Close the navigation" onClick={() => setMenuOpen(false)}>
            <Icon name="close" className="h-4 w-4" />
          </Button>
        </div>
        <nav className={cn("flex flex-col gap-1", collapsed ? "md:px-1.5" : "px-3")} aria-label="Main">
          {/* Under the brand, a rule: the logo is not a destination (Figma draws the same line). */}
          <Separator className={RAIL_RULE} data-testid="rail-rule-top" />
          {NAV.map(([key, text]) => (
            <RailItem key={key} text={text} icon={<Icon name={key} className="h-[18px] w-[18px]" />}
              href={`#/${key}`} testid={`nav-${key}`} collapsed={collapsed} captionTestid={`nav-${key}-caption`}
              active={page === key && !assistantOpen} aria-current={page === key && !assistantOpen ? "page" : undefined}
              onClick={() => { if (assistantOpen) setAssistantOpen(false); }} />
          ))}
          {/* chief bot: a toggle, not a page. It sits with the destinations because it is one — the impression a floating
              bubble never gives (asked 2026-11-22). */}
          <RailItem text="Chief" icon={<Sparkle />} testid="nav-assistant" collapsed={collapsed}
            captionTestid="nav-assistant-caption" active={assistantOpen} pressed={assistantOpen} aria-controls="assistant-panel"
            title="chief bot" onClick={() => setAssistantOpen(!assistantOpen)} />
          {/* And another rule above Settings, which sits at the foot of the list. */}
          <Separator className={RAIL_RULE} data-testid="rail-rule-settings" />
          <RailItem text={SETTINGS[1]} icon={<Icon name="settings" className="h-[18px] w-[18px]" />}
            href={`#/${SETTINGS[0]}`} testid={`nav-${SETTINGS[0]}`} collapsed={collapsed} captionTestid={`nav-${SETTINGS[0]}-caption`}
            active={page === SETTINGS[0] && !assistantOpen} aria-current={page === SETTINGS[0] && !assistantOpen ? "page" : undefined}
            onClick={() => { if (assistantOpen) setAssistantOpen(false); }} />
        </nav>
      </aside>
      {/* chief bot, beside the page rather than over it: the run on show is its context, and in the designer the
          workflow on the canvas, which it can build and change. Closing it gives the page the whole width back. */}
      <Assistant open={assistantOpen} setOpen={setAssistantOpen}
        runId={page === "runs" && route[1] && Number.isInteger(Number(route[1])) ? Number(route[1]) : null}
        designing={page === "designer" ? route[1] ?? "" : null} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Wide windows: a slim bar with the notification center in its top right corner. */}
        <div data-testid="app-header" className="hidden h-12 shrink-0 items-center gap-3 border-b border-slate-200 bg-surface px-4 md:flex">
          {/* A page may put its own controls in this row, left of the bell (the designer does), so that it needs no second bar. */}
          <div id="page-bar" data-testid="page-bar" className="flex min-w-0 flex-1 items-center" />
          <Notifications waiting={waiting} noAgent={noAgent} found={found} route={routeKey} />
        </div>
        {noAgent && (
          <div data-testid="no-agent-cli" role="alert" data-found={found.length} className="border-b border-red-300 bg-red-50 py-2 text-sm text-red-900">
            <div className="page-width">
              {found.length ? <>
                <b>Every agent CLI is switched off, so chief cannot run a workflow.</b>{" "}
                {agentList(found)} {found.length === 1 ? "was" : "were"} found on this machine, so this is not an
                installation problem.{" "}
              </> : <>
                <b>No agent CLI is set up, so chief cannot run a workflow.</b> A step needs one of the agent CLIs
                (Claude Code, Codex, Cursor, Antigravity, OpenCode, Hermes) installed.{" "}
              </>}
              <a data-testid="no-agent-cli-settings" className="underline font-medium" href="#/settings">
                Open Settings › Agent CLIs
              </a>{" "}
              {found.length ? "to switch one on." : "to see what chief looked for."} You can still draw a workflow
              and read its runs.
            </div>
          </div>
        )}
        {stale && (
          <div data-testid="stale-server" role="alert" className="border-b border-red-300 bg-red-50 py-2 text-sm text-red-900">
            <div className="page-width"><b>The chief server that is running is older than this page.</b> Some things will not work (for example model lists and autosave) until you restart it: stop <code>chief serve</code> and start it again, then reload.</div>
          </div>
        )}
        <main className="min-h-0 flex-1 overflow-auto" data-testid={`page-${page}`}>
          {/* A run opens in a panel over the list (#/runs/37), so the list stays; #/runs/37/full is the run alone,
              which is also what a window too narrow for both shows. */}
          {page === "runs" && (route[1] && (route[2] === "full" || width < 1024)
            ? <RunDetail key={route[1]} id={Number(route[1])} />
            : <Runs openId={route[1] ? Number(route[1]) : null} />)}
          {page === "designer" && <Designer name={route[1] ?? null} />}
          {page === "schedules" && <Schedules />}
          {page === "settings" && <Settings />}
          {!["runs", "designer", "schedules", "settings"].includes(page) && <div className="p-6">Page not found.</div>}
        </main>
      </div>
    </div>
  );
}


/**
 * The notification center: a bell with the number of things that need a person — gates waiting for an
 * answer, and the one condition that stops chief working at all (no agent CLI). Each entry leads to
 * where it is answered or fixed.
 */
function Notifications({ waiting, noAgent, found, route }: { waiting: { id: number; run_id: number; node_id: string | null; kind: string; reason: string; payload: any }[]; noAgent: boolean; found: string[]; route: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [route]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as globalThis.Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
  }, [open]);
  const count = waiting.length + (noAgent ? 1 : 0);
  const text = noAgent && !waiting.length ? (found.length ? "Every agent CLI is switched off" : "No agent CLI configured") : `${waiting.length} gate${waiting.length === 1 ? "" : "s"} waiting`;
  const urgent = noAgent || waiting.length > 0;
  const what = (g: { reason: string; kind: string }) => (g.reason === "needs_input" ? "The step asks you" : g.reason === "budget" ? "Budget reached" : `${g.kind} gate`);
  return (
    <div ref={box} className="relative">
      <Button variant="ghost" type="button" data-testid="gates-badge" data-count={count} aria-haspopup="true" aria-expanded={open} title={text} onClick={() => setOpen(!open)}
        className={`relative flex items-center rounded-full p-2 ${noAgent ? "text-red-700 hover:bg-red-50" : waiting.length ? "text-amber-700 hover:bg-amber-50" : "text-slate-500 hover:bg-slate-100"} ${urgent ? `after:absolute after:-right-0.5 after:-top-0.5 after:flex after:h-4 after:min-w-4 after:items-center after:justify-center after:rounded-full after:px-1 after:text-2xs after:font-bold after:text-white after:content-[attr(data-count)] ${noAgent ? "after:bg-red-600" : "after:bg-amber-500"}` : ""}`}>
        <Icon name="gates" className="h-5 w-5" /><span className="sr-only">{text}</span>
      </Button>
      {open && (
        <div data-testid="notifications" role="menu" className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded border border-slate-200 bg-surface shadow-xl">
          <div className="border-b border-slate-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{urgent ? "Needs you" : "Notifications"}</div>
          {/* The thing that stops chief working at all comes first: it is not a gate, so it leads to Settings. */}
          {noAgent && (
            <a role="menuitem" href="#/settings" data-testid="notification-no-agent" onClick={() => setOpen(false)}
              className="block border-b border-red-200 bg-red-50 px-3 py-2 text-sm hover:bg-red-100">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-semibold text-red-800">{found.length ? "Every agent CLI is off" : "No agent CLI"}</span>
                <span className="ml-auto text-red-700">Runs cannot start</span>
              </div>
              <div className="mt-0.5 line-clamp-2 text-slate-800">
                {found.length
                  ? `${agentList(found)} ${found.length === 1 ? "was" : "were"} found. Switch one on in Settings › Agent CLIs.`
                  : "None is installed. Open Settings › Agent CLIs to see what chief looked for."}
              </div>
            </a>
          )}
          {!urgent && <div data-testid="notifications-empty" className="px-3 py-4 text-sm text-slate-500">Nothing is waiting for you.</div>}
          <div className="max-h-96 overflow-auto">
            {waiting.map((g) => (
              <a key={g.id} role="menuitem" href={`#/runs/${g.run_id}`} data-testid={`notification-${g.id}`} onClick={() => setOpen(false)}
                className="block border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-50">
                <div className="flex items-center gap-2 text-xs text-slate-500"><span className="font-semibold text-slate-700">Run #{g.run_id}</span>{g.node_id && <span>· {g.node_id}</span>}<span className="ml-auto">{what(g)}</span></div>
                <div className="mt-0.5 line-clamp-2 text-slate-800">{String(g.payload?.message ?? "Waiting for your answer.")}</div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

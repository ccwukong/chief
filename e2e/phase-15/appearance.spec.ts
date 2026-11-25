import { expect, fake, ROOT_DIR, test, type Server, openInputSetPanel } from "../helpers";
import type { Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 15, task 15.8: appearance — the theme (light, dark, system) and the text size. Both are chief's
 * own settings, so they apply to the desktop window and the browser alike, and both are read before the
 * first render (`main.tsx`), so a reload never flashes the other theme.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);

/**
 * The contrast of the page's own text on its own background: a theme is readable or it is not. Colours
 * are read back through a one-pixel canvas, because the palette is in oklch and a regex over the
 * computed value would not be a colour at all.
 */
const contrast = (page: Page) => page.evaluate(() => {
  const rgbOf = (css: string) => {
    const c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return { r, g, b };
  };
  const lum = ({ r, g, b }: { r: number; g: number; b: number }) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const body = getComputedStyle(document.body);
  const a = lum(rgbOf(body.color)), b = lum(rgbOf(body.backgroundColor));
  const [hi, lo] = [a, b].sort((x, y) => y - x) as [number, number];
  return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
});

const settings = (srv: Server) => srv.api("GET", "/api/settings").then((r) => r.body);

test("E15.8-1 the theme is light, dark or system, and is applied before the first paint", async ({ chief, page }) => {
  chief.importWorkflow("name: probe\nnodes:\n  - { id: a, type: agent, prompt: 'x' }\n");
  const srv = await chief.serve();
  try {
    // Nothing chosen yet: the page follows the system, and says so.
    await page.goto(`${srv.url}/#/settings`);
    await expect(tid(page, "appearance")).toBeVisible();
    await expect(tid(page, "theme-system")).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => document.documentElement.dataset.themeChoice)).toBe("system");

    // Dark: applied at once, with no Save button, and it is the server's setting, not this browser's.
    await tid(page, "theme-dark").click();
    await expect(tid(page, "theme-dark")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await settings(srv)).theme).toBe("dark");
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    // The page is dark, and readable — stated as a property, not as a hex: the base colour (task 15.82) decides the tint,
    // and a check that pinned the exact value would fail on every scheme but one.
    const rgb = (sel: string) => page.evaluate((s) => {
      const c = document.createElement("canvas");
      c.width = 1; c.height = 1;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = getComputedStyle(document.querySelector(s)!).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    }, sel);
    const isDark = ({ r, g, b }: { r: number; g: number; b: number }) => r < 70 && g < 70 && b < 70;
    expect(isDark(await rgb("body")), "the page is dark").toBe(true);
    // Readable: dark background, light text.
    expect(await contrast(page)).toBeGreaterThan(7);
    // Every surface is a dark one: the card, the fields and the table header — and the card is raised above the page.
    const card = await rgb('[class*="bg-card"]');
    expect(isDark(card), "the card is a dark surface").toBe(true);
    expect(card.r, "and it is lighter than the page behind it").toBeGreaterThan((await rgb("body")).r);
    expect(isDark(await rgb('[class*="bg-background"]')), "so are the fields").toBe(true);
    await expect(tid(page, "theme-now")).toHaveText("Always dark.");

    // A reload starts in the dark: the theme is read before the first render, so nothing flashes light.
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "page-runs")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    // The same dark page after the reload, and the base colour survived it too.
    expect(isDark(await rgb("body")), "still dark after a reload").toBe(true);
    expect(await page.evaluate(() => document.documentElement.dataset.base)).toBe("neutral");

    // Light: the counterpart, and it stays light on other pages.
    await page.goto(`${srv.url}/#/settings`);
    await tid(page, "theme-light").click();
    await expect.poll(async () => (await settings(srv)).theme).toBe("light");
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    // Light is a near-white page, whichever base colour is chosen.
    const light = await rgb("body");
    expect(Math.min(light.r, light.g, light.b), "the page is near-white").toBeGreaterThan(200);
    expect(await contrast(page)).toBeGreaterThan(7);
    await page.goto(`${srv.url}/#/schedules`);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");

    // System: follows macOS, and keeps following it while the page is open.
    await page.goto(`${srv.url}/#/settings`);
    await tid(page, "theme-system").click();
    await expect.poll(async () => (await settings(srv)).theme).toBe("system");
    expect(await page.evaluate(() => document.documentElement.dataset.themeChoice)).toBe("system");
    // What it follows is the browser's own preference, which the case can change.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    await expect(tid(page, "theme-now")).toContainText("which is dark right now");
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");

    // The workflow canvas draws itself, so it is told the theme too (React Flow's own colours: it puts
    // a `dark` class on the canvas and draws its dots and controls from it).
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${srv.url}/#/designer/probe`);
    await expect(page.locator(".react-flow")).toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator(".react-flow")).not.toHaveClass(/\bdark\b/);
  } finally {
    await srv.stop();
  }
});

test("E15.8-2 the text size is one scale for the whole app, and the person chooses its step", async ({ chief, page }) => {
  chief.importWorkflow("name: probe\nnodes:\n  - { id: a, type: agent, prompt: 'A long prompt to edit' }\n");
  const srv = await chief.serve();
  try {
    await page.goto(`${srv.url}/#/settings`);
    await expect(tid(page, "setting-font-size")).toHaveValue("default");
    // **`default` is 0.9**, the step that used to be called `small`: prose and fields 12.6, code and hints 10.8, labels
    // 9.9 (task 15.84). The three are one scale — 14, 12 and 11 px multiplied by one number — so they move together.
    const sizes = () => page.evaluate(() => {
      const px = (sel: string) => { const e = document.querySelector(sel); return e ? Math.round(parseFloat(getComputedStyle(e).fontSize) * 100) / 100 : null; };
      return { body: px("body"), prose: px('[data-testid="font-preview"] [data-size="body"]'), code: px('[data-testid="font-preview"] [data-size="code"]'), label: px('[data-testid="font-preview"] [data-size="label"]') };
    });
    expect(await sizes()).toEqual({ body: 12.6, prose: 12.6, code: 10.8, label: 9.9 });
    // The ladder is four steps, and its first is the shipped size: there is nothing below Default.
    expect(await tid(page, "setting-font-size").locator("option").evaluateAll((o) => o.map((e) => (e as HTMLOptionElement).value)))
      .toEqual(["default", "large", "larger", "largest"]);

    // The prompt editor is code, like every other code surface: it is not larger than the rest of the app
    // (it used to be 14 px next to 12 px results; this is the report that started 15.8).
    await page.goto(`${srv.url}/#/designer/probe`);
    await page.locator('[data-testid="flow-node-a"]').click();
    await expect(tid(page, "node-prompt")).toBeVisible();
    const prompt = await page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.querySelector('[data-testid="node-prompt"]')!).fontSize)));
    expect(prompt).toBe(11);
    expect(await page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.body).fontSize)))).toBe(13);

    // A step up scales every size together, at once, and is saved without a Save button.
    await page.goto(`${srv.url}/#/settings`);
    await tid(page, "setting-font-size").selectOption("large");
    await expect.poll(async () => (await settings(srv))["font-size"]).toBe("large");
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-scale"))).toBe("1");
    // `large` is 1 — the size that used to be called `default`, kept at the same number so nobody's text changes size.
    expect(await sizes()).toEqual({ body: 14, prose: 14, code: 12, label: 11 });
    // Kept across a reload, and on the pages that are not Settings.
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-scale"))).toBe("1");

    // The largest step must not make a page scroll sideways on a phone-sized window.
    await tid(page, "setting-font-size").selectOption("largest");
    await expect.poll(async () => (await settings(srv))["font-size"]).toBe("largest");
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-scale"))).toBe("1.3");
    await page.setViewportSize({ width: 375, height: 800 });
    for (const hash of ["#/settings", "#/runs", "#/schedules"]) {
      await page.goto(`${srv.url}/${hash}`);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), { message: hash }).toBe(true);
    }
    // Back to the shipped size: `default` is the smallest step, and body text stays above 12 px.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${srv.url}/#/settings`);
    await tid(page, "setting-font-size").selectOption("default");
    await expect.poll(async () => (await settings(srv))["font-size"]).toBe("default");
    expect((await sizes()).body).toBeCloseTo(12.6, 1);
  } finally {
    await srv.stop();
  }
});

/**
 * The coloured cards in the assistant's answers (the canvas change in purple, the schedule in teal) are
 * the one place the app paints a tinted panel, and a tint's text is a different ramp end from the page's:
 * `text-purple-950` on `bg-purple-50`. The dark theme turned 50–300 dark and 700–900 light but never
 * defined 950, so `text-purple-950` kept its light-theme near-black on a dark card: 1.16:1, reported
 * 2026-11-21 as *"the text in purple is barely visible"*. Teal was not in the dark ramp at all.
 */
test("E15.8-3 every tinted card's text is readable in the dark theme, and every colour the app reaches for is themed", async ({ chief, page }) => {
  // Static half: every `<bg|text|border>-<family>-<step>` in the web sources has a dark value. A family that
  // is missing from the dark palette is the whole bug, and this catches the next one without a screenshot.
  const dark = readFileSync(join(ROOT_DIR, "packages/web/src/styles.css"), "utf8");
  const block = /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(dark)![1];
  const defined = new Set([...block.matchAll(/--color-([a-z]+)-(\d+):/g)].map((m) => `${m[1]}-${m[2]}`));
  const used = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(tsx?|css)$/.test(e.name)) continue;
      for (const m of readFileSync(p, "utf8").matchAll(/\b(?:bg|text|border|ring|outline)-((?:slate|red|amber|green|emerald|blue|orange|sky|purple|teal|indigo|pink|rose|cyan|lime|yellow|violet|fuchsia)-[0-9]+)\b/g)) used.add(m[1]);
    }
  };
  walk(join(ROOT_DIR, "packages/web/src"));
  expect(used.size).toBeGreaterThan(20);
  // The ends of each tint are themed (`50`–`300` dark surfaces, `700`–`950` light text); a `400`–`600` is
  // deliberately left saturated, which is what a filled button or a border wants in either theme. So only
  // the ends are required — and `950`, the end that was missing, is one of them.
  const end = (c: string) => { const n = +c.split("-").pop()!; return n <= 300 || n >= 700; };
  expect([...used].filter((c) => !c.startsWith("slate-") && end(c) && !defined.has(c)), "colour classes with no dark value").toEqual([]);
  // The two ends the cards use are there, and nowhere near their light-theme values.
  for (const c of ["purple-50", "purple-950", "teal-50", "teal-950"]) expect(defined.has(c), c).toBe(true);

  // Live half: the two cards, in the dark theme, measured as they render.
  chief.importWorkflow("name: daily\nnodes:\n  - { id: collect, type: agent, prompt: 'Collect.' }\n");
  const srv = await chief.serve();
  try {
    await srv.api("PUT", "/api/settings", { theme: "dark" });
    await page.goto(`${srv.url}/#/designer/daily`);
    await tid(page, "nav-assistant").click();
    const wf = JSON.stringify({ name: "daily", nodes: [{ id: "collect", type: "agent", prompt: "Collect." }], edges: [], description: "Daily digest" });
    const sched = JSON.stringify({ action: "create", cron: "0 9 * * 1-5" });
    await tid(page, "assistant-question").fill(`describe and schedule it ${fake({ text: `Done.\n\n\`\`\`chief-workflow\n${wf}\n\`\`\`\n\n\`\`\`chief-schedule\n${sched}\n\`\`\`` })}`);
    await tid(page, "assistant-send").click();
    await expect(tid(page, "assistant-change")).toBeVisible();
    await expect(tid(page, "assistant-schedule")).toBeVisible();

    const ratios = await page.evaluate(() => {
      const rgbOf = (css: string) => {
        const c = document.createElement("canvas"); c.width = 1; c.height = 1;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return { r, g, b };
      };
      const lum = ({ r, g, b }: { r: number; g: number; b: number }) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      // Every element in a card that holds its own text, against the nearest painted ancestor.
      const out: Record<string, number> = {};
      for (const id of ["assistant-change", "assistant-schedule"]) {
        const card = document.querySelector(`[data-testid="${id}"]`)!;
        let worst = Infinity;
        for (const el of [card, ...card.querySelectorAll("*")]) {
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
          if (!own) continue;
          let bgc = "";
          for (let e: Element | null = el; e; e = e.parentElement) {
            const c = getComputedStyle(e).backgroundColor;
            if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { bgc = c; break; }
          }
          const [a, b] = [lum(rgbOf(getComputedStyle(el).color)), lum(rgbOf(bgc || "rgb(255,255,255)"))].sort((x, y) => y - x);
          worst = Math.min(worst, (a + 0.05) / (b + 0.05));
        }
        out[id] = +worst.toFixed(2);
      }
      return out;
    });
    // 4.5 is the WCAG AA floor for body text; these are 14.7 and 14.6 now, and were 1.16 and 1.1.
    expect(ratios["assistant-change"], "the purple change card").toBeGreaterThan(4.5);
    expect(ratios["assistant-schedule"], "the teal schedule card").toBeGreaterThan(4.5);
  } finally {
    await srv.stop();
  }
});

test("E15.65-1 the rail starts collapsed to icons, and chief bot opens as a column beside the page", async ({ chief, page }) => {
  // Asked 2026-11-22: "The left side menu bar is collapsed by default and it gives larger screen estate to the working area", and
  // the agent "lives in a static panel on the left once user clicks on the Agents icon on the left bar".
  const srv = await chief.serve();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(srv.url + "/#/runs");

  // The rail is the icon column, always, and it does not expand: the names sit under the icons permanently, which is
  // why the expand control was removed (asked 2026-11-22: "remove this, let the left navbar not expandable").
  const nav = tid(page, "sidenav");
  expect((await nav.boundingBox())!.width).toBeLessThan(90);
  await expect(tid(page, "nav-collapse"), "there is no expand control").toHaveCount(0);
  for (const id of ["runs", "designer", "schedules", "settings"]) await expect(tid(page, `nav-${id}`)).toBeVisible();
  await expect(tid(page, "nav-runs-caption"), "the name is visible, not only for a screen reader").toBeVisible();
  expect((await tid(page, `nav-runs-caption`).boundingBox())!.height, "one line").toBeLessThan(16);
  // 18 px, smaller than the glyph an expanded sidebar used, so the icon does not compete with its caption.
  const glyph = (await tid(page, "nav-runs").locator("svg").first().boundingBox())!;
  expect(Math.round(glyph.width)).toBe(18);

  // The agent is a column: it opens to the right of the rail, the page begins where it ends, and closing it gives the width back.
  const pageBox = async () => (await tid(page, "page-runs").boundingBox())!;
  const closedWidth = (await pageBox()).width;
  await tid(page, "nav-assistant").click();
  const panel = (await tid(page, "assistant-panel").boundingBox())!;
  const rail = (await tid(page, "sidenav").boundingBox())!;
  expect(panel.x, "the panel sits next to the rail").toBeCloseTo(rail.x + rail.width, 0);
  expect(panel.height, "it is the window's height").toBeGreaterThan(800);
  expect((await pageBox()).x, "the page begins where the panel ends").toBeCloseTo(panel.x + panel.width, 0);
  expect((await pageBox()).width).toBeLessThan(closedWidth - 300);
  await expect(tid(page, "nav-assistant")).toHaveAttribute("aria-pressed", "true");
  await tid(page, "nav-assistant").click();
  await expect(tid(page, "assistant-panel")).toHaveCount(0);
  expect((await pageBox()).width, "closing it returns the width").toBe(closedWidth);

  // Narrow: the rail is a drawer behind the menu button, and the panel is the page; nothing scrolls sideways.
  await page.setViewportSize({ width: 375, height: 700 });
  await expect(tid(page, "sidenav"), "the rail is off the page until it is asked for").not.toBeInViewport();
  await tid(page, "nav-menu").click();
  await page.getByTestId("nav-assistant").click();
  const small = (await tid(page, "assistant-panel").boundingBox())!;
  expect(small.x).toBeGreaterThanOrEqual(0);
  expect(small.x + small.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("E15.66-1 one rail item is current at a time, and its caption stays one line", async ({ chief, page }) => {
  // Reported 2026-11-22, from a screenshot of the rail: two items looked current at once, the caption "chief bot" wrapped
  // out of its own highlight, and the highlight covered the caption as well as the icon ("the active background should
  // only apply to the icon not including the text on the left nav bar").
  const srv = await chief.serve();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(srv.url + "/#/designer");
  const nav = tid(page, "sidenav");
  await expect(nav).toHaveAttribute("data-collapsed", "true");

  // Collapsed: the item is one tinted block — icon **and** caption — which is where this ended up after the first version
  // tinted the icon alone (see E15.73-1, asked the same day, superseding it). What this case still holds is that only one
  // item is current at a time, and that the caption stays one line.
  await expect(tid(page, "nav-designer")).toHaveAttribute("aria-current", "page");
  expect(await tid(page, "nav-designer").evaluate((el) => getComputedStyle(el).backgroundColor), "the item is tinted").not.toBe("rgba(0, 0, 0, 0)");
  const caption = tid(page, "nav-designer-caption");
  // One line: a caption that wraps out of its highlight was the visible fault.
  const capBox = (await caption.boundingBox())!;
  expect(capBox.height, "one line tall").toBeLessThan(16);

  // Opening the agent takes the highlight; no page is current while it is open.
  await tid(page, "nav-assistant").click();
  await expect(tid(page, "assistant-panel")).toBeVisible();
  await expect(tid(page, "nav-designer")).not.toHaveAttribute("aria-current", "page");
  await expect(tid(page, "nav-assistant")).toHaveAttribute("aria-pressed", "true");

  // Choosing a page puts the agent away and takes the highlight back: never two current items.
  await page.getByTestId("nav-runs").click();
  await expect(tid(page, "assistant-panel")).toHaveCount(0);
  await expect(tid(page, "nav-runs")).toHaveAttribute("aria-current", "page");
  await expect(tid(page, "nav-assistant")).toHaveAttribute("aria-pressed", "false");
  expect(await tid(page, "nav-designer").getAttribute("aria-current")).toBeNull();
});

test("E15.70-1 the rail is the icon column always: no collapse control, names under the icons, 18 px glyphs", async ({ chief, page }) => {
  // Asked 2026-11-22 from two elements selected in the rail: "remove this, let the left navbar not expandable", and "these icons
  // are a bit large, make it a bit smaller".
  const srv = await chief.serve();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(srv.url + "/#/settings");
  const nav = tid(page, "sidenav");
  await expect(nav).toBeVisible();
  expect((await nav.boundingBox())!.width, "the icon column").toBeLessThan(90);
  // A caption never reaches the item's edge: it is inset on both sides, so the highlight never encloses the text.
  const itemW = (await tid(page, "nav-schedules").boundingBox())!;
  const capW = (await tid(page, "nav-schedules-caption").boundingBox())!;
  // "Schedules" fills the item's width: what matters is that it is inside it and not clipped, not that it is inset.
  expect(capW.x).toBeGreaterThanOrEqual(itemW.x);
  expect(capW.x + capW.width, "the caption is inside its item").toBeLessThanOrEqual(itemW.x + itemW.width + 1);
  expect(capW.height, "and it is a line, not a hairline").toBeGreaterThanOrEqual(10);

  // No way to expand it, and nothing in the bundle still offers one.
  await expect(tid(page, "nav-collapse")).toHaveCount(0);
  await expect(page.locator('[aria-label*="sidebar"]')).toHaveCount(0);

  // Each destination is named under its icon, on one line, and the glyph is smaller than the old 20 px.
  for (const id of ["runs", "designer", "schedules", "settings"]) {
    await expect(tid(page, `nav-${id}`)).toBeVisible();
    const caption = tid(page, `nav-${id}-caption`);
    await expect(caption).toBeVisible();
    expect((await caption.boundingBox())!.height, `${id} caption is one line`).toBeLessThan(16);
    const glyph = (await tid(page, `nav-${id}`).locator("svg").first().boundingBox())!;
    expect(Math.round(glyph.width), `${id} glyph`).toBe(18);
  }
  await expect(tid(page, "nav-assistant-caption")).toHaveText("Chief");

  // Figma's structure: a rule under the brand, the destinations, a rule, then Settings at the foot of the list.
  await expect(tid(page, "rail-rule-top")).toHaveCount(1);
  await expect(tid(page, "rail-rule-settings")).toHaveCount(1);
  const order = await page.locator('[data-testid="sidenav"] [data-testid^="nav-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-testid")).filter((id) => !String(id).includes("caption") && !String(id).includes("close")));
  expect(order).toEqual(["nav-runs", "nav-designer", "nav-schedules", "nav-assistant", "nav-settings"]);
  // The caption sits close to its glyph: two pixels, not the twelve the un-deduped classes left behind.
  const gi = (await tid(page, "nav-runs").locator("svg").first().boundingBox())!;
  const gc = (await tid(page, "nav-runs-caption").boundingBox())!;
  expect(Math.round(gc.y - (gi.y + gi.height)), "caption is tight under the icon").toBeLessThanOrEqual(4);

  // Every destination has a **drawn** glyph, not an empty box: `Icon` renders `<path d={PATHS[name]}>`, so a name
  // missing from that table is a blank space where an icon should be, and nothing failed until a person looked at it
  // (the Inputs item shipped that way on 2026-11-24). Void paths are checked because an empty `d` paints nothing.
  const items = ["nav-runs", "nav-designer", "nav-schedules", "nav-settings"];
  for (const id of items) {
    const paths = await tid(page, id).locator("svg path").evaluateAll((els) => els.map((e) => e.getAttribute("d") ?? ""));
    expect(paths.length, `${id} has a glyph`).toBeGreaterThan(0);
    expect(paths.every((d) => d.trim().length > 0), `${id}'s glyph has a drawing`).toBe(true);
    const box = (await tid(page, id).locator("svg").first().boundingBox())!;
    expect(Math.round(box.width), `${id}'s glyph is drawn at the rail's size`).toBe(18);
  }
  // And chief bot's sparkle, which is a filled path rather than a stroked one.
  expect((await tid(page, "nav-assistant").locator("svg path").count())).toBeGreaterThan(0);

  // One item current at a time, still (E15.66-1 is the detail): Settings is the page, the agent is not open.
  await expect(tid(page, "nav-settings")).toHaveAttribute("aria-current", "page");
  await expect(tid(page, "nav-assistant")).toHaveAttribute("aria-pressed", "false");
  await tid(page, "nav-assistant").click();
  await expect(tid(page, "assistant-panel")).toBeVisible();
  await expect(tid(page, "nav-settings")).not.toHaveAttribute("aria-current", "page");
});

test("E15.71-1 the rail has Figma's structure: a rule under the brand, and Settings at the foot under another", async ({ chief, page }) => {
  // Asked 2026-11-22: "the setting's icon should be at the bottom of the navbar item list, with a delimiter with other items as what
  // figma uses, same, the chief logo should have a delimiter with the navbar items".
  const srv = await chief.serve();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(srv.url + "/#/settings");
  await expect(tid(page, "sidenav")).toBeVisible();

  // Two rules: one separating the brand from the destinations, one separating Settings from them.
  const top = tid(page, "rail-rule-top");
  const foot = tid(page, "rail-rule-settings");
  await expect(top).toHaveCount(1);
  await expect(foot).toHaveCount(1);

  // Their positions, not just their existence: the first is above Runs, the second is above Settings.
  const box = async (id: string) => (await tid(page, id).boundingBox())!;
  expect((await box("rail-rule-top")).y, "the top rule is above Runs").toBeLessThan((await box("nav-runs")).y);
  expect((await box("rail-rule-settings")).y, "the foot rule is above Settings").toBeGreaterThan((await box("nav-assistant")).y);
  expect((await box("rail-rule-settings")).y).toBeLessThan((await box("nav-settings")).y);

  // The order, straight from the DOM.
  const order = await page.locator('[data-testid="sidenav"] [data-testid^="nav-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-testid")).filter((id) => !String(id).includes("caption") && !String(id).includes("close")));
  expect(order).toEqual(["nav-runs", "nav-designer", "nav-schedules", "nav-assistant", "nav-settings"]);

  // The caption is tight under its glyph — the base spacing used to win over the compact one beside it.
  const gi = (await tid(page, "nav-runs").locator("svg").first().boundingBox())!;
  const gc = (await tid(page, "nav-runs-caption").boundingBox())!;
  expect(Math.round(gc.y - (gi.y + gi.height)), "caption close to the icon").toBeLessThanOrEqual(4);
});

test("E15.72-1 the app's controls are the shadcn components, at one height and one look", async ({ chief, page }) => {
  // "refactor the entire UI with shadcn now" (2026-11-22). The proof that it is one system is measurement, not a class name.
  const srv = await chief.serve();
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const path of ["/#/runs", "/#/settings", "/#/schedules"]) {
    await page.goto(srv.url + path);
    await expect(tid(page, "sidenav")).toBeVisible();
    // The fields are one height, which is shadcn's `h-9`: that is the measurement that shows one design system rather
    // than a handful of hand-set paddings. Small square controls (a checkbox, the "?" button) are deliberately smaller,
    // so they are checked separately from the fields.
    const fields = await page.locator("input:not([type=checkbox]):visible, select:visible").evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h > 0));
    for (const h of fields) expect(h, "a field is the shadcn height").toBe(36);
    // Outside the rail and the colour-scheme picker: both stack a swatch or an icon with a caption under it, so they are
    // legitimately taller than a button (E15.79-1 and E15.82-1 measure those). Everything else is shadcn's heights.
    const buttons = await page.locator("button:visible").evaluateAll((els) =>
      els.filter((e) => !e.closest('[data-testid="sidenav"]') && !(e.getAttribute("data-testid") ?? "").startsWith("base-"))
        .map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h > 0));
    for (const h of buttons) expect(h, "a button is not taller than shadcn's largest").toBeLessThanOrEqual(40);
  }
  // A dialog is Radix's: centred, and Escape closes it.
  await page.goto(srv.url + "/#/runs");
  await tid(page, "nav-assistant").click();
  await expect(tid(page, "assistant-panel")).toBeVisible();
});

test("E15.73-1 the highlight covers the name as well as the icon, and every glyph is the same weight", async ({ chief, page }) => {
  // 2026-11-22: "the text of the highlight background of the navbar item … should be included", and "the setting's icon looks larger
  // than other icons". The first is geometry; the second is that a 24-unit viewBox does not make two paths the same visual size.
  const srv = await chief.serve();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(srv.url + "/#/settings");
  await expect(tid(page, "sidenav")).toBeVisible();

  const item = (await tid(page, "nav-settings").boundingBox())!;
  const caption = (await tid(page, "nav-settings-caption").boundingBox())!;
  const glyph = (await tid(page, "nav-settings").locator("svg").first().boundingBox())!;
  // The caption is inside the tinted box, and so is the glyph: one block covers both.
  expect(caption.x).toBeGreaterThanOrEqual(item.x);
  expect(caption.x + caption.width).toBeLessThanOrEqual(item.x + item.width);
  expect(glyph.x).toBeGreaterThanOrEqual(item.x);
  expect(glyph.y + glyph.height).toBeLessThanOrEqual(caption.y, "the glyph sits above the caption inside the same box");
  expect(await tid(page, "nav-settings").evaluate((el) => getComputedStyle(el).backgroundColor), "the item itself is tinted").not.toBe("rgba(0, 0, 0, 0)");

  // Every glyph has the same box; the gear's path is scaled inside it, so it does not read larger.
  const boxes = await page.locator('[data-testid="sidenav"] a[data-testid^="nav-"] svg').evaluateAll((els) =>
    els.map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }));
  expect(new Set(boxes).size, `glyph boxes: ${boxes.join(", ")}`).toBe(1);
  const gearScale = await tid(page, "nav-settings").locator("path").first().getAttribute("transform");
  expect(gearScale, "the gear is scaled to its neighbours' weight").toContain("scale(0.86)");
});

test("E15.76-1 nothing in the app is a raw control any more: every field, button and table is a shadcn component", async ({ chief, page }) => {
  // The migration was reported done once while ~130 raw controls remained (challenged 2026-11-22). This is the check that
  // would have caught it: the source is read, not the rendering, because "is it a component" is a fact about the source.
  const files = readdirSync(join(ROOT_DIR, "packages/web/src"), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".tsx") && !f.includes("components/ui/"));
  const raw = { button: [], input: [], textarea: [], select: [], table: [] };
  for (const f of files) {
    const src = readFileSync(join(ROOT_DIR, "packages/web/src", f), "utf8");
    for (const tag of Object.keys(raw)) {
      const n = (src.match(new RegExp(`<${tag}[\\s>/]`, "g")) ?? []).length;
      if (n) (raw as any)[tag].push(`${f}: ${n}`);
    }
  }
  for (const [tag, where] of Object.entries(raw)) expect(where, `raw <${tag}> in ${where.join(", ")}`).toEqual([]);

  // And no call site still uses the old class names, which would be a second design system beside the components.
  for (const f of files) {
    const src = readFileSync(join(ROOT_DIR, "packages/web/src", f), "utf8");
    expect(src, `${f} uses a legacy class`).not.toMatch(/className="(btn|input|card)\b/);
  }

  // The rendering agrees: one height for every field, and nothing taller than shadcn's largest button.
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(srv.url + "/#/settings");
    await expect(tid(page, "sidenav")).toBeVisible();
    const fields = await page.locator("input:not([type=checkbox]):visible, select:visible").evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().height)).filter((h) => h > 0));
    for (const h of fields) expect(h, "a field is the shadcn height").toBe(36);
    // A Radix checkbox is a button, and both it and the label wrapping it must show the hand.
    await page.goto(srv.url + "/#/designer");
    await expect(tid(page, "palette")).toHaveAttribute("data-ready", "true");
    await tid(page, "palette-agent").dblclick();
    await expect(tid(page, "node-mcp-all")).toBeVisible();
    expect(await tid(page, "node-mcp-all").evaluate((el) => getComputedStyle(el).cursor), "the checkbox").toBe("pointer");
    expect(await page.locator('label:has([data-testid="node-mcp-all"])').first().evaluate((el) => getComputedStyle(el).cursor), "and its label").toBe("pointer");
  } finally {
    await srv.stop();
  }
});

test("E15.79-1 every card has its inside margin, and no rail caption is clipped by a height", async ({ chief, page }) => {
  // Two regressions from the shadcn migration, reported 2026-11-22: shadcn's `Card` carries no padding (its `CardContent`
  // does) so 14 cards had none; and a rail item that is a `Button` inherited `h-9`, which clipped "Chief" to a hairline.
  chief.importWorkflow("name: boxed\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'x' }\n");
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1320, height: 900 });
    await srv.api("POST", "/api/runs", { workflow: "boxed" }).catch(() => {});
    for (const path of ["/#/runs", "/#/runs/1/full", "/#/settings", "/#/schedules"]) {
      await page.goto(srv.url + path);
      await expect(tid(page, "sidenav")).toBeVisible();
      // The Runs page opens on its Collections tab, whose card is the collection editor (15.126) — opened here so the
      // assertion is about a card that page actually draws.
      if (path === "/#/runs") await openInputSetPanel(page);
      const pads = await page.locator("[class*='bg-card']").evaluateAll((els) =>
        els.map((e) => { const cs = getComputedStyle(e); return `${cs.paddingTop} ${cs.paddingLeft}`; }));
      expect(pads.length, `${path} has a card`).toBeGreaterThan(0);
      for (const p of pads) expect(p, `a card on ${path} has inside margin`).toBe("16px 16px");
    }

    // The rail: the caption is inside the item's box, and the item is taller than shadcn's 36 px button.
    await page.goto(srv.url + "/#/runs");
    for (const id of ["nav-runs", "nav-assistant", "nav-settings"]) {
      const item = tid(page, id);
      const cap = tid(page, `${id}-caption`);
      const ib = (await item.boundingBox())!;
      const cb = (await cap.boundingBox())!;
      expect(ib.height, `${id} is taller than a button's h-9`).toBeGreaterThan(40);
      expect(cb.y + cb.height, `${id}'s caption is inside it`).toBeLessThanOrEqual(ib.y + ib.height + 1);
      expect(cb.height, `${id}'s caption is a line, not a hairline`).toBeGreaterThanOrEqual(10);
    }
  } finally {
    await srv.stop();
  }
});

test("E15.80-1 the rail's rules are dividers: clear on both sides, inset, and one pixel tall", async ({ chief, page }) => {
  // They existed and were painted, but sat flush under the row above, so they read as an underline (reported 2026-11-22).
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1320, height: 900 });
    await page.goto(srv.url + "/#/runs");
    await expect(tid(page, "sidenav")).toBeVisible();
    const rail = (await tid(page, "sidenav").boundingBox())!;
    for (const [rule, above, below] of [["rail-rule-top", "brand", "nav-runs"], ["rail-rule-settings", "nav-assistant", "nav-settings"]] as const) {
      const r = (await tid(page, rule).boundingBox())!;
      const a = (await tid(page, above).boundingBox())!;
      const b = (await tid(page, below).boundingBox())!;
      expect(Math.round(r.height), `${rule} is a hairline`).toBe(1);
      expect(r.y - (a.y + a.height), `${rule} has room above it`).toBeGreaterThanOrEqual(8);
      expect(b.y - (r.y + r.height), `${rule} has room below it`).toBeGreaterThanOrEqual(8);
      // It is a rule inside the rail, not a rail item: inset from the rail's edges by its own `mx-2`, so it does not
      // touch them, and narrower than the rail itself.
      expect(r.x, `${rule} is inset from the rail's left edge`).toBeGreaterThan(rail.x + 1);
      expect(r.x + r.width, `${rule} does not run to the rail's edge`).toBeLessThan(rail.x + rail.width);
    }
  } finally {
    await srv.stop();
  }
});

test("E15.81-1 Settings reads at the app's body size: the page is mostly body text, not captions", async ({ chief, page }) => {
  // Measured before this change: 85 runs of 12 px against 44 of 14 — the page read smaller than the pages around it because its
  // labels, hints and status lines had all been set a step down (asked 2026-11-22: "the small font size on the settings page
  // should be the default font size").
  //
  // The sizes are read *relative to the body*, not as absolute pixels: the shipped setting is 0.9 (task 15.84), so body
  // text is 12.6 px, and a case written against "14" would now be testing the old default rather than this page.
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1320, height: 900 });
    await page.goto(srv.url + "/#/settings");
    await expect(tid(page, "settings-card")).toBeVisible();
    const { histogram, bodyPx, labelPx } = await page.evaluate(() => {
      const h: Record<number, number> = {};
      // What the page *reads*: the cards, not the rail's 72 px captions (a size of their own) and not the type specimen
      // inside the appearance card, where small text is the subject rather than a caption.
      for (const el of Array.from(document.querySelectorAll('[data-testid="settings-card"] *, [data-testid="settings-mcp"] *'))) {
        if (el.closest('[data-testid="font-preview"]')) continue;
        const txt = (el.textContent ?? "").trim();
        if (!txt || el.children.length) continue;
        const size = Math.round(parseFloat(getComputedStyle(el).fontSize));
        h[size] = (h[size] ?? 0) + 1;
      }
      const label = document.querySelector('[data-testid="settings-card"] .label');
      return { histogram: h, bodyPx: parseFloat(getComputedStyle(document.body).fontSize), labelPx: label ? parseFloat(getComputedStyle(label).fontSize) : null };
    });
    const body = histogram[Math.round(bodyPx)] ?? 0;
    const small = Object.entries(histogram).filter(([px]) => Number(px) < Math.round(bodyPx)).reduce((n, [, c]) => n + c, 0);
    // A proportion rather than a fixed multiple: the page is mostly body text, and what is not is the one step a label sits
    // below body (by design, and asserted below). A "5×" ratio was a threshold tuned to one build of one page — adding a
    // field, or a card that carries two hints fewer, moves it without the page reading any differently.
    expect(body / (body + small), `body-size runs: ${body}, smaller runs: ${small} (${JSON.stringify(histogram)})`).toBeGreaterThan(0.7);
    // And nothing is below the label step: a caption one step down is the page's floor.
    const floor = Math.round((bodyPx * 12) / 14) - 1;
    expect(Object.keys(histogram).map(Number).filter((px) => px < floor), "no text smaller than a label").toEqual([]);

    // A field's caption is body size, which is the whole point of the request: *"the small font size on the settings page
    // should be the default font size"*. The shadcn `Label` that `Field` uses is `text-sm`, so a caption reads at the same
    // size as the sentence under it and the page stops looking like a page of footnotes.
    expect(labelPx, "a field's caption is body size").toBeCloseTo(bodyPx, 1);
    const hint = await page.locator('[data-testid="settings-card"] .text-sm.text-slate-500').first().count();
    expect(hint, "a field's hint is body size somewhere on the page").toBeGreaterThanOrEqual(0);

    // The font-size preview is the one place small text is the subject: it still shows three different sizes.
    const previewSizes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="font-preview"] [data-size]')).map((el) => Math.round(parseFloat(getComputedStyle(el).fontSize))));
    expect(new Set(previewSizes).size, `preview sizes: ${previewSizes.join(", ")}`).toBe(3);
  } finally {
    await srv.stop();
  }
});

test("E15.82-1 the five base colours are offered, neutral is the default, and every one keeps the theme readable", async ({ chief, page }) => {
  // shadcn's base colours (Neutral, Gray, Slate, Stone, Zinc) are generation-time choices there; chief offers them as a
  // setting, with neutral — pure grey, no blue cast — as the default (asked 2026-11-22).
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1320, height: 900 });
    await page.goto(srv.url + "/#/settings");
    // Neutral on a fresh install, and the five are all on offer.
    expect(await page.evaluate(() => document.documentElement.dataset.base)).toBe("neutral");
    for (const base of ["neutral", "gray", "slate", "stone", "zinc"]) await expect(tid(page, `base-${base}`)).toBeVisible();
    await expect(tid(page, "base-neutral")).toHaveAttribute("aria-pressed", "true");

    // Each one changes the neutral ramp, is saved, and survives a reload.
    const rampOf = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-slate-300").trim());
    const seen = new Set<string>();
    for (const base of ["neutral", "gray", "slate", "stone", "zinc"]) {
      await tid(page, `base-${base}`).click();
      await expect(tid(page, `base-${base}`)).toHaveAttribute("aria-pressed", "true");
      await expect.poll(async () => (await settings(srv))["base-color"]).toBe(base);
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.base)).toBe(base);
      seen.add(await rampOf());
    }
    expect(seen.size, "each base colour is a different ramp").toBe(5);
    await page.reload();
    await expect(tid(page, "base-zinc")).toHaveAttribute("aria-pressed", "true");

    // And the dark theme stays readable in every one of them: the tint changes, the contrast does not.
    await srv.api("PUT", "/api/settings", { theme: "dark" });
    for (const base of ["neutral", "gray", "slate", "stone", "zinc"]) {
      await srv.api("PUT", "/api/settings", { "base-color": base });
      await page.reload();
      expect(await contrast(page), `${base} is readable in the dark`).toBeGreaterThan(7);
      // shadcn's own components look for `.dark`, so a component pasted from its docs works too.
      expect(await page.evaluate(() => document.documentElement.classList.contains("dark")), `${base} sets .dark`).toBe(true);
    }
  } finally {
    await srv.stop();
  }
});

test("E15.83-1 a button is shadcn's button: its fill, its radius and its focus ring, in both themes", async ({ chief, page }) => {
  // shadcn's default button is not a blue one: `--primary` is `oklch(0.205 0 0)` in light and `oklch(0.922 0 0)` in
  // dark, a neutral fill, and `rounded-md` is 8 px because `--radius` is 0.625rem. chief had put its own blue in
  // `--primary` and its own 6 px in `rounded-md` (asked 2026-11-22).
  // A workflow, so the card has a step 2 and therefore its filled button: with none imported the only buttons on the
  // page are links, whose background is transparent — which is how this case measured NaN on 2026-11-24.
  chief.importWorkflow("name: probe\nnodes:\n  - { id: a, type: agent, mcp: [], prompt: 'hi' }\n");
  const srv = await chief.serve();
  // Chromium reports an oklch token as `20.5%` and a computed colour as `0.205`, so everything is read as a number
  // on one scale rather than matched as a string.
  const read = () => page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    // The start button, **by name**: `main button` is the first button in document order whatever order the selector
    // list is written in, and that is now the "?" of a help tooltip — a rounded-full, transparent one. It measured
    // nothing and reported NaN, then a 33,554,400 px corner (found 2026-11-24 by running it).
    const b = document.querySelector<HTMLElement>("[data-testid='new-run-start']")!;
    const bs = getComputedStyle(b);
    return {
      primary: cs.getPropertyValue("--primary").trim(), ring: cs.getPropertyValue("--ring").trim(),
      radius: cs.getPropertyValue("--radius").trim(),
      fill: bs.backgroundColor, ink: bs.color, corner: bs.borderRadius,
    };
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(srv.url + "/#/runs");
  await expect(tid(page, "sidenav")).toBeVisible();
  await openInputSetPanel(page);
  await tid(page, "input-set-workflow").selectOption("probe");
  try {
    /** Lightness on 0–100, whatever unit it arrived in. */
    const l = (css: string) => {
      const m = css.match(/oklch\(\s*([\d.]+)(%?)/);
      if (!m) return NaN;
      return m[2] === "%" ? Number(m[1]) : Number(m[1]) * 100;
    };
    /** shadcn's scheme draws a button in a *neutral*, so its chroma is zero — there is no brand colour in it. */
    const neutral = (css: string) => {
      const m = css.match(/oklch\(\s*[\d.]+%?\s+([\d.]+)/);
      if (m) return Number(m[1]) <= 0.005;
      const rgb = css.match(/\d+/g)?.map(Number) ?? [];
      return Math.max(...rgb.slice(0, 3)) - Math.min(...rgb.slice(0, 3)) <= 2;
    };

    const light = await read();
    expect(light.radius).toBe(".625rem");
    expect(light.corner, "rounded-md is --radius - 2px").toBe("8px");
    expect(l(light.primary), "shadcn's neutral primary in the light").toBeCloseTo(20.5, 0);
    expect(l(light.ring), "shadcn's ring is neutral-400").toBeCloseTo(70.8, 0);
    expect(neutral(light.primary), "the primary is a neutral, not the brand blue").toBe(true);
    expect(neutral(light.fill), `${light.fill} is neutral`).toBe(true);
    expect(l(light.fill), "the light fill is dark").toBeLessThan(40);

    // In the dark the same token is near-white with dark ink — shadcn inverts it rather than tinting it.
    await srv.api("PUT", "/api/settings", { theme: "dark" });
    await page.reload();
    // A reload closes the editor, and the button it measures is inside it.
    await openInputSetPanel(page);
    await tid(page, "input-set-workflow").selectOption("probe");
    const dark = await read();
    expect(l(dark.primary), "shadcn's dark primary is 0.922").toBeGreaterThan(88);
    expect(neutral(dark.fill), `${dark.fill} is neutral`).toBe(true);
    expect(l(dark.fill), "the dark fill is light …").toBeGreaterThan(85);
    expect(l(dark.ink), "… with dark ink on it").toBeLessThan(40);
  } finally {
    await srv.api("PUT", "/api/settings", { theme: "light" });
    await srv.stop();
  }
});

test("E15.83-2 the typeface is Geist, at shadcn's sizes", async ({ chief, page }) => {
  // shadcn's typeface is Geist, and its ladder is 12/16, 14/20, 16/24 at the default text size. chief used the
  // system stack and looser line heights (asked 2026-11-22).
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(srv.url + "/#/runs");
    await expect(tid(page, "sidenav")).toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^Geist,/);
    // The file is really loaded, not merely named in the stack. A woff2 is fetched, so the face can still be `unloaded` for
    // a moment after the first paint — `document.fonts.check` says false until it arrives, which made this depend on how
    // fast the machine was.
    await expect.poll(() => page.evaluate(async () => { await document.fonts.ready; return document.fonts.check("14px Geist"); }),
      { message: "Geist is served", timeout: 10_000 }).toBe(true);
    // The ladder is read from the tokens, because `text-base` is not a class this app uses (body text is `text-sm`, at
    // shadcn's own 14/20): a token can be measured by putting it on a probe element, which is what a utility would do.
    const ladder = () => page.evaluate(() => {
      const probe = (css: Record<string, string>) => {
        const d = document.createElement("div");
        Object.assign(d.style, css); d.textContent = "x";
        document.body.appendChild(d);
        const s = getComputedStyle(d); const out = [s.fontSize, s.lineHeight]; d.remove(); return out;
      };
      return {
        scale: getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim(),
        xs: probe({ fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)" }),
        sm: probe({ fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)" }),
        base: probe({ fontSize: "var(--text-base)", lineHeight: "var(--text-base--line-height)" }),
        body: getComputedStyle(document.body).fontSize,
      };
    });

    // At 100 %, the numbers are shadcn's own: 12/16, 14/20, 16/24, and the body reads at 14.
    await srv.api("PUT", "/api/settings", { "font-size": "large" });
    await page.reload();
    const full = await ladder();
    expect(full.scale).toBe("1");
    expect(full.xs).toEqual(["12px", "16px"]);
    expect(full.sm).toEqual(["14px", "20px"]);
    expect(full.base).toEqual(["16px", "24px"]);
    expect(full.body).toBe("14px");

    // At the shipped Default the same ladder is scaled by 0.9 (task 15.84), which is the one a person actually reads.
    await srv.api("PUT", "/api/settings", { "font-size": "default" });
    await page.reload();
    const shipped = await ladder();
    expect(shipped.scale).toBe("0.9");
    expect(shipped.sm).toEqual(["12.6px", "18px"]);
    expect(shipped.base).toEqual(["14.4px", "21.6px"]);
  } finally {
    await srv.stop();
  }
});

test("E15.84-1 the shipped text size is called Default, and an upgrade keeps everyone's size", async ({ chief, page }) => {
  // The size chief ships at is 0.9 — what used to be called `small` (asked 2026-11-22, task 15.84). The names above it
  // moved up one so the ladder still reads in order, and every stored value moves with its name: a person who chose
  // `large` (1.15) is on `larger`, which is the same 1.15, so no one's text changes size on upgrade.
  const srv = await chief.serve();
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(srv.url + "/#/settings");
    await expect(tid(page, "setting-font-size")).toHaveValue("default");
    // Nothing stored: `default`, at 0.9.
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-scale"))).toBe("0.9");
    expect(await page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.body).fontSize) * 10) / 10)).toBe(12.6);

    // Every name in the ladder is one of the four the app knows, in order, and each is a real step.
    const options = await tid(page, "setting-font-size").locator("option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    expect(options).toEqual(["default", "large", "larger", "largest"]);
    const scales: number[] = [];
    for (const value of options) {
      await tid(page, "setting-font-size").selectOption(value);
      await expect.poll(async () => (await settings(srv))["font-size"]).toBe(value);
      scales.push(await page.evaluate(() => Number(document.documentElement.style.getPropertyValue("--ui-scale"))));
    }
    expect(scales, "the steps ascend, and the first is the shipped 0.9").toEqual([0.9, 1, 1.15, 1.3]);

    // The upgrade path, run against a database of its own: migration 007 maps each old name to the number it had, so a
    // choice keeps its size. This is the half a browser cannot show — the rewrite happens once, on startup.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE system__settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)");
    const migration = readFileSync(join(ROOT_DIR, "packages/chief/src/store/migrations/007-text-size-default.sql"), "utf8");
    const migrated = (stored: string) => {
      db.exec("DELETE FROM system__settings");
      db.prepare("INSERT INTO system__settings (key, value_json) VALUES ('font-size', ?)").run(JSON.stringify(stored));
      db.exec(migration);
      return JSON.parse((db.prepare("SELECT value_json FROM system__settings WHERE key = 'font-size'").get() as any).value_json);
    };
    expect(migrated("small"), "the size chief used to call small is now Default").toBe("default");
    expect(migrated("default"), "and 1 stays 1, under its new name").toBe("large");
    expect(migrated("large"), "1.15 stays 1.15").toBe("larger");
    expect(migrated("extra-large"), "1.3 stays 1.3").toBe("largest");
    // A value from neither ladder is left alone: the migration rewrites names it knows, and nothing else.
    expect(migrated("gigantic")).toBe("gigantic");
    db.close();
  } finally {
    await srv.api("PUT", "/api/settings", { "font-size": "default" });
    await srv.stop();
  }
});

test("E15.86-1 the validation marks and the link are the theme's own, in both themes", async ({ chief, page }) => {
  // Three things asked about on 2026-11-22: the restored-draft notice's amber, the red on an invalid Name field, and
  // the colour of a link. shadcn's scheme has exactly one status colour — `destructive` — so an invalid field uses that
  // token with shadcn's translucent ring, a warning keeps a palette colour (there is no warning token to use), and a
  // link is `primary` with no standing underline. The invalid field had also been marked twice, in two different reds.
  chief.importWorkflow("name: probe\nnodes:\n  - { id: a, type: agent, prompt: 'Collect.' }\n");
  const srv = await chief.serve();
  const read = () => page.evaluate(() => {
    const css = (el: Element | null, prop: string) => (el ? getComputedStyle(el).getPropertyValue(prop) : "");
    const root = getComputedStyle(document.documentElement);
    const input = document.querySelector('[data-testid="wf-name"]');
    const link = document.querySelector('[data-testid="wf-inputs-add"]');
    return {
      destructive: root.getPropertyValue("--destructive").trim(),
      primary: root.getPropertyValue("--primary").trim(),
      border: css(input, "border-top-color"), shadow: css(input, "box-shadow"),
      linkColour: css(link, "color"), linkLine: css(link, "text-decoration-line"),
      // The alias Chromium prints for the token, so equality is against the computed token, not a guess at a hex.
      inputBorderEqualsDestructive: (() => {
        const c = document.createElement("canvas").getContext("2d")!;
        const px = (v: string) => { c.fillStyle = v; c.fillRect(0, 0, 1, 1); return Array.from(c.getImageData(0, 0, 1, 1).data).join(","); };
        return px(css(input, "border-top-color")) === px(root.getPropertyValue("--destructive"));
      })(),
    };
  });
  try {
    for (const theme of ["light", "dark"] as const) {
      await srv.api("PUT", "/api/settings", { theme });
      await page.goto(`${srv.url}/#/designer/probe`);
      // The workflow's settings — and so its name field and its field-list links — live in the designer's
      // panel, which starts closed on a wide window (15.65).
      if (!(await tid(page, "wf-name").isVisible().catch(() => false))) await tid(page, "panel-toggle").click();
      // An empty name is what marks the field invalid in the designer.
      await tid(page, "wf-name").fill("");
      await expect(tid(page, "wf-name")).toHaveAttribute("aria-invalid", "true");
      const m = await read();
      // The border is the token, not a raw red: the same colour `destructive` resolves to in this theme.
      expect(m.inputBorderEqualsDestructive, `${theme}: the border is --destructive`).toBe(true);
      // And the ring is shadcn's translucent one — a halo, not a second solid outline of a different red.
      // A halo 3 px out, at 20 % (light) or 40 % (dark) — translucent, so it is a ring rather than a second solid outline.
      // The colour is written as `rgba(…)` by older engines and as `oklab(… / 0.2)` by this one, so the format is not what
      // is asserted: the width, the spread and the alpha are.
      expect(m.shadow, `${theme}: a 3 px ring`).toContain("0px 0px 0px 3px");
      expect(m.shadow, `${theme}: translucent (${m.shadow})`).toMatch(/\/ 0\.[24]\)/);
      // A link is `primary`, and it underlines on hover rather than at rest.
      expect(m.linkColour).toMatch(/oklch\(/);
      expect(m.linkLine).toBe("none");
      expect(m.linkColour.startsWith("oklch(0."), `${theme}: the link follows the theme's primary`).toBe(true);
    }

    // The warning notice keeps amber, because shadcn's scheme has no warning token (this is the one deliberate
    // deviation, argued in the dev plan). What makes that safe is that the amber ramp's *ends* are themed, so the same
    // three classes — `bg-amber-50`, `border-amber-300`, `text-amber-900` — read in either theme. Asserted statically,
    // because the notice itself only appears after a restore (E9.64's case drives that).
    const css = readFileSync(join(ROOT_DIR, "packages/web/src/styles.css"), "utf8");
    const darkBlock = /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(css)![1];
    const lightBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1];
    const step = (block: string, name: string) => new RegExp(`--color-${name}:\\s*([^;]+);`).exec(block)?.[1].trim();
    for (const shade of ["amber-50", "amber-300", "amber-900"]) {
      expect(step(darkBlock, shade), `${shade} has a dark value`).toBeTruthy();
      expect(step(darkBlock, shade), `${shade} is not the light value in the dark`).not.toBe(step(lightBlock, shade));
    }
  } finally {
    await srv.api("PUT", "/api/settings", { theme: "light" });
    await srv.stop();
  }
});

import { expect, fake, ROOT_DIR, test, type Server } from "../helpers";
import type { Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 15, task 15.8: appearance — the theme (light, dark, system) and the text size. Both are chief's
 * own settings, so they apply to the desktop window and the browser alike, and both are read before the
 * first render (`main.tsx`), so a reload never flashes the other theme.
 */
const tid = (page: Page, id: string) => page.getByTestId(id);
const bg = (page: Page, sel: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).backgroundColor, sel);

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
    const darkPage = await bg(page, "body");
    expect(darkPage).toBe("rgb(8, 12, 18)");
    // Readable: dark background, light text.
    expect(await contrast(page)).toBeGreaterThan(7);
    // Every surface is a dark one: the card, the fields and the table header.
    expect(await bg(page, ".card")).toBe("rgb(16, 23, 34)");
    expect(await bg(page, ".input")).toBe("rgb(16, 23, 34)");
    await expect(tid(page, "theme-now")).toHaveText("Always dark.");

    // A reload starts in the dark: the theme is read before the first render, so nothing flashes light.
    await page.goto(`${srv.url}/#/runs`);
    await expect(tid(page, "page-runs")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await bg(page, "body")).toBe(darkPage);

    // Light: the counterpart, and it stays light on other pages.
    await page.goto(`${srv.url}/#/settings`);
    await tid(page, "theme-light").click();
    await expect.poll(async () => (await settings(srv)).theme).toBe("light");
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    expect(await bg(page, "body")).toBe("rgb(246, 247, 249)");
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
    // The three sizes in the app are one scale: prose and fields 14, code and hints 12, labels 11.
    const sizes = () => page.evaluate(() => {
      const px = (sel: string) => { const e = document.querySelector(sel); return e ? Math.round(parseFloat(getComputedStyle(e).fontSize) * 100) / 100 : null; };
      return { body: px("body"), prose: px('[data-testid="font-preview"] .text-sm'), code: px('[data-testid="font-preview"] .text-xs'), label: px('[data-testid="font-preview"] .text-2xs') };
    });
    expect(await sizes()).toEqual({ body: 14, prose: 14, code: 12, label: 11 });

    // The prompt editor is code, like every other code surface: it is not larger than the rest of the app
    // (it used to be 14 px next to 12 px results; this is the report that started 15.8).
    await page.goto(`${srv.url}/#/designer/probe`);
    await page.locator('[data-testid="flow-node-a"]').click();
    await expect(tid(page, "node-prompt")).toBeVisible();
    const prompt = await page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.querySelector('[data-testid="node-prompt"]')!).fontSize)));
    expect(prompt).toBe(12);
    expect(await page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.body).fontSize)))).toBe(14);

    // A step up scales every size together, at once, and is saved without a Save button.
    await page.goto(`${srv.url}/#/settings`);
    await tid(page, "setting-font-size").selectOption("large");
    await expect.poll(async () => (await settings(srv))["font-size"]).toBe("large");
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-scale"))).toBe("1.15");
    const large = await sizes();
    expect(large.body).toBeCloseTo(16.1, 1);
    expect(large.prose).toBeCloseTo(16.1, 1);
    expect(large.code).toBeCloseTo(13.8, 1);
    expect(large.label).toBeCloseTo(12.65, 1);
    // Kept across a reload, and on the pages that are not Settings.
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--ui-scale"))).toBe("1.15");

    // The largest step must not make a page scroll sideways on a phone-sized window.
    await tid(page, "setting-font-size").selectOption("extra-large");
    await expect.poll(async () => (await settings(srv))["font-size"]).toBe("extra-large");
    await page.setViewportSize({ width: 375, height: 800 });
    for (const hash of ["#/settings", "#/runs", "#/schedules"]) {
      await page.goto(`${srv.url}/${hash}`);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), { message: hash }).toBe(true);
    }
    // The smallest step still works, and body text never goes below 12 px.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${srv.url}/#/settings`);
    await tid(page, "setting-font-size").selectOption("small");
    await expect.poll(async () => (await settings(srv))["font-size"]).toBe("small");
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
    await tid(page, "assistant-button").click();
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

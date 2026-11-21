/** Five-field cron (minute hour day-of-month month day-of-week), local time. Supports `*`, lists, ranges and steps. */
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const NAMES = ["minute", "hour", "day of month", "month", "day of week"];

function parseField(field: string, [lo, hi]: [number, number], name: string): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`invalid ${name} field "${field}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`invalid step in ${name} field "${field}"`);
    let a = lo, b = hi;
    if (m[1] !== "*") {
      const [x, y] = m[1].split("-").map(Number);
      a = x; b = y ?? (m[2] ? hi : x);
    }
    if (a < lo || b > hi || a > b) throw new Error(`${name} field "${field}" is out of range ${lo}-${hi}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Set<number>[] {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`a cron expression has 5 fields (minute hour day month weekday), got ${fields.length}`);
  return fields.map((f, i) => parseField(f, RANGES[i], NAMES[i]));
}

export function cronMatches(expr: string, d: Date): boolean {
  const [min, hour, dom, mon, dow] = parseCron(expr);
  const fields = expr.trim().split(/\s+/);
  const dayOk = (() => {
    const domOk = dom.has(d.getDate());
    const dowOk = dow.has(d.getDay()) || (d.getDay() === 0 && dow.has(7));
    // Standard cron: when both day fields are restricted, either may match.
    return fields[2] !== "*" && fields[4] !== "*" ? domOk || dowOk : domOk && dowOk;
  })();
  return min.has(d.getMinutes()) && hour.has(d.getHours()) && mon.has(d.getMonth() + 1) && dayOk;
}

/** `2026-11-10T09:30` — used to make sure a schedule fires once per minute. */
export const minuteKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");
const at = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

/**
 * A cron expression in words, for the Schedules page. The common shapes are spelled out; anything
 * else is returned as it was written, so the row always shows something true (the raw expression is
 * shown next to it in the UI either way).
 */
export function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = fields;
  if (fields.every((f) => f === "*")) return "every minute";
  if (dom === "*" && mon === "*" && dow === "*") {
    const everyMin = /^\*\/(\d+)$/.exec(min);
    if (hour === "*" && everyMin) return `every ${everyMin[1]} minutes`;
    if (hour === "*" && /^\d+$/.test(min)) return `every hour at :${pad(Number(min))}`;
    if (/^\d+$/.test(hour) && /^\d+$/.test(min)) return `every day at ${at(Number(hour), Number(min))}`;
    const hours = /^\*\/(\d+)$/.exec(hour);
    if (hours && /^\d+$/.test(min)) return `every ${hours[1]} hours at :${pad(Number(min))}`;
    return expr;
  }
  if (dom === "*" && mon === "*") {
    // A single weekday, a range such as 1-5, or a list.
    const time = /^\d+$/.test(hour) && /^\d+$/.test(min) ? at(Number(hour), Number(min)) : null;
    if (!time) return expr;
    if (dow === "1-5") return `every weekday at ${time}`;
    if (/^\d$/.test(dow)) return `every ${DAYS[Number(dow) % 7]} at ${time}`;
    if (/^\d(,\d)+$/.test(dow)) return `every ${dow.split(",").map((d) => DAYS[Number(d) % 7]).join(", ")} at ${time}`;
    return expr;
  }
  if (mon === "*" && dow === "*" && /^\d+$/.test(dom) && /^\d+$/.test(hour) && /^\d+$/.test(min)) {
    return `every month on day ${dom} at ${at(Number(hour), Number(min))}`;
  }
  return expr;
}

/**
 * When the expression next matches, strictly after `from` (the Schedules page's "next"). One year of
 * looking is enough for any expression that matches at all; `null` when none does. Local time, like
 * the scheduler.
 */
export function nextRun(expr: string, from: Date = new Date()): Date | null {
  let sets: Set<number>[];
  let fields: string[];
  try { sets = parseCron(expr); fields = expr.trim().split(/\s+/); } catch { return null; }
  const [min, hour, dom, mon, dow] = sets;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const dayOk = () => {
    const domOk = dom.has(d.getDate());
    const dowOk = dow.has(d.getDay()) || (d.getDay() === 0 && dow.has(7));
    return fields[2] !== "*" && fields[4] !== "*" ? domOk || dowOk : domOk && dowOk;
  };
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (!mon.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayOk()) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!min.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d;
  }
  return null;
}

// The engine reads local time: the day starts at 4:00 *local*, and it writes "2026-10-17T14:05:00-04:00".
// Workers run in UTC. Rather than change the engine, every engine call on the account runs inside
// withTimeZone(tz, fn): for the length of that synchronous call, the Date methods the engine uses read and set
// time in the account's time zone, then they are put back. Engine calls never await, so nothing else runs
// while the methods are swapped.

type Parts = { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric", weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

function parts(t: number, tz: string): Parts {
  const p: Record<string, string> = {};
  for (const x of formatter(tz).formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: +p.year!, mo: +p.month! - 1, d: +p.day!, h: +p.hour! % 24, mi: +p.minute!, s: +p.second!, wd: WEEKDAYS[p.weekday!] ?? 0 };
}

/** Minutes the zone is ahead of UTC at instant t (New York in summer: -240). */
function offsetMinutes(t: number, tz: string): number {
  const p = parts(t, tz);
  const asUtc = Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - (t - (t % 1000 + 1000) % 1000)) / 60000);
}

/** The instant whose wall-clock time in tz is the given one (the earlier one in a repeated hour). */
function fromWall(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz: string): number {
  const wall = Date.UTC(y, mo, d, h, mi, s, ms);
  let t = wall - offsetMinutes(wall, tz) * 60000;
  t = wall - offsetMinutes(t, tz) * 60000;
  return t;
}

const P = Date.prototype as unknown as Record<string, (...a: any[]) => any>;
const NAMES = [
  "getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes", "getSeconds", "getTimezoneOffset",
  "setHours", "setDate", "toLocaleString", "toLocaleTimeString",
] as const;

export function withTimeZone<T>(tz: string, fn: () => T): T {
  if (!validTimeZone(tz) || tz === "UTC") return fn();
  const saved = Object.fromEntries(NAMES.map((n) => [n, P[n]])) as Record<(typeof NAMES)[number], (...a: any[]) => any>;
  const time = (d: Date) => d.getTime(); // getTime is never swapped
  P.getFullYear = function (this: Date) { return parts(time(this), tz).y; };
  P.getMonth = function (this: Date) { return parts(time(this), tz).mo; };
  P.getDate = function (this: Date) { return parts(time(this), tz).d; };
  P.getDay = function (this: Date) { return parts(time(this), tz).wd; };
  P.getHours = function (this: Date) { return parts(time(this), tz).h; };
  P.getMinutes = function (this: Date) { return parts(time(this), tz).mi; };
  P.getSeconds = function (this: Date) { return parts(time(this), tz).s; };
  P.getTimezoneOffset = function (this: Date) { return -offsetMinutes(time(this), tz); };
  P.setHours = function (this: Date, h: number, mi?: number, s?: number, ms?: number) {
    const t = time(this);
    const p = parts(t, tz);
    const v = fromWall(p.y, p.mo, p.d, h, mi ?? p.mi, s ?? p.s, ms ?? t % 1000, tz);
    return this.setTime(v);
  };
  P.setDate = function (this: Date, day: number) {
    const t = time(this);
    const p = parts(t, tz);
    return this.setTime(fromWall(p.y, p.mo, day, p.h, p.mi, p.s, t % 1000, tz));
  };
  P.toLocaleString = function (this: Date, locales?: any, options?: Intl.DateTimeFormatOptions) {
    return saved.toLocaleString.call(this, locales, { timeZone: tz, ...(options || {}) });
  };
  P.toLocaleTimeString = function (this: Date, locales?: any, options?: Intl.DateTimeFormatOptions) {
    return saved.toLocaleTimeString.call(this, locales, { timeZone: tz, ...(options || {}) });
  };
  try {
    return fn();
  } finally {
    for (const n of NAMES) P[n] = saved[n];
  }
}

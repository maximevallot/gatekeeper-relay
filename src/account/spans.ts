// Time across devices, counted once. Each device sends spans of real time ("social, from 21:04:10 to
// 21:04:15"); for each bucket the account keeps the union of today's spans, and the bucket's seconds are the
// union's length. Two browsers with YouTube in front at the same moment count once; a span sent twice, or
// late, changes nothing it shouldn't.

export type Interval = [number, number];

export interface DaySpans {
  /** The Gatekeeper day these unions belong to (usage.day), and its bounds on the account's clock. */
  day: string | null;
  begin: number;
  end: number;
  /** Bucket -> union of intervals ("social", "s:lequipe.fr", "v:v1"). */
  buckets: Record<string, Interval[]>;
  /** Every span, whatever it counted: passes run down on this. */
  any: Interval[];
  /** Spans that counted a site's own limit and its kind too, by the first bucket: the week counts them once. */
  twice: Record<string, Interval[]>;
  /** Seconds that came without spans: a device's minutes when the account was made or the device joined. */
  extra: Record<string, number>;
  extraTwice: number;
}

export function emptyDay(day: string | null = null, begin = 0, end = 0): DaySpans {
  return { day, begin, end, buckets: {}, any: [], twice: {}, extra: {}, extraTwice: 0 };
}

/** The union of a sorted, non-overlapping list and one more interval. Touching intervals (within 1 s) join. */
export function addInterval(list: Interval[], [a, b]: Interval): Interval[] {
  if (!(b > a)) return list;
  const out: Interval[] = [];
  let lo = a, hi = b, placed = false;
  for (const [x, y] of list) {
    if (y < lo - 1000) out.push([x, y]);
    else if (x > hi + 1000) {
      if (!placed) { out.push([lo, hi]); placed = true; }
      out.push([x, y]);
    } else {
      lo = Math.min(lo, x);
      hi = Math.max(hi, y);
    }
  }
  if (!placed) out.push([lo, hi]);
  return out;
}

export function length(list: Interval[], from = -Infinity): number {
  let n = 0;
  for (const [a, b] of list) if (b > from) n += b - Math.max(a, from);
  return n;
}

/** Buckets a device may count: one of the five kinds, a site's own limit, or a video rule. */
const BUCKET = /^(social|video|games|news|shopping|s:[a-z0-9.-]{1,253}|v:v[0-9]{1,6})$/;
export const MAX_SPANS = 2000;

export interface Span {
  seq: number;
  from: number;
  to: number;
  buckets: string[];
}

export function cleanSpans(raw: unknown): Span[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SPANS) return null;
  const out: Span[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) return null;
    const { seq, from, to, buckets } = s as Record<string, unknown>;
    if (!Number.isInteger(seq) || (seq as number) < 0) return null;
    if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to)) return null;
    if (!Array.isArray(buckets) || buckets.length > 4 || !buckets.every((b) => typeof b === "string" && BUCKET.test(b))) return null;
    out.push({ seq: seq as number, from, to, buckets: [...new Set(buckets as string[])] });
  }
  return out;
}

/**
 * Count spans into the day. `offset` turns the device's clock into the account's; parts outside the day,
 * older than 26 hours or after the account's now are cut. Returns the new unions.
 */
export function countSpans(day: DaySpans, spans: Span[], offset: number, now: number): DaySpans {
  const d: DaySpans = { ...day, buckets: { ...day.buckets }, twice: { ...day.twice } };
  const floor = Math.max(day.begin, now - 26 * 3600e3);
  const ceil = Math.min(day.end, now);
  for (const s of spans) {
    const a = Math.max(Math.round(s.from + offset), floor);
    const b = Math.min(Math.round(s.to + offset), ceil);
    if (!(b > a)) continue;
    d.any = addInterval(d.any, [a, b]);
    for (const k of s.buckets) d.buckets[k] = addInterval(d.buckets[k] || [], [a, b]);
    if (s.buckets.length > 1) d.twice[s.buckets[0]!] = addInterval(d.twice[s.buckets[0]!] || [], [a, b]);
  }
  return d;
}

/** Today's seconds per bucket, and the seconds counted twice, as the engine keeps them in usage. */
export function usageSeconds(day: DaySpans): { seconds: Record<string, number>; twice: number } {
  const seconds: Record<string, number> = { ...day.extra };
  for (const [k, list] of Object.entries(day.buckets)) seconds[k] = (seconds[k] || 0) + Math.round(length(list) / 1000);
  let twice = day.extraTwice;
  for (const list of Object.values(day.twice)) twice += Math.round(length(list) / 1000);
  return { seconds, twice };
}

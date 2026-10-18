// When two Gatekeepers meet (design section 2): the result is never looser than the stricter of the two, and
// nothing is lost. The account's rules stay whole; the joining device's rules are handed back so the user can
// offer them as a rule change, which goes through the agent like any loosening.
// This lives here until the engine has its own join(account, local, choice) (design step 2).

import { engine, inZone, type State } from "./engine";

export interface Merged {
  state: State;
  /** Seconds per bucket the joining device had counted today, to add to the account's. */
  extra: Record<string, number>;
  extraTwice: number;
  rulesDiffer: boolean;
  lostRules: State | null;
}

const MAX_TURNS = 50, MAX_LOG = 300, HISTORY_DAYS = 30;

/** Rules compared as the user sees them: exam mode is merged on its own, so it is left out here. */
function rulesKey(r: State | undefined): string {
  if (!r) return "";
  const { exam, ...rest } = r;
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(rest));
}

function byTime<T extends { at?: number }>(a: T[] = [], b: T[] = [], max: number): T[] {
  const seen = new Set<string>();
  return [...a, ...b]
    .filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => (x.at || 0) - (y.at || 0))
    .slice(-max);
}

export function merge(account: State, joining: State, opts: { tz: string; now: number; device: string }): Merged {
  const local = inZone(opts.tz, () => engine.upgrade(joining));
  let s: State = { ...account };
  const sameDay = local.usage && local.usage.day && local.usage.day === s.usage.day;
  const extra: Record<string, number> = {};
  if (sameDay) for (const [k, v] of Object.entries(local.usage.seconds || {})) if (typeof v === "number" && v > 0) extra[k] = Math.round(v);
  const extraTwice = sameDay && typeof local.usage.twice === "number" ? Math.round(local.usage.twice) : 0;

  // Exam mode: if either has it on, it stays on until the later end, as a tightening.
  const theirs = local.rules && local.rules.exam;
  if (theirs && theirs.until > opts.now) {
    const r = inZone(opts.tz, () => engine.startExam(s, { until: theirs.until, goal: theirs.goal, source: "join" }, opts.now));
    s = r.state;
  }

  const differ = rulesKey(s.rules) !== rulesKey(local.rules);
  s = {
    ...s,
    goal: s.goal || local.goal || "",
    thread: { turns: byTime(s.thread?.turns, local.thread?.turns, MAX_TURNS), card: s.thread?.card || null },
    log: byTime(s.log, local.log, MAX_LOG),
    history: [...(s.history || []), ...(local.history || []).filter((h: State) => !(s.history || []).some((x: State) => x.day === h.day))]
      .sort((a: State, b: State) => String(a.day).localeCompare(String(b.day)))
      .slice(-HISTORY_DAYS),
    sorted: { ...(local.sorted || {}), ...(s.sorted || {}) },
    judged: { ...(local.judged || {}), ...(s.judged || {}) },
    setupDone: !!(s.setupDone || local.setupDone),
  };
  s = { ...s, log: inZone(opts.tz, () => engine.logEvent(s, "join", { device: opts.device, rulesDiffer: differ || undefined })) };
  return { state: s, extra, extraTwice, rulesDiffer: differ, lostRules: differ ? local.rules : null };
}

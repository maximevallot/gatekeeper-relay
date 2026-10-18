export const KINDS = ["social", "video", "games", "news", "shopping", "work", "study", "other"] as const;
export type Kind = (typeof KINDS)[number];

/**
 * The kinds the extension can limit. /sort may still answer work, study or other, which mean
 * "not limitable"; the rules chat may only budget, unwatch or place a site into these five.
 */
export const LIMITABLE = ["social", "video", "games", "news", "shopping"] as const;
export type Limitable = (typeof LIMITABLE)[number];
export const isLimitable = (k: unknown): k is Limitable => typeof k === "string" && (LIMITABLE as readonly string[]).includes(k);

/** The extension makes its installId with crypto.randomUUID() on first run. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

export class BadRequest extends Error {}

type Obj = Record<string, unknown>;

export function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function installId(body: Obj): string {
  const id = body.installId;
  if (typeof id !== "string" || !UUID.test(id)) throw new BadRequest("invalid_install_id");
  return id.toLowerCase();
}

function str(body: Obj, key: string, max: number, required: boolean): string {
  const v = body[key];
  if (v === undefined || v === null) {
    if (required) throw new BadRequest(`missing_${key}`);
    return "";
  }
  if (typeof v !== "string") throw new BadRequest(`invalid_${key}`);
  const s = v.trim();
  if (required && !s) throw new BadRequest(`missing_${key}`);
  if (s.length > max) throw new BadRequest(`${key}_too_long`);
  return s;
}

function minutes(body: Obj, key: string): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1440) throw new BadRequest(`invalid_${key}`);
  return Math.round(v);
}

/** Local time with its offset, as the extension sends it: "2026-10-17T14:05:00-04:00". */
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isLocalTime(v: unknown): v is string {
  return typeof v === "string" && LOCAL_TIME.test(v) && !Number.isNaN(Date.parse(v));
}

export interface Exam {
  until: string;
  goal: string;
  /** The exam's own time (a calendar event's start, or one the student gave), if known. */
  at: string | null;
}

/** Exam mode in one line, as the prompts read it. */
export function examText(exam: Exam | null): string {
  if (!exam) return "off";
  return `on until ${exam.until}${exam.goal ? `, for "${exam.goal}"` : ""}${exam.at ? `; the exam itself is at ${exam.at}` : ""}`;
}

/** `now`, optional: the student's local time with its offset. */
function now(body: Obj): string | null {
  const v = body.now;
  if (v === undefined || v === null) return null;
  if (!isLocalTime(v)) throw new BadRequest("invalid_now");
  return v;
}

/** `exam`, optional: {until, goal} while exam mode is on, null or absent when it is off. */
function exam(body: Obj): Exam | null {
  const v = body.exam;
  if (v === undefined || v === null) return null;
  if (!isObject(v) || !isLocalTime(v.until)) throw new BadRequest("invalid_exam");
  const goal = v.goal ?? "";
  if (typeof goal !== "string" || goal.length > 300) throw new BadRequest("invalid_exam");
  // The extension calls it examAt; at is accepted too.
  const at = v.examAt ?? v.at ?? null;
  if (at !== null && !isLocalTime(at)) throw new BadRequest("invalid_exam");
  return { until: v.until, goal: goal.replace(/\s+/g, " ").replace(/"/g, "'").trim(), at };
}

/** Lowercases, drops a scheme, path, port and leading "www.", and checks what is left is a hostname. */
export function domain(raw: unknown, key = "domain"): string {
  if (typeof raw !== "string") throw new BadRequest(`invalid_${key}`);
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0]!.replace(/:\d+$/, "").replace(/\.$/, "");
  d = d.replace(/^www\./, "");
  if (!HOSTNAME.test(d)) throw new BadRequest(`invalid_${key}`);
  return d;
}

export interface GateInput {
  installId: string;
  goal: string;
  site: string;
  /** "site": the site has its own limit, and minutesUsed and budget are that site's own. */
  kind: Kind | "site";
  minutesUsed: number;
  budget: number;
  deadlines: string[];
  message: string;
  now: string | null;
  exam: Exam | null;
}

export function gateInput(body: Obj): GateInput {
  const kind = body.kind;
  if (typeof kind !== "string" || !(kind === "site" || (KINDS as readonly string[]).includes(kind))) throw new BadRequest("invalid_kind");
  const rawDeadlines = body.deadlines ?? [];
  if (!Array.isArray(rawDeadlines) || rawDeadlines.length > 10) throw new BadRequest("invalid_deadlines");
  const deadlines = rawDeadlines.map((d) => {
    // Either "PMR worksheet, 2026-10-18" or {title, due}.
    if (typeof d === "string" && d.trim() && d.length <= 160) return d.trim();
    if (isObject(d) && typeof d.title === "string" && d.title.trim() && d.title.length <= 120) {
      const due = typeof d.due === "string" && d.due.length <= 40 ? d.due.trim() : "";
      return due ? `${d.title.trim()} (due ${due})` : d.title.trim();
    }
    throw new BadRequest("invalid_deadlines");
  });
  return {
    installId: installId(body),
    goal: str(body, "goal", 300, false),
    site: domain(body.site, "site"),
    kind: kind as Kind | "site",
    minutesUsed: minutes(body, "minutesUsed"),
    budget: minutes(body, "budget"),
    deadlines,
    message: str(body, "message", 500, true),
    now: now(body),
    exam: exam(body),
  };
}

export interface SortInput {
  installId: string;
  domain: string;
  title: string;
}

export function sortInput(body: Obj): SortInput {
  return {
    installId: installId(body),
    domain: domain(body.domain),
    title: str(body, "title", 200, false),
  };
}

// ---------- video rules and the rules chat (milestone 3) ----------

const VIDEO_ID = /^v[0-9]{1,6}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const VIDEO_SITES = ["youtube.com"] as const;

export interface VideoRuleText {
  id: string;
  about: string;
  except: string;
}

export interface JudgeInput {
  installId: string;
  site: string;
  title: string;
  channel: string;
  rules: VideoRuleText[];
}

function plain(v: unknown, key: string, max: number, required: boolean): string {
  if (v === undefined || v === null) {
    if (required) throw new BadRequest(`missing_${key}`);
    return "";
  }
  if (typeof v !== "string") throw new BadRequest(`invalid_${key}`);
  const s = v.replace(/\s+/g, " ").trim();
  if (required && !s) throw new BadRequest(`missing_${key}`);
  if (s.length > max) throw new BadRequest(`${key}_too_long`);
  return s;
}

function videoRuleTexts(raw: unknown, max: number): VideoRuleText[] {
  if (!Array.isArray(raw) || raw.length > max) throw new BadRequest("invalid_rules");
  const ids = new Set<string>();
  return raw.map((r) => {
    if (!isObject(r) || typeof r.id !== "string" || !VIDEO_ID.test(r.id) || ids.has(r.id)) throw new BadRequest("invalid_rules");
    ids.add(r.id);
    return { id: r.id, about: plain(r.about, "about", 200, true), except: plain(r.except, "except", 200, false) };
  });
}

export function judgeInput(body: Obj): JudgeInput {
  const site = domain(body.site, "site");
  if (!(VIDEO_SITES as readonly string[]).includes(site)) throw new BadRequest("invalid_site");
  const rules = videoRuleTexts(body.rules, 20);
  if (!rules.length) throw new BadRequest("invalid_rules");
  return {
    installId: installId(body),
    site,
    title: plain(body.title, "title", 200, true),
    channel: plain(body.channel, "channel", 100, false),
    rules,
  };
}

export interface VideoRuleState extends VideoRuleText {
  site: string;
  /** null: free. 0: closed. Otherwise its own minutes a day. */
  minutes: number | null;
}

export interface RulesState {
  kinds: Partial<Record<Kind, number>>;
  sites: Record<string, Kind>;
  /** A site's own daily minutes, independent of its kind. 0: closed. null: no daily limit, closed only in exam mode. */
  siteLimits: Record<string, number | null>;
  videos: VideoRuleState[];
  dayStart: number;
}

export interface Turn {
  role: "user" | "gatekeeper";
  text: string;
}

export interface RulesInput {
  installId: string;
  message: string;
  today: string;
  history: Turn[];
  rules: RulesState;
  now: string | null;
  exam: Exam | null;
  /** An earlier no holds every loosening until the morning (QA round 3, N1). */
  loosenLocked: boolean;
  /** The first week: Gatekeeper only watches and closes nothing (the extension sends `watching: true`). */
  watching: boolean;
}

function ruleMinutes(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1440) throw new BadRequest("invalid_rules");
  return Math.round(v);
}

function rulesState(raw: unknown): RulesState {
  if (!isObject(raw)) throw new BadRequest("invalid_rules");
  const kinds: Partial<Record<Kind, number>> = {};
  if (!isObject(raw.kinds ?? {})) throw new BadRequest("invalid_rules");
  for (const [k, v] of Object.entries((raw.kinds ?? {}) as Obj)) {
    if (!(KINDS as readonly string[]).includes(k)) throw new BadRequest("invalid_rules");
    kinds[k as Kind] = ruleMinutes(v);
  }
  const sites: Record<string, Kind> = {};
  const rawSites = (raw.sites ?? {}) as Obj;
  if (!isObject(rawSites) || Object.keys(rawSites).length > 100) throw new BadRequest("invalid_rules");
  for (const [d, k] of Object.entries(rawSites)) {
    if (typeof k !== "string" || !(KINDS as readonly string[]).includes(k)) throw new BadRequest("invalid_rules");
    sites[domain(d, "rules")] = k as Kind;
  }
  const siteLimits: Record<string, number | null> = {};
  const rawLimits = (raw.siteLimits ?? {}) as Obj;
  if (!isObject(rawLimits) || Object.keys(rawLimits).length > 100) throw new BadRequest("invalid_rules");
  for (const [d, m] of Object.entries(rawLimits)) siteLimits[domain(d, "rules")] = m === null ? null : ruleMinutes(m);
  if (!Array.isArray(raw.videos ?? []) || ((raw.videos ?? []) as unknown[]).length > 20) throw new BadRequest("invalid_rules");
  const texts = videoRuleTexts(raw.videos ?? [], 20);
  const videos = texts.map((t, i) => {
    const v = (raw.videos as Obj[])[i]!;
    if (!(VIDEO_SITES as readonly string[]).includes(String(v.site))) throw new BadRequest("invalid_rules");
    const m = v.minutes === null || v.minutes === undefined ? null : ruleMinutes(v.minutes);
    return { ...t, site: String(v.site), minutes: m };
  });
  const ds = raw.dayStart ?? 4;
  if (typeof ds !== "number" || !Number.isInteger(ds) || ds < 0 || ds > 23) throw new BadRequest("invalid_rules");
  return { kinds, sites, siteLimits, videos, dayStart: ds };
}

export function rulesInput(body: Obj): RulesInput {
  const today = body.today;
  if (typeof today !== "string" || !DAY.test(today)) throw new BadRequest("invalid_today");
  const rawHistory = body.history ?? [];
  if (!Array.isArray(rawHistory) || rawHistory.length > 6) throw new BadRequest("invalid_history");
  const history = rawHistory.map((h) => {
    if (!isObject(h) || (h.role !== "user" && h.role !== "gatekeeper")) throw new BadRequest("invalid_history");
    return { role: h.role, text: plain(h.text, "history", 500, true) } as Turn;
  });
  return {
    installId: installId(body),
    message: str(body, "message", 500, true),
    today,
    history,
    rules: rulesState(body.rules),
    now: now(body),
    exam: exam(body),
    loosenLocked: body.loosenLocked === true,
    watching: body.watching === true || body.watch === true,
  };
}

export interface LoosenInput {
  installId: string;
  kind: "rules" | "exam";
  goal: string;
  /** What the student asked to loosen, in plain words. */
  changes: string[];
  /** The one question asked earlier about this request, if any. */
  asked: string;
  message: string;
  now: string | null;
  exam: Exam | null;
}

/** A request to loosen a rule or end exam mode early, with the student's reason. */
export function loosenInput(body: Obj): LoosenInput {
  const kind = body.kind;
  if (kind !== "rules" && kind !== "exam") throw new BadRequest("invalid_kind");
  const raw = body.changes;
  if (!Array.isArray(raw) || !raw.length || raw.length > 10) throw new BadRequest("invalid_changes");
  const changes = raw.map((c) => plain(c, "changes", 200, true));
  return {
    installId: installId(body),
    kind,
    goal: plain(body.goal, "goal", 300, false),
    changes,
    asked: plain(body.asked, "asked", 300, false),
    message: str(body, "message", 500, true),
    now: now(body),
    exam: exam(body),
  };
}

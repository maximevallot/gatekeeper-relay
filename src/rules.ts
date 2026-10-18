import rulesPrompt from "../prompts/rules.md";
import { askClaude } from "./claude";
import type { Env } from "./env";
import { voice } from "./voice";
import { BadRequest, domain, examText, isLimitable, isLocalTime, LIMITABLE, type Limitable, type RulesInput, VIDEO_SITES } from "./validate";

export type Op =
  | { op: "budget"; kind: Limitable; minutes: number }
  | { op: "unwatch"; kind: Limitable }
  | { op: "site"; domain: string; kind: Limitable }
  | { op: "unsite"; domain: string }
  | { op: "siteLimit"; domain: string; minutes: number | null }
  | { op: "dropSiteLimit"; domain: string }
  | {
      op: "addVideo";
      site: string;
      about: string;
      except: string;
      minutes: number | null;
      words: { match: string[]; except: string[] };
    }
  | { op: "videoBudget"; id: string; minutes: number | null }
  | { op: "dropVideo"; id: string }
  | { op: "dayStart"; hour: number }
  | { op: "examStart"; until: string; goal: string; at: string | null }
  | { op: "examEnd" };

export interface RulesResult {
  reply: string;
  question: string | null;
  diff: Op[];
}

const MAX_OPS = 10;
const kind = { type: "string", enum: [...LIMITABLE] };
const nullableInt = { anyOf: [{ type: "integer" }, { type: "null" }] };
const obj = (op: string, props: Record<string, unknown>) => ({
  type: "object",
  properties: { op: { type: "string", const: op }, ...props },
  required: ["op", ...Object.keys(props)],
  additionalProperties: false,
});

const SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    question: { anyOf: [{ type: "string" }, { type: "null" }] },
    diff: {
      type: "array",
      items: {
        anyOf: [
          obj("budget", { kind, minutes: { type: "integer" } }),
          obj("unwatch", { kind }),
          obj("site", { domain: { type: "string" }, kind }),
          obj("unsite", { domain: { type: "string" } }),
          obj("siteLimit", { domain: { type: "string" }, minutes: nullableInt }),
          obj("dropSiteLimit", { domain: { type: "string" } }),
          obj("addVideo", {
            site: { type: "string", enum: [...VIDEO_SITES] },
            about: { type: "string" },
            except: { type: "string" },
            minutes: nullableInt,
            words: {
              type: "object",
              properties: { match: { type: "array", items: { type: "string" } }, except: { type: "array", items: { type: "string" } } },
              required: ["match", "except"],
              additionalProperties: false,
            },
          }),
          obj("videoBudget", { id: { type: "string" }, minutes: nullableInt }),
          obj("dropVideo", { id: { type: "string" } }),
          obj("dayStart", { hour: { type: "integer" } }),
          obj("examStart", { until: { type: "string" }, goal: { type: "string" }, at: { anyOf: [{ type: "string" }, { type: "null" }] } }),
          obj("examEnd", {}),
        ],
      },
    },
  },
  required: ["reply", "question", "diff"],
  additionalProperties: false,
};

const FALLBACK: RulesResult = {
  reply: "I couldn't turn that into a rule change. Say which sites or videos, and how many minutes a day.",
  question: null,
  diff: [],
};

const minutesText = (m: number | null) => (m === null ? "free" : m === 0 ? "closed" : `${m} min a day`);

export function rulesUserMessage(input: RulesInput): string {
  const r = input.rules;
  const kinds = Object.entries(r.kinds).map(([k, m]) => `${k} ${minutesText(m ?? 0)}`);
  const sites = Object.entries(r.sites).map(([d, k]) => `${d} counted as ${k}`);
  const siteLimits = Object.entries(r.siteLimits).map(
    ([d, m]) => `${d} ${m === null ? "closed only in exam mode" : minutesText(m)}`,
  );
  const videos = r.videos.map(
    (v) => `  - ${v.id} on ${v.site}: about "${v.about}"${v.except ? `, except "${v.except}"` : ""}, ${minutesText(v.minutes)}`,
  );
  const history = input.history.map((h) => `${h.role === "user" ? "student" : "gatekeeper"}: ${h.text.replace(/<\/?message>/gi, "")}`);
  const exam = examText(input.exam);
  return [
    input.now ? `now: ${input.now}` : `today: ${input.today}`,
    "rules now:",
    `- watched kinds: ${kinds.length ? kinds.join(", ") : "none"} (kinds not listed have no limit)`,
    `- the student's own sites: ${sites.length ? sites.join(", ") : "none"}`,
    `- sites with their own limit: ${siteLimits.length ? siteLimits.join(", ") : "none"}`,
    `- video rules:${videos.length ? "\n" + videos.join("\n") : " none"}`,
    `- the day starts at ${r.dayStart}:00`,
    `- exam mode: ${exam}`,
    ...(input.loosenLocked ? [`- loosening: locked until ${r.dayStart}:00 tomorrow by an earlier no; only stricter changes can apply`] : []),
    "",
    `conversation so far:${history.length ? "\n" + history.join("\n") : " none"}`,
    "",
    `<message>\n${input.message.replace(/<\/?message>/gi, "")}\n</message>`,
  ].join("\n");
}

const cut = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const clampMinutes = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 1440) : null;
const words = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.map((w) => cut(w, 40).toLowerCase()).filter(Boolean))].slice(0, 20) : [];
const MAX_EXAM_MS = 30 * 24 * 60 * 60 * 1000;

function cleanDomain(raw: unknown): string | null {
  try {
    return domain(raw);
  } catch (err) {
    if (err instanceof BadRequest) return null;
    throw err;
  }
}

/**
 * An exam end time must be a local time with an offset, after now, at most 30 days ahead, and,
 * while exam mode is on, no earlier than its current end: shortening is ending early, which is examEnd.
 */
function examUntil(v: unknown, input: RulesInput): string | null {
  if (!isLocalTime(v)) return null;
  const t = Date.parse(v);
  const now = input.now ? Date.parse(input.now) : Date.now();
  if (t <= now || t - now > MAX_EXAM_MS) return null;
  if (input.exam && t < Date.parse(input.exam.until)) return null;
  return v;
}

/** One operation as the model wrote it, checked and clamped, or null if it cannot stand. */
function cleanOp(raw: unknown, videoIds: Set<string>, input: RulesInput): Op | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  switch (o.op) {
    case "budget": {
      const m = clampMinutes(o.minutes);
      return isLimitable(o.kind) && m !== null ? { op: "budget", kind: o.kind, minutes: m } : null;
    }
    case "unwatch":
      return isLimitable(o.kind) ? { op: "unwatch", kind: o.kind } : null;
    case "site": {
      const d = cleanDomain(o.domain);
      return d && isLimitable(o.kind) ? { op: "site", domain: d, kind: o.kind } : null;
    }
    case "unsite": {
      const d = cleanDomain(o.domain);
      return d ? { op: "unsite", domain: d } : null;
    }
    case "siteLimit": {
      const d = cleanDomain(o.domain);
      if (o.minutes === null) return d ? { op: "siteLimit", domain: d, minutes: null } : null;
      const m = clampMinutes(o.minutes);
      return d && m !== null ? { op: "siteLimit", domain: d, minutes: m } : null;
    }
    case "dropSiteLimit": {
      const d = cleanDomain(o.domain);
      return d && d in input.rules.siteLimits ? { op: "dropSiteLimit", domain: d } : null;
    }
    case "addVideo": {
      const about = cut(o.about, 200);
      if (!about || !(VIDEO_SITES as readonly string[]).includes(String(o.site))) return null;
      const w = (o.words ?? {}) as Record<string, unknown>;
      return {
        op: "addVideo", site: String(o.site), about, except: cut(o.except, 200),
        minutes: o.minutes === null ? null : clampMinutes(o.minutes),
        words: { match: words(w.match), except: words(w.except) },
      };
    }
    case "videoBudget":
      return typeof o.id === "string" && videoIds.has(o.id)
        ? { op: "videoBudget", id: o.id, minutes: o.minutes === null ? null : clampMinutes(o.minutes) }
        : null;
    case "dropVideo":
      return typeof o.id === "string" && videoIds.has(o.id) ? { op: "dropVideo", id: o.id } : null;
    case "dayStart": {
      const h = o.hour;
      return typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 23 ? { op: "dayStart", hour: h } : null;
    }
    case "examStart": {
      const until = examUntil(o.until, input);
      if (!until) return null;
      // The exam's own time, if the student gave it ("exam thursday 9am"): no later than exam mode's end, and not
      // long past. With it, a yes to "the exam is over" can end exam mode at once once that time has come.
      const t = isLocalTime(o.at) ? Date.parse(o.at) : NaN;
      const now = input.now ? Date.parse(input.now) : Date.now();
      const at = Number.isFinite(t) && t <= Date.parse(until) && t > now - 86400e3 ? (o.at as string) : null;
      return { op: "examStart", until, goal: cut(o.goal, 300), at };
    }
    case "examEnd":
      return input.exam ? { op: "examEnd" } : null;
    default:
      return null;
  }
}

/**
 * Whatever the model returns, the server has the last word: the five limitable kinds only, minutes from 0 to 1440,
 * exam times that make sense, examEnd only while exam mode is on,
 * video rules only on supported sites and only for ids the student has, at most ten operations, short
 * text, and a question replaces any change. The extension checks it all again before showing a card.
 */
export function enforceRules(data: unknown, input: RulesInput): RulesResult {
  if (typeof data !== "object" || data === null) return FALLBACK;
  const d = data as Record<string, unknown>;
  const reply = cut(typeof d.reply === "string" ? voice(d.reply) : d.reply, 500);
  const question = cut(d.question, 300) || null;
  if (question) return { reply, question, diff: [] };
  const ids = new Set(input.rules.videos.map((v) => v.id));
  const diff = (Array.isArray(d.diff) ? d.diff : [])
    .slice(0, MAX_OPS)
    .map((op) => cleanOp(op, ids, input))
    .filter((op): op is Op => op !== null)
    // One exam change per card: starting and ending in the same breath makes no sense.
    .filter((op, i, all) => !op.op.startsWith("exam") || all.findIndex((o) => o.op.startsWith("exam")) === i);
  if (input.loosenLocked) {
    // After a no, nothing loosens until the morning: those changes leave the card, and the reply says so
    // plainly instead of promising them (QA round 3, N1).
    const tight = diff.filter((op) => !loosens(op, input.rules));
    if (tight.length < diff.length) {
      const after = `ask again after ${input.rules.dayStart}:00`;
      return {
        reply: tight.length
          ? `The stricter part applies now. I said no to a loosening today, so the rest waits: ${after}.`
          : `I said no to a loosening today, so that waits: ${after}.`,
        question: null,
        diff: tight,
      };
    }
  }
  if (!reply && !diff.length) return FALLBACK;
  return { reply: honest(reply || "Here is the change.", diff, input), question: null, diff };
}

const WATCH_WEEK = "This first week Gatekeeper only watches and closes nothing, so your limits start when the week ends.";
const LABELS: Record<string, string> = { social: "Social media", video: "Video", games: "Games", news: "News", shopping: "Shopping" };
const amount = (m: number | null | undefined, free = "no limit") =>
  m === undefined ? "no limit" : m === null ? free : m === 0 ? "closed all day" : `${m} minutes a day`;

/** One loosening in plain words, from the rules as sent: "Video: 10 → 20 minutes a day". */
export function describeLoosening(op: Op, r: RulesInput["rules"]): string {
  const kinds = r.kinds as Record<string, number | undefined>;
  const video = (id: string) => r.videos.find((v) => v.id === id);
  switch (op.op) {
    case "budget": return `${LABELS[op.kind]}: ${amount(kinds[op.kind]).replace(" minutes a day", "")} → ${amount(op.minutes)}`;
    case "unwatch": return `${LABELS[op.kind]}: no limit`;
    case "unsite": return `${op.domain}: back to Gatekeeper's own list`;
    case "siteLimit": return `${op.domain}: ${amount(r.siteLimits[op.domain], "closed only in exam mode").replace(" minutes a day", "")} → ${amount(op.minutes, "closed only in exam mode")}`;
    case "dropSiteLimit": return `${op.domain}: no limit of its own`;
    case "addVideo": return `Videos about ${op.about}: no limit`;
    case "videoBudget": { const v = video(op.id); return `Videos about ${v ? v.about : "that"}: ${amount(v?.minutes).replace(" minutes a day", "")} → ${amount(op.minutes)}`; }
    case "dropVideo": { const v = video(op.id); return `The rule on videos about ${v ? v.about : "that"} goes`; }
    case "dayStart": return `The day starts at ${op.hour}:00`;
    case "examEnd": return "Ending exam mode early";
    default: return "That change";
  }
}

/**
 * The reply never says a loosening is done before Gatekeeper said yes (Maxime's test: "actually no 20min"
 * got "Video is now limited to 20 minutes"), and never promises "now" in the watch week. A card that loosens
 * gets its reply from the changes themselves; in the watch week, timing sentences go and the week is named.
 */
export function honest(reply: string, diff: Op[], input: RulesInput): string {
  const loose = diff.filter((op) => loosens(op, input.rules));
  const tight = diff.length > loose.length;
  if (loose.length) {
    const what = loose.map((op) => describeLoosening(op, input.rules)).join("; ");
    const tail = input.watching ? ` ${WATCH_WEEK}` : tight ? " The stricter part applies now." : "";
    return `${what}. That gives you more time, so Gatekeeper will ask you why before it changes.${tail}`;
  }
  if (input.watching && diff.length) {
    const kept = reply.split(/(?<=[.!?])\s+/).filter((s) => !/\b(now|at once|immediately|right away)\b/i.test(s));
    return [...kept, WATCH_WEEK].join(" ").trim();
  }
  return reply;
}

/** Whether a change could give more time than the rules as sent. Unsure cases count as loosening. */
export function loosens(op: Op, r: RulesInput["rules"]): boolean {
  const kinds = r.kinds as Record<string, number | undefined>;
  switch (op.op) {
    case "budget": return kinds[op.kind] !== undefined && op.minutes > kinds[op.kind]!;
    case "unwatch": return kinds[op.kind] !== undefined;
    case "site": return false; // a site put in a kind: the extension's tighten() judges it with every site under it
    case "unsite": return true;
    case "siteLimit": {
      if (!(op.domain in r.siteLimits)) return op.minutes === null;
      const cur = r.siteLimits[op.domain];
      if (op.minutes === null) return cur !== null;
      return cur === null ? false : op.minutes > cur!;
    }
    case "dropSiteLimit": return true;
    case "addVideo": return op.minutes === null;
    case "videoBudget": {
      const v = r.videos.find((x) => x.id === op.id);
      if (!v) return true;
      if (op.minutes === null) return v.minutes !== null;
      return v.minutes === null ? false : op.minutes > v.minutes;
    }
    case "dropVideo": return (r.videos.find((x) => x.id === op.id)?.minutes ?? null) !== null;
    case "dayStart": return op.hour !== r.dayStart;
    case "examEnd": return true;
    case "examStart": return false;
  }
}

export async function rules(env: Env, input: RulesInput): Promise<{ result: RulesResult; tokens: number }> {
  const out = await askClaude(env, { system: rulesPrompt, user: rulesUserMessage(input), schema: SCHEMA, maxTokens: 2048 });
  return { result: out.ok ? enforceRules(out.data, input) : FALLBACK, tokens: out.tokens };
}

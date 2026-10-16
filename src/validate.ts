export const KINDS = ["social", "video", "games", "news", "shopping", "work", "study", "other"] as const;
export type Kind = (typeof KINDS)[number];

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
  kind: Kind;
  minutesUsed: number;
  budget: number;
  deadlines: string[];
  message: string;
}

export function gateInput(body: Obj): GateInput {
  const kind = body.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) throw new BadRequest("invalid_kind");
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
    kind: kind as Kind,
    minutesUsed: minutes(body, "minutesUsed"),
    budget: minutes(body, "budget"),
    deadlines,
    message: str(body, "message", 500, true),
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

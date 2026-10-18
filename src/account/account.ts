// One person's Gatekeeper account: a Durable Object running the extension's engine. It holds the only true
// copy of the state; devices keep a copy, decide pages from it, and sync. A Durable Object handles one
// request at a time, so the account has one writer, as background.js has in the browser.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { copyOf, engine, inZone, todayFor, type State } from "./engine";
import { merge } from "./merge";
import { HANDLERS, MAC_ALLOWED } from "./requests";
import { cleanSpans, countSpans, emptyDay, length, usageSeconds, type DaySpans } from "./spans";
import { validTimeZone } from "./tz";

export const CONTRACT = 1;
const MAX_DEVICES = 10;
const MAX_ANSWERS = 200;
const MAX_REQUESTS = 20;
const LOST_DAYS = 30;
const CODE_MS = 10 * 60e3;

export interface Device {
  id: string;
  name: string;
  kind: "extension" | "mac" | "phone";
  keyHash: string;
  joinedAt: number;
  seenAt: number;
  seq: number; // the highest span seq counted from this device
}

interface Meta {
  accountId: string;
  createdAt: number;
  tz: string;
  version: number;
  copyHash: string;
}

interface Aux {
  day: DaySpans;
  /** Passes running down on real time: domain -> when granted and for how long. */
  passes: Record<string, { at: number; seconds: number }>;
  lost: { at: number; device: string; rules: State }[];
}

export type Reply = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, more: Record<string, unknown> = {}): Reply => ({ status, body: { v: CONTRACT, error, ...more } });
const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { v: CONTRACT, ...body } });

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function secret(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A device's only secret: "gk1.<accountId>.<deviceId>.<key>". */
export function parseToken(token: string | null): { accountId: string; deviceId: string; key: string } | null {
  const m = /^gk1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token || "");
  return m ? { accountId: m[1]!, deviceId: m[2]!, key: m[3]! } : null;
}

export interface DeviceInfo { name: string; kind: Device["kind"] }

export class Account extends DurableObject<Env> {
  private async meta(): Promise<Meta | undefined> {
    return this.ctx.storage.get<Meta>("meta");
  }
  private async devices(): Promise<Record<string, Device>> {
    return (await this.ctx.storage.get<Record<string, Device>>("devices")) || {};
  }
  private async aux(): Promise<Aux> {
    return (await this.ctx.storage.get<Aux>("aux")) || { day: emptyDay(), passes: {}, lost: [] };
  }

  /** Read the clock: roll the day over, and keep the span unions on the same day as the engine. */
  private roll(state: State, aux: Aux, tz: string, now: number): { state: State; aux: Aux } {
    let s = inZone(tz, () => engine.rollover({ ...state, clock: { ...(state.clock || { floor: 0 }), guard: false } }, now));
    if (aux.day.day !== s.usage.day) {
      const end = s.usage.endsAt;
      const begin = inZone(tz, () => engine.nextDayStart(end - 26 * 3600e3, s.rules.dayStart));
      aux = { ...aux, day: emptyDay(s.usage.day, begin, end), passes: {} };
    }
    return { state: s, aux };
  }

  /** Today's seconds from the spans, and every pass run down on the union of all spans since it was granted. */
  private settle(state: State, aux: Aux, now: number): { state: State; aux: Aux } {
    const { seconds, twice } = usageSeconds(aux.day);
    const passes: State = {};
    const timers: Aux["passes"] = {};
    for (const [domain, p] of Object.entries((state.passes || {}) as Record<string, State>)) {
      const timer = aux.passes[domain] || { at: now, seconds: p.secondsLeft };
      const left = Math.round(timer.seconds - length(aux.day.any, timer.at) / 1000);
      if (left > 0) { passes[domain] = { ...p, secondsLeft: left }; timers[domain] = timer; }
    }
    return { state: { ...state, usage: { ...state.usage, seconds, twice }, passes }, aux: { ...aux, passes: timers } };
  }

  private async save(meta: Meta, state: State, aux: Aux, devices?: Record<string, Device>): Promise<Meta> {
    const hash = await sha256(JSON.stringify(copyOf(state)));
    const m = hash === meta.copyHash ? meta : { ...meta, version: meta.version + 1, copyHash: hash };
    const put: Record<string, unknown> = { meta: m, state, aux };
    if (devices) put.devices = devices;
    await this.ctx.storage.put(put);
    return m;
  }

  private async newDevice(info: DeviceInfo, now: number, accountId: string): Promise<{ device: Device; token: string }> {
    const id = crypto.randomUUID();
    const key = secret();
    const device: Device = { id, name: info.name, kind: info.kind, keyHash: await sha256(key), joinedAt: now, seenAt: now, seq: -1 };
    return { device, token: `gk1.${accountId}.${id}.${key}` };
  }

  private async auth(token: string): Promise<{ meta: Meta; devices: Record<string, Device>; device: Device } | Reply> {
    if (await this.ctx.storage.get("deleted")) return fail(410, "account_deleted");
    const t = parseToken(token);
    const meta = await this.meta();
    if (!t || !meta || t.accountId !== meta.accountId) return fail(401, "bad_token");
    const devices = await this.devices();
    const device = devices[t.deviceId];
    if (!device) return fail(401, "device_removed");
    if (device.keyHash !== (await sha256(t.key))) return fail(401, "bad_token");
    return { meta, devices, device };
  }

  // ---------- create, code, join ----------

  async create(accountId: string, info: DeviceInfo, tz: string, from: State | null, now: number): Promise<Reply> {
    if (await this.meta()) return fail(409, "exists");
    let state: State = inZone(tz, () => engine.upgrade(from || null));
    const before = state.usage || {};
    state = { ...state, installId: accountId, clock: { floor: 0 }, judging: {}, unknown: {}, calendar: state.calendar ? { url: null, events: state.calendar.events || [], fetchedAt: now, error: null } : null };
    let aux: Aux = { day: emptyDay(), passes: {}, lost: [] };
    ({ state, aux } = this.roll(state, aux, tz, now));
    if (before.day && before.day === state.usage.day) {
      aux.day.extra = Object.fromEntries(Object.entries(before.seconds || {}).filter(([, v]) => typeof v === "number" && (v as number) > 0)) as Record<string, number>;
      aux.day.extraTwice = typeof before.twice === "number" ? before.twice : 0;
    }
    ({ state, aux } = this.settle(state, aux, now));
    const { device, token } = await this.newDevice(info, now, accountId);
    const meta = await this.save({ accountId, createdAt: now, tz, version: 0, copyHash: "" }, state, aux, { [device.id]: device });
    return ok({ accountId, device: { id: device.id, token }, copy: copyOf(state), version: meta.version, serverNow: now });
  }

  /** A fresh 6-digit code for Add a device; the code before it stops working. */
  async code(token: string, now: number): Promise<Reply> {
    const a = await this.auth(token);
    if ("status" in a) return a;
    const old = await this.ctx.storage.get<string>("code");
    if (old) await this.env.PAIRING.get(this.env.PAIRING.idFromName("code:" + old)).revoke(a.meta.accountId);
    for (let i = 0; i < 8; i++) {
      const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
      const code = String(n).padStart(6, "0");
      const expiresAt = now + CODE_MS;
      if (await this.env.PAIRING.get(this.env.PAIRING.idFromName("code:" + code)).claim(a.meta.accountId, expiresAt, now)) {
        await this.ctx.storage.put("code", code);
        return ok({ code, expiresAt });
      }
    }
    return fail(503, "no_code");
  }

  async join(info: DeviceInfo, tz: string, from: State | null, now: number, wantToday = false): Promise<Reply> {
    if (await this.ctx.storage.get("deleted")) return fail(410, "account_deleted");
    const meta0 = await this.meta();
    if (!meta0) return fail(404, "bad_code");
    const devices = await this.devices();
    if (Object.keys(devices).length >= MAX_DEVICES) return fail(409, "too_many_devices");
    await this.ctx.storage.delete("code");
    const meta = { ...meta0, tz: meta0.tz || tz };
    let state = (await this.ctx.storage.get<State>("state"))!;
    let aux = await this.aux();
    ({ state, aux } = this.roll(state, aux, meta.tz, now));
    let merged = null;
    if (from && typeof from === "object") {
      merged = merge(state, from, { tz: meta.tz, now, device: info.name });
      state = merged.state;
      const extra = { ...aux.day.extra };
      for (const [k, v] of Object.entries(merged.extra)) extra[k] = (extra[k] || 0) + v;
      aux = { ...aux, day: { ...aux.day, extra, extraTwice: aux.day.extraTwice + merged.extraTwice } };
      if (merged.lostRules) aux = { ...aux, lost: [...aux.lost.filter((l) => now - l.at < LOST_DAYS * 86400e3), { at: now, device: info.name, rules: merged.lostRules }] };
    }
    ({ state, aux } = this.settle(state, aux, now));
    const { device, token } = await this.newDevice(info, now, meta.accountId);
    const m = await this.save(meta, state, aux, { ...devices, [device.id]: device });
    return ok({
      accountId: meta.accountId, device: { id: device.id, token }, copy: copyOf(state), version: m.version, serverNow: now,
      merged: merged ? { rulesDiffer: merged.rulesDiffer, lostRules: merged.lostRules } : { rulesDiffer: false, lostRules: null },
      ...(wantToday || info.kind === "mac" ? { today: todayFor(state, meta.tz, now) } : {}),
    });
  }

  // ---------- sync ----------

  async sync(token: string, body: Record<string, any>, ip: string | null, now: number): Promise<Reply> {
    const a = await this.auth(token);
    if ("status" in a) return a;
    let { meta, devices, device } = a;
    const spans = cleanSpans(body.spans);
    if (!spans) return fail(400, "invalid_spans");
    const requests: Record<string, any>[] = Array.isArray(body.requests) ? body.requests : [];
    if (requests.length > MAX_REQUESTS || !requests.every((r) => r && typeof r === "object" && typeof r.id === "string" && r.id.length <= 80 && typeof r.type === "string")) {
      return fail(400, "invalid_requests");
    }
    if (typeof body.tz === "string" && body.tz !== meta.tz && validTimeZone(body.tz)) meta = { ...meta, tz: body.tz };
    const offset = typeof body.now === "number" && Number.isFinite(body.now) ? now - body.now : 0;

    let state = (await this.ctx.storage.get<State>("state"))!;
    let aux = await this.aux();
    ({ state, aux } = this.roll(state, aux, meta.tz, now));
    aux = { ...aux, day: countSpans(aux.day, spans, offset, now) };
    const seq = spans.reduce((m, s) => Math.max(m, s.seq), device.seq);
    ({ state, aux } = this.settle(state, aux, now));

    // Requests, in order. One already answered (the same id) gets its first answer again.
    const answers = (await this.ctx.storage.get<{ id: string; result: unknown }[]>("answers")) || [];
    const results: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    for (const req of requests) {
      const done = answers.find((x) => x.id === req.id);
      if (done) { results.push({ id: req.id, ...(done.result as object) }); continue; }
      let result: Record<string, unknown>;
      // "exam.start" is the Mac's name for it in the native-messaging contract.
      const type = req.type === "exam.start" ? "startExam" : req.type;
      const handler = HANDLERS[type];
      if (!handler) result = { refused: "unknown_type" };
      else if (device.kind === "mac" && !MAC_ALLOWED.has(type)) result = { refused: "mac_cannot_loosen" };
      else {
        const out = await handler(state, req, {
          env: this.env, accountId: meta.accountId, tz: meta.tz, now, ip, deviceKind: device.kind,
          waitUntil: (p) => pending.push(p),
        });
        state = out.state;
        result = out.result;
        if (out.pass) aux = { ...aux, passes: { ...aux.passes, [out.pass.domain]: { at: now, seconds: out.pass.seconds } } };
        ({ state, aux } = this.settle(state, aux, now));
      }
      answers.push({ id: req.id, result });
      results.push({ id: req.id, ...result });
    }
    await Promise.all(pending);

    devices = { ...devices, [device.id]: { ...device, seq, seenAt: now } };
    const before = meta.version;
    meta = await this.save(meta, state, aux, devices);
    if (requests.length) await this.ctx.storage.put("answers", answers.slice(-MAX_ANSWERS));
    const base = { version: meta.version, serverNow: now, spansUpTo: seq };
    if (body.have === meta.version && meta.version === before && !requests.length) return ok({ ...base, unchanged: true });
    const today = device.kind === "mac" || (Array.isArray(body.want) && body.want.includes("today")) ? { today: todayFor(state, meta.tz, now) } : {};
    return ok({ ...base, copy: copyOf(state), results, ...today });
  }

  // ---------- devices, leaving, deleting, export ----------

  async list(token: string): Promise<Reply> {
    const a = await this.auth(token);
    if ("status" in a) return a;
    return ok({
      devices: Object.values(a.devices).sort((x, y) => x.joinedAt - y.joinedAt)
        .map((d) => ({ id: d.id, name: d.name, kind: d.kind, joinedAt: d.joinedAt, seenAt: d.seenAt, self: d.id === a.device.id })),
    });
  }

  async remove(token: string, deviceId: unknown): Promise<Reply> {
    const a = await this.auth(token);
    if ("status" in a) return a;
    if (typeof deviceId !== "string" || !a.devices[deviceId]) return fail(404, "no_device");
    if (deviceId === a.device.id) return fail(400, "use_leave");
    const { [deviceId]: _, ...rest } = a.devices;
    await this.ctx.storage.put("devices", rest);
    return ok({ ok: true });
  }

  async leave(token: string, now: number): Promise<Reply> {
    const a = await this.auth(token);
    if ("status" in a) return a;
    let state = (await this.ctx.storage.get<State>("state"))!;
    let aux = await this.aux();
    ({ state, aux } = this.roll(state, aux, a.meta.tz, now));
    ({ state, aux } = this.settle(state, aux, now));
    const { [a.device.id]: _, ...rest } = a.devices;
    if (!Object.keys(rest).length) await this.erase();
    else await this.ctx.storage.put("devices", rest);
    return ok({ ok: true, copy: copyOf(state) });
  }

  async deleteAccount(token: string): Promise<Reply> {
    const a = await this.auth(token);
    if ("status" in a) return a;
    await this.erase();
    return ok({ ok: true });
  }

  private async erase(): Promise<void> {
    const code = await this.ctx.storage.get<string>("code");
    const meta = await this.meta();
    if (code && meta) await this.env.PAIRING.get(this.env.PAIRING.idFromName("code:" + code)).revoke(meta.accountId);
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("deleted", true);
  }

  async exportAll(token: string): Promise<Reply> {
    const a = await this.auth(token);
    if ("status" in a) return a;
    const state = await this.ctx.storage.get<State>("state");
    const aux = await this.aux();
    return ok({
      account: {
        accountId: a.meta.accountId, createdAt: a.meta.createdAt, tz: a.meta.tz,
        devices: Object.values(a.devices).map(({ keyHash, seq, ...d }) => d),
      },
      state,
      today: { day: aux.day.day, spans: aux.day.buckets },
      lostRules: aux.lost,
    });
  }
}

/** Codes for Add a device: one object per code, so taking and using a code is atomic. */
export class Pairing extends DurableObject<Env> {
  async claim(accountId: string, expiresAt: number, now: number): Promise<boolean> {
    const c = await this.ctx.storage.get<{ accountId: string; expiresAt: number; used: boolean }>("c");
    if (c && !c.used && c.expiresAt > now && c.accountId !== accountId) return false;
    await this.ctx.storage.put("c", { accountId, expiresAt, used: false });
    return true;
  }
  async consume(now: number): Promise<string | null> {
    const c = await this.ctx.storage.get<{ accountId: string; expiresAt: number; used: boolean }>("c");
    if (!c || c.used || c.expiresAt <= now) return null;
    await this.ctx.storage.put("c", { ...c, used: true });
    return c.accountId;
  }
  async revoke(accountId: string): Promise<void> {
    const c = await this.ctx.storage.get<{ accountId: string }>("c");
    if (c && c.accountId === accountId) await this.ctx.storage.delete("c");
  }
}

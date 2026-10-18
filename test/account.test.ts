import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engine, inZone } from "../src/account/engine";
import { mockAnthropic, post } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NY = "America/New_York";
const E = engine as any;

/** A device's own engine state, set up with these minutes per kind, as the extension's welcome leaves it. */
function deviceState(kinds: Record<string, number>, opts: { help?: boolean; seconds?: Record<string, number>; exam?: number } = {}) {
  const now = Date.now();
  return inZone(NY, () => {
    let s = E.rollover(E.initialState(), now);
    s = E.completeSetup(s, { kinds, goal: "Finish problem set 4" }, now).state;
    if (opts.help) s = E.setHelp(s, true);
    if (opts.seconds) s = { ...s, usage: { ...s.usage, seconds: { ...opts.seconds } } };
    if (opts.exam) s = E.startExam(s, { until: opts.exam, goal: "15.425 midterm" }, now).state;
    return s;
  });
}

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const call = async (path: string, body: Record<string, unknown>, token?: string) => {
  const res = await post(path, { v: 1, ...body }, token ? auth(token) : {});
  return { status: res.status, body: (await res.json()) as any };
};

async function create(state?: unknown, device = { name: "Brave on Mac", kind: "extension" }) {
  const r = await call("/account/create", { device, tz: NY, now: Date.now(), state });
  expect(r.status).toBe(200);
  return r.body;
}

async function join(token: string, state?: unknown, device = { name: "Safari on Mac", kind: "extension" }) {
  const code = await call("/account/code", {}, token);
  expect(code.status).toBe(200);
  expect(code.body.code).toMatch(/^\d{6}$/);
  const r = await call("/account/join", { code: code.body.code, device, tz: NY, now: Date.now(), state });
  return r;
}

describe("the account: create", () => {
  it("is made from the first device's state, which it then holds", async () => {
    const a = await create(deviceState({ social: 30, video: 45 }, { seconds: { social: 600 } }));
    expect(a.accountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.device.token).toMatch(/^gk1\./);
    expect(a.copy.rules.kinds).toEqual({ social: { minutes: 30 }, video: { minutes: 45 } });
    expect(a.copy.installId).toBe(a.accountId); // /sort and /judge then count against the account
    expect(a.copy.usage.seconds.social).toBe(600); // today's minutes come with it
    for (const f of ["clock", "calendar", "judging", "unknown", "sorting"]) expect(a.copy).not.toHaveProperty(f);
  });

  it("starts from nothing when the device sends no state", async () => {
    const a = await create();
    expect(a.copy.setupDone).toBe(false);
    expect(a.version).toBeGreaterThan(0);
  });

  it("refuses other contract versions, devices and tokens", async () => {
    expect((await post("/account/create", { v: 2, device: { kind: "extension" } })).status).toBe(400);
    expect((await call("/account/create", { device: { kind: "toaster" } })).body.error).toBe("invalid_device");
    expect((await call("/account/sync", {})).status).toBe(401);
    expect((await call("/account/sync", {}, "gk1.not-a-token")).status).toBe(401);
    const a = await create();
    const forged = a.device.token.slice(0, -4) + "AAAA";
    expect((await call("/account/sync", {}, forged)).body).toEqual({ v: 1, error: "bad_token" });
  });
});

describe("the account: a second device joins with a code", () => {
  it("keeps the account's rules whole, adds today's minutes, and keeps the later exam end", async () => {
    const examEnd = Date.now() + 30 * 3600e3;
    const a = await create(deviceState({ social: 30, video: 45 }, { seconds: { social: 600, video: 60 } }));
    const j = await join(a.device.token, deviceState({ social: 60, games: 15 }, { seconds: { social: 300 }, exam: examEnd }));
    expect(j.status).toBe(200);
    expect(j.body.accountId).toBe(a.accountId);
    expect(j.body.copy.rules.kinds).toEqual({ social: { minutes: 30 }, video: { minutes: 45 } }); // the account's, whole
    expect(j.body.merged.rulesDiffer).toBe(true);
    expect(j.body.merged.lostRules.kinds).toEqual({ social: { minutes: 60 }, games: { minutes: 15 } });
    expect(j.body.copy.usage.seconds).toMatchObject({ social: 900, video: 60 }); // added together
    expect(j.body.copy.rules.exam.until).toBe(examEnd); // exam mode on from the joining side, as a tightening
    expect(j.body.copy.log.some((e: any) => e.type === "join" && e.device === "Safari on Mac")).toBe(true);
  });

  it("works once only, and a wrong code is a 404", async () => {
    const a = await create(deviceState({ social: 30 }));
    const code = (await call("/account/code", {}, a.device.token)).body.code;
    const first = await call("/account/join", { code, device: { name: "Chrome", kind: "extension" }, tz: NY });
    expect(first.status).toBe(200);
    const again = await call("/account/join", { code, device: { name: "Chrome", kind: "extension" }, tz: NY });
    expect(again.body).toEqual({ v: 1, error: "bad_code" });
    const wrong = await call("/account/join", { code: code === "000000" ? "000001" : "000000", device: { name: "x", kind: "extension" } });
    expect(wrong.status).toBe(404);
  });

  it("replaces an earlier code with a new one", async () => {
    const a = await create(deviceState({ social: 30 }));
    const old = (await call("/account/code", {}, a.device.token)).body.code;
    const fresh = (await call("/account/code", {}, a.device.token)).body.code;
    if (old !== fresh) expect((await call("/account/join", { code: old, device: { name: "x", kind: "extension" } })).status).toBe(404);
    expect((await call("/account/join", { code: fresh, device: { name: "y", kind: "extension" } })).status).toBe(200);
  });

  it("limits code guesses per network address", async () => {
    const headers = { "CF-Connecting-IP": "198.51.100.9" };
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const res = await post("/account/join", { v: 1, code: String(100000 + i), device: { name: "x", kind: "extension" } }, { headers });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

describe("the account: sync", () => {
  async function twoDevices() {
    const a = await create(deviceState({ social: 30, video: 45 }));
    const j = await join(a.device.token);
    return { brave: a.device.token as string, safari: j.body.device.token as string };
  }

  it("counts video in front in two browsers at the same moment once", async () => {
    const { brave, safari } = await twoDevices();
    const t = Date.now() - 120e3;
    await call("/account/sync", { now: Date.now(), spans: [{ seq: 1, from: t, to: t + 60e3, buckets: ["video"] }] }, brave);
    const r = await call("/account/sync", { now: Date.now(), spans: [{ seq: 1, from: t + 30e3, to: t + 90e3, buckets: ["video"] }] }, safari);
    expect(r.body.copy.usage.seconds.video).toBe(90);
    expect(r.body.spansUpTo).toBe(1);
  });

  it("reads each device's clock through what it says now is", async () => {
    const { brave } = await twoDevices();
    const skew = -3 * 3600e3; // this device's clock is 3 hours behind
    const deviceNow = Date.now() + skew;
    const r = await call("/account/sync", { now: deviceNow, spans: [{ seq: 1, from: deviceNow - 50e3, to: deviceNow - 20e3, buckets: ["social"] }] }, brave);
    expect(r.body.copy.usage.seconds.social).toBe(30);
  });

  it("says unchanged when nothing changed, and sends the copy when something did", async () => {
    const { brave } = await twoDevices();
    const first = await call("/account/sync", { now: Date.now() }, brave);
    const quiet = await call("/account/sync", { now: Date.now(), have: first.body.version }, brave);
    expect(quiet.body.unchanged).toBe(true);
    expect(quiet.body.copy).toBeUndefined();
    const t = Date.now() - 10e3;
    const busy = await call("/account/sync", { now: Date.now(), have: first.body.version, spans: [{ seq: 1, from: t, to: t + 5e3, buckets: ["social"] }] }, brave);
    expect(busy.body.version).toBeGreaterThan(first.body.version);
    expect(busy.body.copy.usage.seconds.social).toBe(5);
  });

  it("applies a tighter rule from one device everywhere, and a looser one waits for the agent", async () => {
    const { brave, safari } = await twoDevices();
    const tight = await call("/account/sync", { now: Date.now(), requests: [{ id: "r1", type: "propose", rules: { kinds: { social: { minutes: 10 }, video: { minutes: 45 } } } }] }, brave);
    expect(tight.body.results[0]).toMatchObject({ id: "r1", needsOk: false });
    const seen = await call("/account/sync", { now: Date.now() }, safari);
    expect(seen.body.copy.rules.kinds.social).toEqual({ minutes: 10 });
    const loose = await call("/account/sync", { now: Date.now(), requests: [{ id: "r2", type: "propose", rules: { kinds: { social: { minutes: 60 }, video: { minutes: 45 } } } }] }, safari);
    expect(loose.body.copy.rules.kinds.social).toEqual({ minutes: 10 }); // not now
    expect(loose.body.copy.pending.rules.kinds.social).toEqual({ minutes: 60 }); // waits for the morning
  });

  it("answers a request id once, so a retry never counts twice", async () => {
    const { brave } = await twoDevices();
    const until = Date.now() + 5 * 3600e3;
    const req = { id: "exam-1", type: "startExam", until, goal: "midterm" };
    const a = await call("/account/sync", { now: Date.now(), requests: [req] }, brave);
    const b = await call("/account/sync", { now: Date.now(), requests: [req] }, brave);
    expect(b.body.results).toEqual(a.body.results);
    expect(b.body.copy.log.filter((e: any) => e.type === "exam.start")).toHaveLength(1);
  });

  it("lets the Mac start exam mode but nothing that loosens", async () => {
    const a = await create(deviceState({ social: 30 }));
    const mac = (await join(a.device.token, undefined, { name: "Gatekeeper for Mac", kind: "mac" })).body.device.token;
    const until = Date.now() + 3 * 3600e3;
    const r = await call("/account/sync", { now: Date.now(), requests: [
      { id: "m1", type: "startExam", until, goal: "final" },
      { id: "m2", type: "propose", rules: { kinds: {} } },
      { id: "m3", type: "endExam" },
    ] }, mac);
    expect(r.body.results[0]).toMatchObject({ ok: true });
    expect(r.body.results[1]).toMatchObject({ refused: "mac_cannot_loosen" });
    expect(r.body.results[2]).toMatchObject({ refused: "mac_cannot_loosen" });
    expect(r.body.copy.rules.exam.until).toBe(until);
  });

  it("refuses unknown request types without failing the sync", async () => {
    const { brave } = await twoDevices();
    const r = await call("/account/sync", { now: Date.now(), requests: [{ id: "x", type: "teleport" }] }, brave);
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toEqual({ id: "x", refused: "unknown_type" });
  });

  it("refuses malformed spans and requests", async () => {
    const { brave } = await twoDevices();
    expect((await call("/account/sync", { spans: [{ seq: 1, from: 0, to: 1, buckets: ["https://x.com/a"] }] }, brave)).body.error).toBe("invalid_spans");
    expect((await call("/account/sync", { requests: [{ type: "propose" }] }, brave)).body.error).toBe("invalid_requests");
  });
});

describe("the account asks Claude itself", () => {
  it("gives a pass at the gate, and the pass runs down on real time across devices", async () => {
    const a = await create(deviceState({ video: 0 }, { help: true }));
    const safari = (await join(a.device.token)).body.device.token;
    const calls = mockAnthropic({ answer: { decision: "allow", minutes: 5, reply: "Five minutes for the recording." } });
    const r = await call("/account/sync", { now: Date.now(), requests: [{ id: "g1", type: "talk", url: "https://www.youtube.com/", message: "lecture 6 recording" }] }, a.device.token);
    expect(r.body.results[0]).toMatchObject({ decision: "allow", minutes: 5, site: "youtube.com" });
    expect(calls[0]!.body.messages[0].content).toContain("site: youtube.com");
    expect(r.body.copy.passes["youtube.com"].secondsLeft).toBe(300);
    // Two browsers open for the same seconds use those seconds of the pass once, not twice.
    const t = Date.now();
    await new Promise((r) => setTimeout(r, 3000));
    const now = Date.now();
    await call("/account/sync", { now, spans: [{ seq: 1, from: t, to: now, buckets: [] }] }, a.device.token);
    const s = await call("/account/sync", { now, spans: [{ seq: 1, from: t, to: now, buckets: [] }] }, safari);
    const left = s.body.copy.passes["youtube.com"].secondsLeft;
    expect(left).toBeGreaterThanOrEqual(295);
    expect(left).toBeLessThanOrEqual(298);
  });

  it("counts Claude against the account, not each device", async () => {
    const a = await create(deviceState({ video: 0, social: 0 }, { help: true }));
    const safari = (await join(a.device.token)).body.device.token;
    mockAnthropic({ answer: { decision: "deny", minutes: 0, reply: "No." } });
    const ask = (token: string, id: string, url: string) =>
      call("/account/sync", { now: Date.now(), requests: [{ id, type: "talk", url, message: "just checking" }] }, token);
    expect((await ask(a.device.token, "g1", "https://www.youtube.com/")).body.results[0].decision).toBe("deny");
    expect((await ask(safari, "g2", "https://www.instagram.com/")).body.results[0].decision).toBe("deny");
    // Both devices' gate calls are on the account's one counter (the relay's daily caps apply to it).
    const quota = (env as any).QUOTA.get((env as any).QUOTA.idFromName("install:" + a.accountId));
    const used = await quota.read(new Date().toISOString().slice(0, 10));
    expect(used.calls).toBe(2);
    expect(used.tokens).toBe(2 * (700 + 60));
  });

  it("turns a chat message into a card the other device sees", async () => {
    const a = await create(deviceState({ social: 30 }, { help: true }));
    const safari = (await join(a.device.token)).body.device.token;
    mockAnthropic({ answer: { reply: "lequipe.fr: 15 minutes a day.", question: null, diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 15 }] } });
    const r = await call("/account/sync", { now: Date.now(), requests: [{ id: "c1", type: "chat", message: "i want to put a limit on the site lequipe" }] }, a.device.token);
    expect(r.body.results[0]).toMatchObject({ ok: true });
    const other = await call("/account/sync", { now: Date.now() }, safari);
    expect(other.body.copy.thread.card).toBeTruthy();
    const applied = await call("/account/sync", { now: Date.now(), requests: [{ id: "c2", type: "applyCard" }] }, safari);
    expect(applied.body.copy.rules.siteLimits).toEqual({ "lequipe.fr": 15 });
  });

  it("keeps a loosening waiting when the agent can't be reached", async () => {
    const a = await create(deviceState({ social: 15 }, { help: true }));
    await call("/account/sync", { now: Date.now(), requests: [{ id: "p", type: "propose", rules: { kinds: { social: { minutes: 60 } } } }] }, a.device.token);
    mockAnthropic({ status: 500 });
    const r = await call("/account/sync", { now: Date.now(), requests: [{ id: "l", type: "loosen", message: "two lectures a day now" }] }, a.device.token);
    expect(r.body.results[0]).toMatchObject({ decision: "unavailable" });
    expect(r.body.copy.pending.ok).toBe(false); // nothing approved
    expect(r.body.copy.loosen).toBeTruthy(); // still waiting, to ask again
  });
});

describe("the account: devices, leaving, deleting, export", () => {
  it("lists devices, and a removed device's token stops working", async () => {
    const a = await create(deviceState({ social: 30 }));
    const j = (await join(a.device.token)).body;
    const list = await call("/account/devices", {}, a.device.token);
    expect(list.body.devices.map((d: any) => [d.name, d.self])).toEqual([["Brave on Mac", true], ["Safari on Mac", false]]);
    expect((await call("/account/remove", { deviceId: j.device.id }, a.device.token)).body.ok).toBe(true);
    expect((await call("/account/sync", {}, j.device.token)).status).toBe(401);
    expect((await call("/account/remove", { deviceId: a.device.id }, a.device.token)).body.error).toBe("use_leave");
  });

  it("lets a device leave with a full copy; the last one leaving deletes the account", async () => {
    const a = await create(deviceState({ social: 30 }));
    const j = (await join(a.device.token)).body;
    const left = await call("/account/leave", {}, j.device.token);
    expect(left.body.copy.rules.kinds.social).toEqual({ minutes: 30 });
    expect((await call("/account/sync", {}, j.device.token)).status).toBe(401);
    await call("/account/leave", {}, a.device.token);
    expect((await call("/account/sync", {}, a.device.token)).body).toEqual({ v: 1, error: "account_deleted" });
  });

  it("deletes everything at once, and exports everything but the keys", async () => {
    const a = await create(deviceState({ social: 30 }));
    const ex = await call("/account/export", {}, a.device.token);
    expect(ex.body.account.accountId).toBe(a.accountId);
    expect(JSON.stringify(ex.body)).not.toContain("keyHash");
    expect(ex.body.state.rules.kinds.social).toEqual({ minutes: 30 });
    expect((await call("/account/delete", {}, a.device.token)).body.ok).toBe(true);
    expect((await call("/account/sync", {}, a.device.token)).status).toBe(410);
  });
});

import { describe, expect, it } from "vitest";
import { engine, inZone } from "../src/account/engine";
import { post } from "./helpers";

const E = engine as any;

describe("a full account", () => {
  it("stores and syncs a state at the engine's limits (30 days, 300 log entries, 300 judged videos, 50 turns)", async () => {
    const now = Date.now();
    let s = inZone("America/New_York", () => E.completeSetup(E.rollover(E.initialState(), now), { kinds: { social: 30, video: 45, games: 15, news: 20, shopping: 10 }, goal: "x".repeat(300) }, now).state);
    const day = (i: number) => new Date(now - i * 86400e3).toISOString().slice(0, 10);
    s = {
      ...s,
      history: Array.from({ length: 30 }, (_, i) => ({ day: day(30 - i), kinds: { social: { used: 1800, budget: 1800 }, video: { used: 2700, budget: 2700 } }, gates: 12, passes: 3 })),
      log: Array.from({ length: 300 }, (_, i) => ({ at: now - i * 60e3, day: day(0), type: "loosen", kind: "rules", changes: ["Video: 20 min a day → 45 min a day"], message: "m".repeat(500), decision: "deny", reply: "r".repeat(280) })),
      judged: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`yt:video${String(i).padStart(5, "0")}`, { rule: "v1", key: "k".repeat(40), by: "claude", at: now }])),
      thread: { turns: Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? "user" : "gatekeeper", text: "t".repeat(600), at: now - i * 1000 })), card: null },
    };
    const size = JSON.stringify(s).length;
    expect(size).toBeGreaterThan(300_000);
    const res = await post("/account/create", { v: 1, device: { name: "Brave", kind: "extension" }, tz: "America/New_York", state: s });
    expect(res.status).toBe(200);
    const a = (await res.json()) as any;
    expect(a.copy.log).toHaveLength(300);
    const sync = await post("/account/sync", { v: 1, now: Date.now(), spans: [{ seq: 1, from: now - 5000, to: now, buckets: ["social"] }] }, { headers: { Authorization: `Bearer ${a.device.token}` } });
    expect(sync.status).toBe(200);
    expect(((await sync.json()) as any).copy.history).toHaveLength(30);
  });
});

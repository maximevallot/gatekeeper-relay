import { afterEach, describe, expect, it, vi } from "vitest";
import { gateBody, mockAnthropic, post } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("installId", () => {
  it("is required and must be a UUID on both endpoints, before any Claude call", async () => {
    const calls = mockAnthropic();
    for (const installId of [undefined, "", "abc", 12345, "00000000-0000-0000-0000-000000000000", "../../etc"]) {
      const gate = await post("/gate", gateBody({ installId }));
      expect(gate.status, `gate ${installId}`).toBe(400);
      expect(await gate.json()).toEqual({ error: "invalid_install_id" });
      const sort = await post("/sort", { installId, domain: "agar.io", title: "" });
      expect(sort.status, `sort ${installId}`).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("request validation", () => {
  it("rejects bad gate fields with a named error", async () => {
    const calls = mockAnthropic();
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "porn" }, "invalid_kind"],
      [{ message: "" }, "missing_message"],
      [{ message: "   " }, "missing_message"],
      [{ message: "x".repeat(501) }, "message_too_long"],
      [{ goal: "x".repeat(301) }, "goal_too_long"],
      [{ minutesUsed: -1 }, "invalid_minutesUsed"],
      [{ budget: "20" }, "invalid_budget"],
      [{ deadlines: "tomorrow" }, "invalid_deadlines"],
      [{ deadlines: Array(11).fill("x") }, "invalid_deadlines"],
      [{ site: "not a site" }, "invalid_site"],
    ];
    for (const [override, error] of cases) {
      const res = await post("/gate", gateBody(override));
      expect(res.status, error).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects bodies that are not a JSON object or are too large", async () => {
    expect((await post("/gate", "not json")).status).toBe(400);
    expect((await post("/gate", "[1,2]")).status).toBe(400);
    expect(await (await post("/gate", { ...gateBody(), pad: "x".repeat(9000) })).json()).toEqual({ error: "body_too_large" });
  });
});

describe("daily caps", () => {
  it("stops an install after MAX_CALLS_PER_INSTALL calls, and only that install", async () => {
    const calls = mockAnthropic();
    const limits = { env: { MAX_CALLS_PER_INSTALL: "2" } };
    const body = gateBody();
    expect((await post("/gate", body, limits)).status).toBe(200);
    expect((await post("/gate", body, limits)).status).toBe(200);
    const third = await post("/gate", body, limits);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "daily_limit", scope: "install" });
    // /sort draws from the same allowance.
    expect((await post("/sort", { installId: body.installId, domain: "fresh-domain.com", title: "" }, limits)).status).toBe(429);
    expect(calls).toHaveLength(2);

    expect((await post("/gate", gateBody(), limits)).status).toBe(200);
  });

  it("stops an install once its tokens pass MAX_TOKENS_PER_INSTALL", async () => {
    const calls = mockAnthropic({ answer: { decision: "deny", minutes: 0, reply: "No." }, inputTokens: 25_000, outputTokens: 0 });
    const limits = { env: { MAX_TOKENS_PER_INSTALL: "40000" } };
    const body = gateBody();
    expect((await post("/gate", body, limits)).status).toBe(200); // 25k used
    expect((await post("/gate", body, limits)).status).toBe(200); // 25k < 40k, so allowed; now 50k
    const third = await post("/gate", body, limits);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "daily_limit", scope: "install" });
    expect(calls).toHaveLength(2);
  });

  it("stops one IP from minting fresh installIds", async () => {
    mockAnthropic();
    const limits = { env: { MAX_CALLS_PER_IP: "2" }, headers: { "CF-Connecting-IP": "203.0.113.7" } };
    expect((await post("/gate", gateBody(), limits)).status).toBe(200);
    expect((await post("/gate", gateBody(), limits)).status).toBe(200);
    const third = await post("/gate", gateBody(), limits);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "daily_limit", scope: "ip" });
    const other = { ...limits, headers: { "CF-Connecting-IP": "203.0.113.8" } };
    expect((await post("/gate", gateBody(), other)).status).toBe(200);
  });

  it("stops everyone once the key's daily token ceiling is reached", async () => {
    mockAnthropic({ answer: { decision: "deny", minutes: 0, reply: "No." }, inputTokens: 1_000_000, outputTokens: 0 });
    const limits = { env: { GLOBAL_DAILY_TOKENS: "1" } };
    // The global counter is shared by every test in this file's storage, so the first call may already be over.
    let res = await post("/gate", gateBody(), limits);
    if (res.status === 200) res = await post("/gate", gateBody(), limits);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "daily_limit", scope: "global" });
  });

  it("does not count cached /sort answers", async () => {
    const calls = mockAnthropic({ answer: { kind: "social" } });
    const limits = { env: { MAX_CALLS_PER_INSTALL: "1" } };
    const installId = crypto.randomUUID();
    for (let i = 0; i < 5; i++) {
      const res = await post("/sort", { installId, domain: "instagram.com", title: "Instagram" }, limits);
      expect(res.status).toBe(200);
    }
    expect(calls).toHaveLength(1);
  });
});

describe("routing and origins", () => {
  it("answers only POST /gate and POST /sort", async () => {
    expect((await post("/", {})).status).toBe(404);
    expect((await post("/v1/messages", {})).status).toBe(404);
    expect((await post("/gate", null, { method: "GET" })).status).toBe(405);
  });

  it("refuses web pages and serves the extension with CORS headers", async () => {
    mockAnthropic();
    const site = await post("/gate", gateBody(), { headers: { Origin: "https://evil.example" } });
    expect(site.status).toBe(403);

    const ext = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const ok = await post("/gate", gateBody(), { headers: { Origin: ext } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(ext);

    const preflight = await post("/gate", null, { method: "OPTIONS", headers: { Origin: ext } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("can be pinned to one extension ID", async () => {
    mockAnthropic();
    const mine = "chrome-extension://mnopmnopmnopmnopabcdefghijklmnop";
    const pinned = { env: { ALLOWED_ORIGINS: mine } };
    const other = await post("/gate", gateBody(), { ...pinned, headers: { Origin: "chrome-extension://someoneelse" } });
    expect(other.status).toBe(403);
    expect((await post("/gate", gateBody(), { ...pinned, headers: { Origin: mine } })).status).toBe(200);
  });
});

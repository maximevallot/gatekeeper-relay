import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { baseEnv } from "./helpers";

async function get(path: string, method = "GET"): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://relay.test" + path, { method }), baseEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("GET /privacy", () => {
  it("serves the privacy policy as a public page, with no Claude call", async () => {
    const res = await get("/privacy");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("Gatekeeper privacy policy");
    expect(html).toContain("Limited Use");
  });

  it("answers HEAD; other methods get the usual not_found", async () => {
    expect((await get("/privacy", "HEAD")).status).toBe(200);
    expect((await get("/privacy", "POST")).status).toBe(404);
  });
});

describe("HEAD / (the extension's time check)", () => {
  it("answers 204 with the time, uncached, without any Claude call or cap", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (let i = 0; i < 5; i++) {
      const res = await get("/", "HEAD");
      expect(res.status).toBe(204);
      const date = Date.parse(res.headers.get("Date") ?? "");
      expect(Math.abs(date - Date.now())).toBeLessThan(5000);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await get("/", "GET")).status).toBe(204);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("lets the extension read the Date header", async () => {
    const ctx = createExecutionContext();
    const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const res = await worker.fetch(new Request("https://relay.test/", { method: "HEAD", headers: { Origin: origin } }), baseEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe("Date");
  });
});

describe("GET /privacy/0.2 (the first testers' policy)", () => {
  it("serves the 0.2.0 policy, and /privacy stays the 0.1.1 one", async () => {
    const res = await get("/privacy/0.2");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("change your rules by chat");
    expect(await (await get("/privacy")).text()).not.toContain("change your rules by chat");
    expect((await get("/privacy/0.2", "HEAD")).status).toBe(200);
  });
});

describe("origins", () => {
  it("lets Edge's extension:// origin through, like chrome-extension://, and nothing else", async () => {
    for (const [origin, ok] of [["extension://abcdefghijklmnopabcdefghijklmnop", true], ["safari-web-extension://8F2A1C3E-0B4D-4E5F-9A6B-7C8D9E0F1A2B", true], ["chrome-extension://abcdefghijklmnopabcdefghijklmnop", true], ["https://evil.example", false]] as const) {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request("https://relay.test/", { method: "HEAD", headers: { Origin: origin } }), baseEnv, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.headers.get("Access-Control-Allow-Origin") === origin).toBe(ok);
    }
  });
});

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

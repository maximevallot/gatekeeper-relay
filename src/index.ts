import { handleAccount, MAX_ACCOUNT_BODY } from "./account/routes";
import { UpstreamError } from "./claude";
import { type Env, intVar } from "./env";
import { gate } from "./gate";
import { judge } from "./judge";
import { loosen } from "./loosen";
import { recordTokens, reserveCall } from "./quota";
import { rules } from "./rules";
import { cachedKind, sort } from "./sort";
import { BadRequest, gateInput, isObject, judgeInput, loosenInput, rulesInput, sortInput } from "./validate";
import privacyPage from "../pages/privacy.html";

export { Quota } from "./quota";
export { Account, Pairing } from "./account/account";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_RULES_BODY_BYTES = 24 * 1024; // /rules carries the student's rules and a short conversation
const PATHS = ["/gate", "/sort", "/judge", "/rules", "/loosen"];

function allowedOrigin(origin: string | null, env: Env): boolean {
  if (origin === null) return true; // not a browser page: curl, tests, or an extension with host permission
  const list = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list.includes(origin) : origin.startsWith("chrome-extension://");
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  if (status === 429 && typeof body === "object" && body !== null && (body as { error?: unknown }).error === "daily_limit") {
    // "Not now": the caps reset at the next 00:00 UTC.
    const resets = new Date(new Date().setUTCHours(24, 0, 0, 0));
    const wait = Math.max(1, Math.ceil((resets.getTime() - Date.now()) / 1000));
    return new Response(JSON.stringify({ ...body, resets: resets.toISOString() }), {
      status,
      headers: { "Content-Type": "application/json", "Retry-After": String(wait), ...corsHeaders(origin), ...(origin ? { "Access-Control-Expose-Headers": "Retry-After" } : {}) },
    });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function readBody(request: Request, max: number): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > max) throw new BadRequest("body_too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequest("invalid_json");
  }
  if (!isObject(body)) throw new BadRequest("invalid_json");
  return body;
}

async function handle(request: Request, env: Env, ctx: ExecutionContext, origin: string | null): Promise<Response> {
  const { pathname } = new URL(request.url);
  // The time check: after the computer's clock jumps, the extension reads this response's Date header.
  // It sends nothing, and it counts against no cap.
  if (pathname === "/" && (request.method === "HEAD" || request.method === "GET")) {
    return new Response(null, {
      status: 204,
      headers: {
        Date: new Date().toUTCString(),
        "Cache-Control": "no-store",
        ...corsHeaders(origin),
        ...(origin ? { "Access-Control-Expose-Headers": "Date" } : {}),
      },
    });
  }
  // The privacy policy the Chrome Web Store listing links to.
  if (pathname === "/privacy" && (request.method === "GET" || request.method === "HEAD")) {
    return new Response(request.method === "HEAD" ? null : privacyPage, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  }
  // The account (0.3.0): one Gatekeeper per person; see docs/account-contract.md.
  if (pathname.startsWith("/account/")) {
    if (request.method !== "POST") return json({ v: 1, error: "method_not_allowed" }, 405, origin);
    let body: Record<string, unknown>;
    try {
      body = await readBody(request, MAX_ACCOUNT_BODY);
    } catch (err) {
      if (err instanceof BadRequest) return json({ v: 1, error: err.message }, 400, origin);
      throw err;
    }
    const r = await handleAccount(pathname, body, request, env);
    return json(r.body, r.status, origin);
  }
  if (!PATHS.includes(pathname)) return json({ error: "not_found" }, 404, origin);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);

  const body = await readBody(request, pathname === "/rules" ? MAX_RULES_BODY_BYTES : MAX_BODY_BYTES);
  const ip = request.headers.get("CF-Connecting-IP");

  if (pathname === "/sort") {
    const input = sortInput(body);
    // A cached answer costs nothing, so it does not count against the caps.
    const hit = await cachedKind(env, input.domain);
    if (hit) return json({ kind: hit }, 200, origin);
    const full = await reserveCall(env, input.installId, ip);
    if (full) return json({ error: "daily_limit", scope: full }, 429, origin);
    const { kind, tokens } = await sort(env, input.domain, input.title);
    ctx.waitUntil(recordTokens(env, input.installId, tokens));
    return json({ kind }, 200, origin);
  }

  if (pathname === "/judge") {
    // Nothing about the video is stored or cached: titles say too much about a person to keep.
    const input = judgeInput(body);
    const full = await reserveCall(env, input.installId, ip, {
      name: "judge", maxCalls: intVar(env.MAX_JUDGE_PER_INSTALL, 150), shared: false,
    });
    if (full) return json({ error: "daily_limit", scope: full }, 429, origin);
    const { result, tokens } = await judge(env, input);
    ctx.waitUntil(recordTokens(env, input.installId, tokens, false));
    return json(result, 200, origin);
  }

  if (pathname === "/rules") {
    const input = rulesInput(body);
    const full = await reserveCall(env, input.installId, ip, {
      name: "rules", maxCalls: intVar(env.MAX_RULES_PER_INSTALL, 40), shared: false,
    });
    if (full) return json({ error: "daily_limit", scope: full }, 429, origin);
    const { result, tokens } = await rules(env, input);
    ctx.waitUntil(recordTokens(env, input.installId, tokens, false));
    return json(result, 200, origin);
  }

  if (pathname === "/loosen") {
    // A request to loosen a rule, with the student's reason. Nothing of it is stored.
    // Its own allowance, so gate calls can never use up the agent's.
    const input = loosenInput(body);
    const full = await reserveCall(env, input.installId, ip, {
      name: "loosen", maxCalls: intVar(env.MAX_LOOSEN_PER_INSTALL, 10), shared: false,
    });
    if (full) return json({ error: "daily_limit", scope: full }, 429, origin);
    const { result, tokens } = await loosen(env, input);
    ctx.waitUntil(recordTokens(env, input.installId, tokens, false));
    return json(result, 200, origin);
  }

  const input = gateInput(body);
  const full = await reserveCall(env, input.installId, ip);
  if (full) return json({ error: "daily_limit", scope: full }, 429, origin);
  const { result, tokens } = await gate(env, input);
  ctx.waitUntil(recordTokens(env, input.installId, tokens));
  return json(result, 200, origin);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const origin = request.headers.get("Origin");
    if (!allowedOrigin(origin, env)) return json({ error: "origin_not_allowed" }, 403, null);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    try {
      return await handle(request, env, ctx, origin);
    } catch (err) {
      if (err instanceof BadRequest) return json({ error: err.message }, 400, origin);
      if (err instanceof UpstreamError) return json({ error: err.message }, err.status, origin);
      // Never log request bodies: they hold what students typed at the gate.
      console.error("unhandled", err instanceof Error ? err.name : typeof err);
      return json({ error: "internal_error" }, 500, origin);
    }
  },
} satisfies ExportedHandler<Env>;

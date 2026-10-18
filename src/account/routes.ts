// POST /account/*: the account's API (docs/account-contract.md). Each call goes to the person's account
// object, named by the account id in the device's token, or found through a 6-digit code when joining.

import type { Env } from "../env";
import { reserveCall } from "../quota";
import { isObject } from "../validate";
import { CONTRACT, parseToken, type DeviceInfo, type Reply } from "./account";
import { validTimeZone } from "./tz";

export const MAX_ACCOUNT_BODY = 512 * 1024; // create and join carry a device's whole state
const JOINS_PER_IP = 30; // wrong or right, a day: 6 digits can't be guessed
const CODES_PER_ACCOUNT = 20;

const fail = (status: number, error: string, more: Record<string, unknown> = {}): Reply => ({ status, body: { v: CONTRACT, error, ...more } });

function deviceInfo(raw: unknown): DeviceInfo | null {
  if (!isObject(raw)) return null;
  const kind = raw.kind;
  if (kind !== "extension" && kind !== "mac" && kind !== "phone") return null;
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return { name: name || (kind === "mac" ? "Gatekeeper for Mac" : "A browser"), kind };
}

const account = (env: Env, id: string) => env.ACCOUNT.get(env.ACCOUNT.idFromName("account:" + id));

export async function handleAccount(path: string, body: Record<string, unknown>, request: Request, env: Env): Promise<Reply> {
  if (body.v !== CONTRACT) return fail(400, "bad_version", { supported: [CONTRACT] });
  const now = Date.now();
  const ip = request.headers.get("CF-Connecting-IP");
  const tz = validTimeZone(body.tz) ? (body.tz as string) : "UTC";
  const from = isObject(body.state) ? body.state : null;

  if (path === "/account/create") {
    const info = deviceInfo(body.device);
    if (!info) return fail(400, "invalid_device");
    const id = crypto.randomUUID();
    return account(env, id).create(id, info, tz, from, now);
  }

  if (path === "/account/join") {
    const info = deviceInfo(body.device);
    if (!info) return fail(400, "invalid_device");
    if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) return fail(400, "invalid_code");
    const full = await reserveCall(env, "join", ip, { name: "join-ip:" + (ip || "none"), maxCalls: JOINS_PER_IP, shared: false });
    if (full) return fail(429, "daily_limit", { scope: "ip" });
    const accountId = await env.PAIRING.get(env.PAIRING.idFromName("code:" + body.code)).consume(now);
    if (!accountId) return fail(404, "bad_code");
    return account(env, accountId).join(info, tz, from, now);
  }

  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const t = parseToken(token);
  if (!t) return fail(401, "bad_token");
  const a = account(env, t.accountId);
  switch (path) {
    case "/account/sync":
      return a.sync(token, body, ip, now);
    case "/account/code": {
      const full = await reserveCall(env, t.accountId, null, { name: "codes", maxCalls: CODES_PER_ACCOUNT, shared: false });
      if (full) return fail(429, "too_many_codes");
      return a.code(token, now);
    }
    case "/account/devices":
      return a.list(token);
    case "/account/remove":
      return a.remove(token, body.deviceId);
    case "/account/leave":
      return a.leave(token, now);
    case "/account/delete":
      return a.deleteAccount(token);
    case "/account/export":
      return a.exportAll(token);
    default:
      return fail(404, "not_found");
  }
}

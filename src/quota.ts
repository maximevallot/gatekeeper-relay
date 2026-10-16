import { DurableObject } from "cloudflare:workers";
import { type Env, intVar } from "./env";

interface Usage {
  day: string;
  calls: number;
  tokens: number;
}

/**
 * One counter per name ("install:<id>", "ip:<addr>", "global"), reset each UTC day.
 * A Durable Object handles one request at a time, so read-check-write is atomic.
 */
export class Quota extends DurableObject<Env> {
  private async usage(day: string): Promise<Usage> {
    const u = await this.ctx.storage.get<Usage>("usage");
    return u && u.day === day ? u : { day, calls: 0, tokens: 0 };
  }

  /** Counts one call if both limits still have room. A null limit means no limit. */
  async reserve(day: string, maxCalls: number | null, maxTokens: number | null): Promise<boolean> {
    const u = await this.usage(day);
    if (maxCalls !== null && u.calls >= maxCalls) return false;
    if (maxTokens !== null && u.tokens >= maxTokens) return false;
    u.calls += 1;
    await this.ctx.storage.put("usage", u);
    return true;
  }

  async addTokens(day: string, tokens: number): Promise<void> {
    const u = await this.usage(day);
    u.tokens += tokens;
    await this.ctx.storage.put("usage", u);
  }

  async read(day: string): Promise<Usage> {
    return this.usage(day);
  }
}

export type QuotaScope = "install" | "ip" | "global";

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function counter(env: Env, name: string) {
  return env.QUOTA.get(env.QUOTA.idFromName(name));
}

/**
 * Reserves one call against the install, the client IP and the global ceiling.
 * Returns the scope that is full, or null when the call may go ahead.
 */
export async function reserveCall(env: Env, installId: string, ip: string | null): Promise<QuotaScope | null> {
  const day = today();
  const ok = await counter(env, `install:${installId}`).reserve(
    day,
    intVar(env.MAX_CALLS_PER_INSTALL, 60),
    intVar(env.MAX_TOKENS_PER_INSTALL, 40000),
  );
  if (!ok) return "install";
  if (ip) {
    const ipOk = await counter(env, `ip:${ip}`).reserve(day, intVar(env.MAX_CALLS_PER_IP, 300), null);
    if (!ipOk) return "ip";
  }
  const globalOk = await counter(env, "global").reserve(day, null, intVar(env.GLOBAL_DAILY_TOKENS, 3_000_000));
  if (!globalOk) return "global";
  return null;
}

export async function recordTokens(env: Env, installId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const day = today();
  await Promise.all([
    counter(env, `install:${installId}`).addTokens(day, tokens),
    counter(env, "global").addTokens(day, tokens),
  ]);
}

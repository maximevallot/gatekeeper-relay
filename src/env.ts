import type { Quota } from "./quota";

export interface Env {
  /** Secret. Set with `npx wrangler secret put ANTHROPIC_API_KEY`. */
  ANTHROPIC_API_KEY: string;
  /** Only for local tests: points the SDK at a mock server. Unset in production. */
  ANTHROPIC_BASE_URL?: string;
  MODEL: string;
  MAX_CALLS_PER_INSTALL: string;
  MAX_TOKENS_PER_INSTALL: string;
  MAX_CALLS_PER_IP: string;
  GLOBAL_DAILY_TOKENS: string;
  MAX_PASS_MINUTES: string;
  ALLOWED_ORIGINS: string;
  SORT_CACHE: KVNamespace;
  QUOTA: DurableObjectNamespace<Quota>;
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

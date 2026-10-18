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
  /** The longest pass in exam mode, and only for a page that serves the exam. */
  MAX_EXAM_PASS_MINUTES: string;
  /** Rules chat messages per install per UTC day; they also count against the install's shared caps. */
  MAX_RULES_PER_INSTALL: string;
  /** Videos judged per install per UTC day; these have their own allowance, outside the shared caps. */
  MAX_JUDGE_PER_INSTALL: string;
  ALLOWED_ORIGINS: string;
  SORT_CACHE: KVNamespace;
  QUOTA: DurableObjectNamespace<Quota>;
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

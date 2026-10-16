import sortPrompt from "../prompts/sort.md";
import { askClaude } from "./claude";
import type { Env } from "./env";
import { KINDS, type Kind } from "./validate";

const SCHEMA = {
  type: "object",
  properties: { kind: { type: "string", enum: [...KINDS] } },
  required: ["kind"],
  additionalProperties: false,
};

/** Bump the version when the prompt or the kinds change, so old answers are not reused. */
const CACHE_PREFIX = "kind:v1:";
const CACHE_TTL_SECONDS = 90 * 24 * 60 * 60;

export async function cachedKind(env: Env, domain: string): Promise<Kind | null> {
  const hit = await env.SORT_CACHE.get(CACHE_PREFIX + domain);
  return hit && (KINDS as readonly string[]).includes(hit) ? (hit as Kind) : null;
}

export async function sort(env: Env, domain: string, title: string): Promise<{ kind: Kind; tokens: number }> {
  const out = await askClaude(env, {
    system: sortPrompt,
    user: `domain: ${domain}\n<title>${title.replace(/<\/?title>/gi, "") || "(none)"}</title>`,
    schema: SCHEMA,
    maxTokens: 512,
  });
  const kind = out.ok && typeof (out.data as { kind?: unknown })?.kind === "string" ? (out.data as { kind: string }).kind : null;
  if (kind && (KINDS as readonly string[]).includes(kind)) {
    await env.SORT_CACHE.put(CACHE_PREFIX + domain, kind, { expirationTtl: CACHE_TTL_SECONDS });
    return { kind: kind as Kind, tokens: out.tokens };
  }
  // A refusal or a bad answer is not cached: the next user's request tries again.
  return { kind: "other", tokens: out.tokens };
}

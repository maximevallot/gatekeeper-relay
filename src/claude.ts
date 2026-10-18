import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env";

export type ClaudeResult =
  | { ok: true; data: unknown; tokens: number }
  | { ok: false; reason: "refusal" | "unparseable"; tokens: number };

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One Messages API call that must come back as JSON matching `schema`.
 * Effort is low: these are one-line judgments, and thinking would cost more than the answer.
 */
export async function askClaude(
  env: Env,
  opts: { system: string; user: string; schema: Record<string, unknown>; maxTokens: number },
): Promise<ClaudeResult> {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    maxRetries: 1,
    timeout: 20_000,
  });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: env.MODEL || "claude-haiku-5-5",
      max_tokens: opts.maxTokens,
      // The system prompt is the same on every call, so it is cached; reads cost a tenth.
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: opts.user }],
      output_config: { effort: "low", format: { type: "json_schema", schema: opts.schema } },
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      // 429 and 529 mean Anthropic is busy; everything else is our problem or theirs, not the user's.
      const busy = err.status === 429 || err.status === 529;
      throw new UpstreamError(busy ? 503 : 502, busy ? "upstream_busy" : "upstream_error");
    }
    throw new UpstreamError(502, "upstream_error");
  }

  const u = response.usage;
  // Counted as they are billed: a cache read costs a tenth of an input token.
  const tokens =
    u.input_tokens + u.output_tokens + (u.cache_creation_input_tokens ?? 0) + Math.ceil((u.cache_read_input_tokens ?? 0) / 10);

  if (response.stop_reason === "refusal") return { ok: false, reason: "refusal", tokens };

  // Thinking blocks may come first; the answer is the text block.
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) return { ok: false, reason: "unparseable", tokens };
  try {
    return { ok: true, data: JSON.parse(text), tokens };
  } catch {
    return { ok: false, reason: "unparseable", tokens };
  }
}

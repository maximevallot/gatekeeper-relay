import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";

export const baseEnv = env as unknown as Env;

export interface MockReply {
  /** The JSON the model "writes"; a string is sent as-is (to test bad output). */
  answer?: unknown;
  stopReason?: string;
  status?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export interface Captured {
  url: string;
  headers: Headers;
  body: any;
}

/**
 * Replaces global fetch with a fake Anthropic Messages API. Each call takes the next reply
 * from the queue (the last one repeats). Nothing leaves the machine.
 */
export function mockAnthropic(...replies: MockReply[]): Captured[] {
  const calls: Captured[] = [];
  const queue = replies.length ? replies : [{ answer: { decision: "deny", minutes: 0, reply: "No." } }];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init as RequestInit);
    if (!req.url.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected fetch to ${req.url}`);
    calls.push({ url: req.url, headers: req.headers, body: await req.json() });
    const r = queue[Math.min(calls.length - 1, queue.length - 1)]!;
    if (r.status && r.status !== 200) {
      return Response.json({ type: "error", error: { type: "api_error", message: "mock failure" } }, { status: r.status });
    }
    const text = typeof r.answer === "string" ? r.answer : JSON.stringify(r.answer);
    return Response.json({
      id: `msg_mock_${calls.length}`,
      type: "message",
      role: "assistant",
      model: calls.at(-1)!.body.model,
      // Haiku 5.5 thinks by default, so the answer is not always the first block.
      content: r.stopReason === "refusal" ? [] : [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }],
      stop_reason: r.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: r.inputTokens ?? 700,
        output_tokens: r.outputTokens ?? 60,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: r.cacheReadTokens ?? 0,
      },
    });
  });
  return calls;
}

export async function post(
  path: string,
  body: unknown,
  opts: { env?: Partial<Env>; headers?: Record<string, string>; method?: string } = {},
): Promise<Response> {
  const request = new Request(`https://relay.example${path}`, {
    method: opts.method ?? "POST",
    headers: { "Content-Type": "application/json", ...opts.headers },
    body: opts.method === "GET" || opts.method === "OPTIONS" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, { ...baseEnv, ...opts.env } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export function gateBody(overrides: Record<string, unknown> = {}) {
  return {
    installId: crypto.randomUUID(),
    goal: "Finish the 15.390 PMR worksheet",
    site: "youtube.com",
    kind: "video",
    minutesUsed: 20,
    budget: 20,
    deadlines: [{ title: "15.390 PMR worksheet", due: "2026-10-18" }],
    message: "I need to watch the lecture 6 recording, it's only posted on YouTube",
    ...overrides,
  };
}

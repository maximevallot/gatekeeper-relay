import loosenPrompt from "../prompts/loosen.md";
import { askClaude } from "./claude";
import type { Env } from "./env";
import { voice } from "./voice";
import { examText, type LoosenInput } from "./validate";

export interface LoosenResult {
  decision: "allow" | "deny" | "ask";
  /** When a yes takes effect: "now" only for ending exam mode once the exam is over. null unless allow. */
  when: "now" | "morning" | null;
  reply: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["allow", "deny", "ask"] },
    when: { anyOf: [{ type: "string", enum: ["now", "morning"] }, { type: "null" }] },
    reply: { type: "string" },
  },
  required: ["decision", "when", "reply"],
  additionalProperties: false,
};

/** What the key-holder says when the model gives nothing usable: the rule stays. */
const FALLBACK: LoosenResult = { decision: "deny", when: null, reply: "The rule stays as it is for now." };

export function loosenUserMessage(input: LoosenInput, date: string): string {
  const strip = (s: string, tag: string) => s.replace(new RegExp(`</?${tag}>`, "gi"), "");
  const exam = examText(input.exam);
  return [
    input.now ? `now: ${input.now}` : `today: ${date}`,
    `exam mode: ${exam}`,
    `goal: ${input.goal || "not given"}`,
    `kind: ${input.kind}`,
    `changes:\n${input.changes.map((c) => `- ${c}`).join("\n")}`,
    `earlier question: ${input.asked ? strip(input.asked, "message") : "none"}`,
    "",
    `<message>\n${strip(input.message, "message")}\n</message>`,
  ].join("\n");
}

/**
 * Whatever the model returns: one of the three decisions, a short reply, never "ask" twice, and a yes that
 * ends exam mode at once (2026-10-19); every other loosening waits for the morning.
 */
export function enforceLoosen(data: unknown, asked: boolean, kind: LoosenInput["kind"] = "rules"): LoosenResult {
  if (typeof data !== "object" || data === null) return FALLBACK;
  const d = data as Record<string, unknown>;
  const decision = d.decision;
  if (decision !== "allow" && decision !== "deny" && decision !== "ask") return FALLBACK;
  const reply = typeof d.reply === "string" ? voice(d.reply.trim()).slice(0, 280) : "";
  if (!reply) return FALLBACK;
  if (decision === "ask" && asked) return { decision: "deny", when: null, reply };
  if (decision !== "allow") return { decision, when: null, reply };
  if (kind === "exam") return { decision, when: "now", reply: d.when === "now" ? reply : "OK: exam mode ends now." };
  return { decision, when: "morning", reply };
}

export async function loosen(env: Env, input: LoosenInput): Promise<{ result: LoosenResult; tokens: number }> {
  const date = new Date().toISOString().slice(0, 10);
  const out = await askClaude(env, { system: loosenPrompt, user: loosenUserMessage(input, date), schema: SCHEMA, maxTokens: 1024 });
  const result = out.ok ? enforceLoosen(out.data, !!input.asked, input.kind) : FALLBACK;
  return { result, tokens: out.tokens };
}

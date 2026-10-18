import loosenPrompt from "../prompts/loosen.md";
import { askClaude } from "./claude";
import type { Env } from "./env";
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

/**
 * Whether ending exam mode at once is possible at all: the exam's own time (examAt) is known and the
 * relay's own clock, never the device's, is past it. The extension applies the same rule.
 */
export function canEndNow(input: LoosenInput, serverNow = Date.now()): boolean {
  if (input.kind !== "exam" || !input.exam?.at) return false;
  return serverNow >= Date.parse(input.exam.at);
}

/** What the key-holder says when the model gives nothing usable: the rule stays. */
const FALLBACK: LoosenResult = { decision: "deny", when: null, reply: "The rule stays as it is for now." };

export function loosenUserMessage(input: LoosenInput, date: string, endNow = false): string {
  const strip = (s: string, tag: string) => s.replace(new RegExp(`</?${tag}>`, "gi"), "");
  const exam = examText(input.exam);
  return [
    input.now ? `now: ${input.now}` : `today: ${date}`,
    `exam mode: ${exam}`,
    ...(input.kind === "exam"
      ? [`the exam's own time: ${endNow ? "known, and it has passed: a yes ends exam mode now" : "not known to have passed: a yes ends exam mode tomorrow morning"}`]
      : []),
    `goal: ${input.goal || "not given"}`,
    `kind: ${input.kind}`,
    `changes:\n${input.changes.map((c) => `- ${c}`).join("\n")}`,
    `earlier question: ${input.asked ? strip(input.asked, "message") : "none"}`,
    "",
    `<message>\n${strip(input.message, "message")}\n</message>`,
  ].join("\n");
}

/**
 * Whatever the model returns: one of the three decisions, a short reply, never "ask" twice, and a yes
 * that takes effect at once only when it ends exam mode and the exam can be over by now (canEndNow);
 * every other loosening waits for the morning.
 */
export function enforceLoosen(data: unknown, asked: boolean, kind: LoosenInput["kind"] = "rules", endNow = false): LoosenResult {
  if (typeof data !== "object" || data === null) return FALLBACK;
  const d = data as Record<string, unknown>;
  const decision = d.decision;
  if (decision !== "allow" && decision !== "deny" && decision !== "ask") return FALLBACK;
  const reply = typeof d.reply === "string" ? d.reply.trim().slice(0, 280) : "";
  if (!reply) return FALLBACK;
  if (decision === "ask" && asked) return { decision: "deny", when: null, reply };
  if (decision !== "allow") return { decision, when: null, reply };
  if (kind === "exam" && d.when === "now") {
    if (endNow) return { decision, when: "now", reply };
    // The model said "now" without the exam's own time behind it: the server keeps the morning, and says so.
    return { decision, when: "morning", reply: "OK: exam mode ends tomorrow morning." };
  }
  return { decision, when: "morning", reply };
}

export async function loosen(env: Env, input: LoosenInput): Promise<{ result: LoosenResult; tokens: number }> {
  const date = new Date().toISOString().slice(0, 10);
  const endNow = canEndNow(input);
  const out = await askClaude(env, { system: loosenPrompt, user: loosenUserMessage(input, date, endNow), schema: SCHEMA, maxTokens: 1024 });
  const result = out.ok ? enforceLoosen(out.data, !!input.asked, input.kind, endNow) : FALLBACK;
  return { result, tokens: out.tokens };
}

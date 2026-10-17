import loosenPrompt from "../prompts/loosen.md";
import { askClaude } from "./claude";
import type { Env } from "./env";
import type { LoosenInput } from "./validate";

export interface LoosenResult {
  decision: "allow" | "deny" | "ask";
  reply: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["allow", "deny", "ask"] },
    reply: { type: "string" },
  },
  required: ["decision", "reply"],
  additionalProperties: false,
};

/** What the key-holder says when the model gives nothing usable: the rule stays. */
const FALLBACK: LoosenResult = { decision: "deny", reply: "The rule stays as it is for now." };

export function loosenUserMessage(input: LoosenInput, date: string): string {
  const strip = (s: string, tag: string) => s.replace(new RegExp(`</?${tag}>`, "gi"), "");
  return [
    `today: ${date}`,
    `goal: ${input.goal || "not given"}`,
    `kind: ${input.kind}`,
    `changes:\n${input.changes.map((c) => `- ${c}`).join("\n")}`,
    `earlier question: ${input.asked ? strip(input.asked, "message") : "none"}`,
    "",
    `<message>\n${strip(input.message, "message")}\n</message>`,
  ].join("\n");
}

/** Whatever the model returns: one of the three decisions, a short reply, and never "ask" twice. */
export function enforceLoosen(data: unknown, asked: boolean): LoosenResult {
  if (typeof data !== "object" || data === null) return FALLBACK;
  const d = data as Record<string, unknown>;
  const decision = d.decision;
  if (decision !== "allow" && decision !== "deny" && decision !== "ask") return FALLBACK;
  const reply = typeof d.reply === "string" ? d.reply.trim().slice(0, 280) : "";
  if (!reply) return FALLBACK;
  if (decision === "ask" && asked) return { decision: "deny", reply };
  return { decision, reply };
}

export async function loosen(env: Env, input: LoosenInput): Promise<{ result: LoosenResult; tokens: number }> {
  const date = new Date().toISOString().slice(0, 10);
  const out = await askClaude(env, { system: loosenPrompt, user: loosenUserMessage(input, date), schema: SCHEMA, maxTokens: 1024 });
  const result = out.ok ? enforceLoosen(out.data, !!input.asked) : FALLBACK;
  return { result, tokens: out.tokens };
}

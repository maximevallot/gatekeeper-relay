import gatePrompt from "../prompts/gate.md";
import { askClaude } from "./claude";
import { type Env, intVar } from "./env";
import type { GateInput } from "./validate";

export type Decision = "allow" | "deny" | "ask";

export interface GateResult {
  decision: Decision;
  minutes: number;
  reply: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["allow", "deny", "ask"] },
    minutes: { type: "integer" },
    reply: { type: "string" },
  },
  required: ["decision", "minutes", "reply"],
  additionalProperties: false,
};

/** What the gate says when the model gives nothing usable. It blocks first. */
const FALLBACK: GateResult = { decision: "deny", minutes: 0, reply: "The gate stays closed for now." };

export function gateUserMessage(input: GateInput, date: string): string {
  const deadlines = input.deadlines.length ? input.deadlines.map((d) => `- ${d}`).join("\n") : "none given";
  return [
    `today: ${date}`,
    `goal: ${input.goal || "not given"}`,
    `site: ${input.site}`,
    `kind: ${input.kind}`,
    `minutes used today on ${input.kind}: ${input.minutesUsed} of a ${input.budget}-minute budget`,
    `deadlines:\n${deadlines}`,
    "",
    // Strip anything that looks like our closing tag so the message cannot step outside it.
    `<message>\n${input.message.replace(/<\/?message>/gi, "")}\n</message>`,
  ].join("\n");
}

/**
 * Whatever the model returns, the server has the last word: only allow carries minutes,
 * a pass is at least 1 and at most MAX_PASS_MINUTES, and the reply is short.
 */
export function enforce(data: unknown, maxPass: number): GateResult {
  if (typeof data !== "object" || data === null) return FALLBACK;
  const d = data as Record<string, unknown>;
  const decision = d.decision;
  if (decision !== "allow" && decision !== "deny" && decision !== "ask") return FALLBACK;
  const reply = typeof d.reply === "string" ? d.reply.trim().slice(0, 280) : "";
  if (!reply) return FALLBACK;
  if (decision !== "allow") return { decision, minutes: 0, reply };
  const raw = typeof d.minutes === "number" && Number.isFinite(d.minutes) ? Math.round(d.minutes) : 0;
  if (maxPass <= 0) return FALLBACK;
  return { decision, minutes: Math.min(Math.max(raw, 1), maxPass), reply };
}

export async function gate(env: Env, input: GateInput): Promise<{ result: GateResult; tokens: number }> {
  const date = new Date().toISOString().slice(0, 10);
  const out = await askClaude(env, {
    system: gatePrompt,
    user: gateUserMessage(input, date),
    schema: SCHEMA,
    maxTokens: 1024,
  });
  const result = out.ok ? enforce(out.data, intVar(env.MAX_PASS_MINUTES, 10)) : FALLBACK;
  return { result, tokens: out.tokens };
}

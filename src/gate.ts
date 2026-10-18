import gatePrompt from "../prompts/gate.md";
import { askClaude } from "./claude";
import { type Env, intVar } from "./env";
import { voice } from "./voice";
import { examText, type GateInput } from "./validate";

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
  const exam = examText(input.exam);
  return [
    input.now ? `now: ${input.now}` : `today: ${date}`,
    `exam mode: ${exam}`,
    `goal: ${input.goal || "not given"}`,
    `site: ${input.site}`,
    ...(input.kind === "site"
      ? ["kind: its own limit", `minutes used today on this site: ${input.minutesUsed} of its own ${input.budget}-minute limit`]
      : [`kind: ${input.kind}`, `minutes used today on ${input.kind}: ${input.minutesUsed} of a ${input.budget}-minute budget`]),
    `deadlines:\n${deadlines}`,
    "",
    ...(input.asked ? [`the gate already asked: ${input.asked.replace(/<\/?message>/gi, "")}`, "the message below answers that question: decide allow or deny, do not ask again"] : []),
    // Strip anything that looks like our closing tag so the message cannot step outside it.
    `<message>\n${input.message.replace(/<\/?message>/gi, "")}\n</message>`,
  ].join("\n");
}

/**
 * Whatever the model returns, the server has the last word: only allow carries minutes,
 * a pass is at least 1 and at most MAX_PASS_MINUTES (MAX_EXAM_PASS_MINUTES in exam mode), and the reply is short.
 */
export function enforce(data: unknown, maxPass: number): GateResult {
  if (typeof data !== "object" || data === null) return FALLBACK;
  const d = data as Record<string, unknown>;
  const decision = d.decision;
  if (decision !== "allow" && decision !== "deny" && decision !== "ask") return FALLBACK;
  const reply = typeof d.reply === "string" ? voice(d.reply.trim()).slice(0, 280) : "";
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
  const maxPass = intVar(env.MAX_PASS_MINUTES, 10);
  const cap = input.exam ? Math.min(maxPass, intVar(env.MAX_EXAM_PASS_MINUTES, 5)) : maxPass;
  let result = out.ok ? enforce(out.data, cap) : FALLBACK;
  let tokens = out.tokens;
  if (input.asked && result.decision === "ask") {
    // After one question the gate decides (Maxime, 2026-10-18: a tester answered "econometrics" for her stats
    // exam and was asked again, which counted as a no). Asked once more to decide; else a no with a way forward.
    const again = await askClaude(env, {
      system: gatePrompt,
      user: gateUserMessage(input, date) + "\n\nYou asked a question again. The student already answered your one question: return allow or deny.",
      schema: SCHEMA, maxTokens: 1024,
    });
    tokens += again.tokens;
    const second = again.ok ? enforce(again.data, cap) : FALLBACK;
    result = second.decision === "ask" || second === FALLBACK ? wayForward(input) : second;
  }
  return { result, tokens };
}

/** A no after the gate's one question, never a dead end: what to open instead. */
export function wayForward(input: GateInput): GateResult {
  if (input.exam) {
    // "stats exam" -> "stats": the subject, not the event.
    const subject = input.exam.goal.replace(/\b(exams?|midterms?|finals?|quiz(zes)?|tests?)\b/gi, "").replace(/\s+/g, " ").trim() || "your exam";
    const reply = input.site === "youtube.com"
      ? `That stays closed for now. Open a video about ${subject} and it will play.`
      : `That stays closed for now. Your course sites and study sites stay open; for this page, tell the gate exactly what you need for ${subject}.`;
    return { decision: "deny", minutes: 0, reply: voice(reply).slice(0, 280) };
  }
  return { decision: "deny", minutes: 0, reply: "That stays closed for now. Try again later and say exactly what you need it for." };
}

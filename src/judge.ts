import judgePrompt from "../prompts/judge.md";
import { askClaude } from "./claude";
import type { Env } from "./env";
import type { JudgeInput } from "./validate";

/** `judged: false` means the model gave nothing usable; the extension then judges by the rule's words. */
export interface JudgeResult {
  rule: string | null;
  judged: boolean;
  /** In exam mode: whether the video is about the exam's subject. null outside exam mode, or not judged. */
  forExam: boolean | null;
}

// The ids change per request, so the schema stays fixed and the server checks the id.
const SCHEMA = {
  type: "object",
  properties: { rule: { type: "string" }, forExam: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
  required: ["rule", "forExam"],
  additionalProperties: false,
};

const strip = (s: string) => s.replace(/<\/?(title|channel|rules?)>/gi, "");

export function judgeUserMessage(input: JudgeInput): string {
  const rules = input.rules
    .map((r) => `- id: ${r.id}\n  about: ${strip(r.about)}\n  except: ${strip(r.except) || "(none)"}`)
    .join("\n");
  return [
    `site: ${input.site}`,
    `exam mode: ${input.examGoal !== null ? `on, for "${strip(input.examGoal) || "an exam"}"` : "off"}`,
    `rules:${rules ? "\n" + rules : " none"}`,
    "",
    `<title>${strip(input.title)}</title>`,
    `<channel>${strip(input.channel) || "(unknown)"}</channel>`,
  ].join("\n");
}

/** The answer must name one of the rules sent, or none. Anything else is not a judgment. */
export function enforceJudgment(data: unknown, input: JudgeInput): JudgeResult {
  const d = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const forExam = input.examGoal !== null && typeof d.forExam === "boolean" ? d.forExam : null;
  // The exam sent as a rule: an on-topic video is answered as that rule, as the extension reads it.
  if (input.examRule && forExam) return { rule: "exam", judged: true, forExam };
  if (d.rule === "none") return { rule: null, judged: true, forExam };
  if (typeof d.rule === "string" && input.rules.some((r) => r.id === d.rule)) return { rule: d.rule, judged: true, forExam };
  return { rule: null, judged: false, forExam };
}

export async function judge(env: Env, input: JudgeInput): Promise<{ result: JudgeResult; tokens: number }> {
  const out = await askClaude(env, { system: judgePrompt, user: judgeUserMessage(input), schema: SCHEMA, maxTokens: 512 });
  return { result: out.ok ? enforceJudgment(out.data, input) : { rule: null, judged: false, forExam: null }, tokens: out.tokens };
}

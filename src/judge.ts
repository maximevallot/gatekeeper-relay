import judgePrompt from "../prompts/judge.md";
import { askClaude } from "./claude";
import type { Env } from "./env";
import type { JudgeInput } from "./validate";

/** `judged: false` means the model gave nothing usable; the extension then judges by the rule's words. */
export interface JudgeResult {
  rule: string | null;
  judged: boolean;
}

// The ids change per request, so the schema stays fixed and the server checks the id.
const SCHEMA = {
  type: "object",
  properties: { rule: { type: "string" } },
  required: ["rule"],
  additionalProperties: false,
};

const strip = (s: string) => s.replace(/<\/?(title|channel|rules?)>/gi, "");

export function judgeUserMessage(input: JudgeInput): string {
  const rules = input.rules
    .map((r) => `- id: ${r.id}\n  about: ${strip(r.about)}\n  except: ${strip(r.except) || "(none)"}`)
    .join("\n");
  return [
    `site: ${input.site}`,
    `rules:\n${rules}`,
    "",
    `<title>${strip(input.title)}</title>`,
    `<channel>${strip(input.channel) || "(unknown)"}</channel>`,
  ].join("\n");
}

/** The answer must name one of the rules sent, or none. Anything else is not a judgment. */
export function enforceJudgment(data: unknown, input: JudgeInput): JudgeResult {
  const rule = typeof data === "object" && data !== null ? (data as Record<string, unknown>).rule : undefined;
  if (rule === "none") return { rule: null, judged: true };
  if (typeof rule === "string" && input.rules.some((r) => r.id === rule)) return { rule, judged: true };
  return { rule: null, judged: false };
}

export async function judge(env: Env, input: JudgeInput): Promise<{ result: JudgeResult; tokens: number }> {
  const out = await askClaude(env, { system: judgePrompt, user: judgeUserMessage(input), schema: SCHEMA, maxTokens: 512 });
  return { result: out.ok ? enforceJudgment(out.data, input) : { rule: null, judged: false }, tokens: out.tokens };
}

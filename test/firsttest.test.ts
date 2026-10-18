import { afterEach, describe, expect, it, vi } from "vitest";
import gatePrompt from "../prompts/gate.md";
import loosenPrompt from "../prompts/loosen.md";
import rulesPrompt from "../prompts/rules.md";
import { voice } from "../src/voice";
import { gateBody, mockAnthropic, post } from "./helpers";

afterEach(() => vi.restoreAllMocks());

// Maxime's own test in a fresh Chrome profile on 2026-10-18, before the first testers install 0.2.0.

const RULES = { kinds: { video: 10 }, sites: {}, siteLimits: {}, videos: [], dayStart: 4 };
const chat = (message: string, extra: Record<string, unknown> = {}) => ({
  installId: crypto.randomUUID(), message, history: [], rules: RULES, today: "2026-10-18", now: "2026-10-18T15:00:00-04:00", exam: null, ...extra,
});

describe("replies speak as Gatekeeper, in plain words", () => {
  it("never name the model or the agent", () => {
    expect(voice("Claude decides. The agent will ask you why. Gatekeeper's agent said no.")).toBe("Gatekeeper decides. Gatekeeper will ask you why. Gatekeeper said no.");
  });

  it("filters every reply: the chat, the gate and loosening", async () => {
    mockAnthropic({ answer: { reply: "The agent will ask you why.", question: null, diff: [] } });
    expect(((await (await post("/rules", chat("hello"))).json()) as any).reply).toBe("Gatekeeper will ask you why.");
    mockAnthropic({ answer: { decision: "deny", minutes: 0, reply: "Claude says no." } });
    expect(((await (await post("/gate", gateBody())).json()) as any).reply).toBe("Gatekeeper says no.");
    mockAnthropic({ answer: { decision: "deny", when: null, reply: "The agent says no." } });
    const loosen = { installId: crypto.randomUUID(), kind: "rules", changes: ["Video: 10 → 20 min"], message: "more" };
    expect(((await (await post("/loosen", loosen)).json()) as any).reply).toBe("Gatekeeper says no.");
  });

  it("tells every prompt to avoid internal words ('watch youtube videos on astrophysics' got 'the video kind is not watched')", () => {
    expect(rulesPrompt).toContain('say "YouTube has no limit yet", not "the video kind is not watched"');
    for (const p of [rulesPrompt, gatePrompt, loosenPrompt]) expect(p).toContain("Never say Claude, AI, the agent or the model");
  });
});

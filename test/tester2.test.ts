import { afterEach, describe, expect, it, vi } from "vitest";
import rulesPrompt from "../prompts/rules.md";
import { claimsChange } from "../src/rules";
import { mockAnthropic, post } from "./helpers";

afterEach(() => vi.restoreAllMocks());

// Maxime's re-test of v0.2.0-tester2 (2026-10-18). Reproduced against the live /rules: one answer in three
// said "I've lowered it" with an empty diff, so the extension said "Nothing changed."
const RULES = { kinds: { social: 15, video: 45 }, sites: {}, siteLimits: {}, study: [], videos: [], dayStart: 4 };
const chat = (message: string, extra: Record<string, unknown> = {}) => ({
  installId: crypto.randomUUID(), message, history: [], rules: RULES, today: "2026-10-18", now: "2026-10-18T21:00:00-04:00", exam: null, loosenLocked: false, ...extra,
});
const CLAIMED = { reply: "Social media is already limited to 15 minutes a day, so I've lowered it to 10 minutes a day. Tell me if you wanted a different number.", question: null, diff: [] };
const REAL = { reply: "Social media: 15 → 10 minutes a day.", question: null, diff: [{ op: "budget", kind: "social", minutes: 10 }] };

describe("no reply claims a change the diff doesn't carry", () => {
  it("asks once more when the reply claims a change with an empty diff, and keeps the real change", async () => {
    const calls = mockAnthropic({ answer: CLAIMED }, { answer: REAL });
    const out = await (await post("/rules", chat("Less social media"))).json();
    expect(out).toEqual(REAL);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.messages[0].content).toContain("Your last answer said a change was made but its diff was empty");
  });

  it("turns a second empty claim into a question, never a claim", async () => {
    mockAnthropic({ answer: CLAIMED }, { answer: CLAIMED });
    const out = (await (await post("/rules", chat("Less social media"))).json()) as any;
    expect(out).toEqual({ reply: "", question: "What should change? Name the site or category, and the minutes a day.", diff: [] });
  });

  it("leaves a real question alone, and a reply that changes nothing and says so", async () => {
    const asked = { reply: "Social media is 15 minutes a day.", question: "How many minutes a day should social media get?", diff: [] };
    const calls = mockAnthropic({ answer: asked });
    expect(await (await post("/rules", chat("Less social media"))).json()).toEqual(asked);
    expect(calls).toHaveLength(1);
    expect(claimsChange({ reply: "That changes nothing: Social media is already 15 minutes a day.", question: null, diff: [] })).toBe(false);
  });

  it("recognizes the ways a change gets claimed", () => {
    for (const r of ["I've lowered it to 10 minutes a day.", "I set Video to 20.", "Social media is now limited to 10.", "Done.", "Video has been lowered to 20 minutes."]) {
      expect(claimsChange({ reply: r, question: null, diff: [] }), r).toBe(true);
    }
  });

  it("describes the change itself when a sentence about timing had to go ('15 minutes now, so 10')", async () => {
    mockAnthropic({ answer: { reply: "Social media is 15 minutes a day now, so I lowered it to 10. Tell me if you want a different number.", question: null, diff: [{ op: "budget", kind: "social", minutes: 10 }] } });
    expect(((await (await post("/rules", chat("Less social media"))).json()) as any).reply).toBe("Social media: 15 → 10 minutes a day.");
  });

  it("tells the model a vague tightening is a real, lower number in diff", () => {
    expect(rulesPrompt).toContain('"Less social media" with Social media at 15 is `budget` social 10 in `diff`, not only words.');
  });
});

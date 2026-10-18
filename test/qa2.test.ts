import { afterEach, describe, expect, it, vi } from "vitest";
import rulesPrompt from "../prompts/rules.md";
import { mockAnthropic, post } from "./helpers";

afterEach(() => vi.restoreAllMocks());

// QA round 2, chat H4 (#15): requests about time of day or weekdays got no card. The prompt now takes
// the stricter reading the operations can express and says what is missing. These are the report's
// own requests; the model is mocked, so these check the prompt carries each case and the card survives.
const CASES = [
  {
    message: "no youtube after 11pm",
    prompt: '"no youtube after 11pm" is `siteLimit` youtube.com 0',
    diff: [{ op: "siteLimit", domain: "youtube.com", minutes: 0 }],
  },
  {
    message: "no news on weekdays",
    prompt: '"no news on weekdays" is `budget` news 0',
    diff: [{ op: "budget", kind: "news", minutes: 0 }],
  },
  {
    message: "reddit closed on weekdays, 30 min on weekends",
    prompt: '"reddit closed on weekdays, 30 min on weekends" is `siteLimit` reddit.com 0, the stricter half',
    diff: [{ op: "siteLimit", domain: "reddit.com", minutes: 0 }],
  },
  {
    message: "pas de netflix en semaine",
    prompt: '"pas de netflix en semaine" is `siteLimit` netflix.com 0',
    diff: [{ op: "siteLimit", domain: "netflix.com", minutes: 0 }],
  },
];

describe("QA round 2: schedules the rules cannot express yet", () => {
  for (const c of CASES) {
    it(`"${c.message}" gets the stricter card and a note on what is missing`, async () => {
      expect(rulesPrompt).toContain(c.prompt);
      const answer = { reply: "There are no time-of-day or weekday rules yet, so this applies all day, every day.", question: null, diff: c.diff };
      const calls = mockAnthropic({ answer });
      const res = await post("/rules", {
        installId: crypto.randomUUID(), message: c.message, today: "2026-10-17", now: "2026-10-17T21:50:00-04:00",
        history: [], rules: { kinds: { social: 30, video: 45 }, sites: {}, siteLimits: {}, videos: [], dayStart: 4 },
      });
      expect(await res.json()).toEqual(answer);
      expect(calls[0]!.body.messages[0].content).toContain(`<message>\n${c.message}\n</message>`);
    });
  }

  it("tells the model never to answer these with only a question, nor take the looser half", () => {
    expect(rulesPrompt).toContain("Never answer such a request with only a question, and never take the looser half.");
    expect(rulesPrompt).toContain("only when no part of the request can be carried out");
  });
});

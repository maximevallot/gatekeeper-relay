import { afterEach, describe, expect, it, vi } from "vitest";
import rulesPrompt from "../prompts/rules.md";
import { mockAnthropic, post } from "./helpers";

afterEach(() => vi.restoreAllMocks());

// Maxime's test on 2026-10-17: "i want to put a limit on the site lequipe" got a proposal to file
// lequipe.fr under news and a question about watching news. He wanted a limit on that site alone.
const body = (overrides: Record<string, unknown> = {}) => ({
  installId: crypto.randomUUID(),
  message: "i want to put a limit on the site lequipe",
  today: "2026-10-17",
  now: "2026-10-17T15:10:00-04:00",
  exam: null,
  history: [],
  rules: { kinds: { video: 20, social: 15 }, sites: {}, siteLimits: {}, videos: [], dayStart: 4 },
  ...overrides,
});

const ANSWER = { reply: "lequipe.fr: 15 minutes a day.", question: null, diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 15 }] };

describe("a limit on one site", () => {
  it("turns 'limit lequipe' into lequipe.fr's own 15 minutes, with no question", async () => {
    const calls = mockAnthropic({ answer: ANSWER });
    const res = await post("/rules", body());
    expect(await res.json()).toEqual(ANSWER);

    // The prompt carries this exact case, and tells the model to choose a default rather than ask.
    expect(rulesPrompt).toContain('"i want to put a limit on the site lequipe" is `siteLimit` lequipe.fr 15');
    expect(rulesPrompt).toContain("Do not ask the student how to model what they want");
    const items = calls[0]!.body.output_config.format.schema.properties.diff.items.anyOf as any[];
    const ops = items.map((i) => i.properties.op.const);
    expect(ops).toEqual(expect.arrayContaining(["siteLimit", "dropSiteLimit"]));
    expect(calls[0]!.body.messages[0].content).toContain("- sites with their own limit: none");
  });

  it("takes Maxime's correction as a change, not another question", async () => {
    const calls = mockAnthropic({ answer: ANSWER });
    const history = [
      { role: "user", text: "i want to put a limit on the site lequipe" },
      { role: "gatekeeper", text: "lequipe.fr counts as news. Do you want to watch news, and for how many minutes a day?" },
    ];
    const res = await post("/rules", body({ history, message: "no i want a limit on lequipe irrespective of it being news" }));
    const out = (await res.json()) as { question: unknown };
    expect(out).toEqual(ANSWER);
    expect(out.question).toBeNull();
    expect(calls[0]!.body.messages[0].content).toContain("gatekeeper: lequipe.fr counts as news.");
    expect(rulesPrompt).toContain("never answer a correction with another question");
  });

  it("handles 'make it 30' and 'only in exam mode' as changes to the same site", async () => {
    const history = [
      { role: "user", text: "i want to put a limit on the site lequipe" },
      { role: "gatekeeper", text: "lequipe.fr: 15 minutes a day." },
    ];
    const rules = { kinds: {}, sites: {}, siteLimits: { "lequipe.fr": 15 }, videos: [], dayStart: 4 };
    const thirty = { reply: "lequipe.fr: 30 minutes a day.", question: null, diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: 30 }] };
    mockAnthropic({ answer: thirty });
    expect(await (await post("/rules", body({ history, rules, message: "make it 30" }))).json()).toEqual(thirty);

    const examOnly = {
      reply: "lequipe.fr stays open on normal days and closes in exam mode.",
      question: null,
      diff: [{ op: "siteLimit", domain: "lequipe.fr", minutes: null }],
    };
    const calls = mockAnthropic({ answer: examOnly });
    const later = { ...rules, siteLimits: { "lequipe.fr": null } };
    expect(await (await post("/rules", body({ history, rules: later, message: "only in exam mode" }))).json()).toEqual(examOnly);
    expect(calls[0]!.body.messages[0].content).toContain("- sites with their own limit: lequipe.fr closed only in exam mode");
    expect(rulesPrompt).toContain('"only in exam mode" is `siteLimit` lequipe.fr `null`');
  });

  it("shows the student's site limits to the model and checks what comes back", async () => {
    const calls = mockAnthropic({
      answer: {
        reply: "OK.",
        question: null,
        diff: [
          { op: "siteLimit", domain: "https://www.LEquipe.fr/football", minutes: 5000 },
          { op: "siteLimit", domain: "not a site", minutes: 10 },
          { op: "dropSiteLimit", domain: "lequipe.fr" },
          { op: "dropSiteLimit", domain: "nowhere.com" },
        ],
      },
    });
    const res = await post("/rules", body({ rules: { kinds: {}, sites: {}, siteLimits: { "www.lequipe.fr": 15 }, videos: [], dayStart: 4 } }));
    expect(((await res.json()) as { diff: unknown[] }).diff).toEqual([
      { op: "siteLimit", domain: "lequipe.fr", minutes: 1440 },
      { op: "dropSiteLimit", domain: "lequipe.fr" },
    ]);
    expect(calls[0]!.body.messages[0].content).toContain("- sites with their own limit: lequipe.fr 15 min a day");
  });

  it("rejects malformed site limits before any call", async () => {
    const calls = mockAnthropic();
    for (const siteLimits of [{ "lequipe.fr": -1 }, { "lequipe.fr": "15" }, { "not a site": 10 }, []]) {
      const res = await post("/rules", body({ rules: { kinds: {}, sites: {}, siteLimits, videos: [], dayStart: 4 } }));
      expect(res.status, JSON.stringify(siteLimits)).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});

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
  rules: { kinds: { video: 20, social: 15 }, sites: {}, siteBudgets: {}, videos: [], dayStart: 4 },
  ...overrides,
});

const ANSWER = { reply: "lequipe.fr: 15 minutes a day.", question: null, diff: [{ op: "siteBudget", domain: "lequipe.fr", minutes: 15 }] };

describe("a limit on one site", () => {
  it("turns 'limit lequipe' into lequipe.fr's own 15 minutes, with no question", async () => {
    const calls = mockAnthropic({ answer: ANSWER });
    const res = await post("/rules", body());
    expect(await res.json()).toEqual(ANSWER);

    // The prompt carries this exact case, and tells the model to choose a default rather than ask.
    expect(rulesPrompt).toContain('"i want to put a limit on the site lequipe" is `siteBudget` lequipe.fr 15');
    expect(rulesPrompt).toContain("Do not ask the student how to model what they want");
    const items = calls[0]!.body.output_config.format.schema.properties.diff.items.anyOf as any[];
    const ops = items.map((i) => i.properties.op.const);
    expect(ops).toEqual(expect.arrayContaining(["siteBudget", "dropSite"]));
    expect(calls[0]!.body.messages[0].content).toContain("- sites with their own limit: none");
  });

  it("follows up on the earlier exchange the same way", async () => {
    const calls = mockAnthropic({ answer: ANSWER });
    const history = [
      { role: "user", text: "i want to put a limit on the site lequipe" },
      { role: "gatekeeper", text: "lequipe.fr counts as news. Do you want to watch news, and for how many minutes a day?" },
    ];
    const res = await post("/rules", body({ history, message: "just that site, irrespective of it being news" }));
    expect(await res.json()).toEqual(ANSWER);
    expect(calls[0]!.body.messages[0].content).toContain("gatekeeper: lequipe.fr counts as news.");
  });

  it("shows the student's site limits to the model and checks what comes back", async () => {
    const calls = mockAnthropic({
      answer: {
        reply: "OK.",
        question: null,
        diff: [
          { op: "siteBudget", domain: "https://www.LEquipe.fr/football", minutes: 5000 },
          { op: "siteBudget", domain: "not a site", minutes: 10 },
          { op: "dropSite", domain: "lequipe.fr" },
          { op: "dropSite", domain: "nowhere.com" },
        ],
      },
    });
    const res = await post("/rules", body({ rules: { kinds: {}, sites: {}, siteBudgets: { "www.lequipe.fr": 15 }, videos: [], dayStart: 4 } }));
    expect(((await res.json()) as { diff: unknown[] }).diff).toEqual([
      { op: "siteBudget", domain: "lequipe.fr", minutes: 1440 },
      { op: "dropSite", domain: "lequipe.fr" },
    ]);
    expect(calls[0]!.body.messages[0].content).toContain("- sites with their own limit: lequipe.fr 15 min a day");
  });

  it("rejects malformed site limits before any call", async () => {
    const calls = mockAnthropic();
    for (const siteBudgets of [{ "lequipe.fr": -1 }, { "lequipe.fr": "15" }, { "not a site": 10 }, []]) {
      const res = await post("/rules", body({ rules: { kinds: {}, sites: {}, siteBudgets, videos: [], dayStart: 4 } }));
      expect(res.status, JSON.stringify(siteBudgets)).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});

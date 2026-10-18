import { afterEach, describe, expect, it, vi } from "vitest";
import loosenPrompt from "../prompts/loosen.md";
import rulesPrompt from "../prompts/rules.md";
import { mockAnthropic, post } from "./helpers";

afterEach(() => vi.restoreAllMocks());

// QA round 3 (~/gatekeeper-app-qa/round3), the requests exactly as the extension sent them.

describe("QA round 3, #4 (chat N1): after one no, the chat says what happens", () => {
  // #3c: "give games 30 min", right after the agent said no to a loosening.
  const body = (loosenLocked?: boolean) => ({
    installId: crypto.randomUUID(),
    message: "give games 30 min",
    history: [
      { role: "gatekeeper", text: "To loosen the rest, tell me why: what changed?" },
      { role: "user", text: "actually only in exam mode" },
      { role: "gatekeeper", text: "lequipe.fr: closed on normal days, closed only in exam mode." },
      { role: "gatekeeper", text: "To loosen the rest, tell me why: what changed?" },
      { role: "user", text: "I only check the scores at lunch, it never costs me more than 10 minutes, I just want it shut during exams" },
      { role: "gatekeeper", text: "Your 15 minutes a day already covers the lunch check you describe, so the limit stays. Exam mode can still shut the site when you need it. Ask again tomorrow if something changes." },
    ],
    rules: { kinds: { social: 30, video: 45, games: 15 }, sites: {}, siteLimits: { "lequipe.fr": 15 }, videos: [], dayStart: 4 },
    today: "2026-10-17",
    exam: null,
    now: "2026-10-18T00:17:08-04:00",
    ...(loosenLocked === undefined ? {} : { loosenLocked }),
  });
  const MODEL = { reply: "Games budget changed from 15 to 30 minutes a day.", question: null, diff: [{ op: "budget", kind: "games", minutes: 30 }] };

  it("with loosenLocked, the looser change leaves the card and the reply says why", async () => {
    const calls = mockAnthropic({ answer: MODEL });
    const out = await (await post("/rules", body(true))).json();
    expect(out).toEqual({ reply: "I said no to a loosening today, so that waits: ask again after 4:00.", question: null, diff: [] });
    expect(calls[0]!.body.messages[0].content).toContain("- loosening: locked until 4:00 tomorrow by an earlier no");
    expect(rulesPrompt).toContain("When the rules say loosening is locked by an earlier no");
  });

  it("keeps the stricter part of a mixed request", async () => {
    mockAnthropic({ answer: { reply: "OK.", question: null, diff: [{ op: "budget", kind: "games", minutes: 30 }, { op: "siteLimit", domain: "reddit.com", minutes: 10 }] } });
    const out = (await (await post("/rules", { ...body(true), message: "give games 30 min and limit reddit to 10" })).json()) as any;
    expect(out.diff).toEqual([{ op: "siteLimit", domain: "reddit.com", minutes: 10 }]);
    expect(out.reply).toBe("The stricter part applies now. I said no to a loosening today, so the rest waits: ask again after 4:00.");
  });

  it("without the flag, nothing changes", async () => {
    mockAnthropic({ answer: MODEL });
    expect(await (await post("/rules", body())).json()).toEqual(MODEL);
    mockAnthropic({ answer: MODEL });
    expect(await (await post("/rules", body(false))).json()).toEqual(MODEL);
  });

  it("knows which changes loosen", async () => {
    const { loosens } = await import("../src/rules");
    const r = { kinds: { games: 15 }, sites: {}, siteLimits: { "lequipe.fr": 15, "x.com": null }, videos: [{ id: "v1", site: "youtube.com", about: "a", except: "", minutes: 0 }], dayStart: 4 } as any;
    expect(loosens({ op: "budget", kind: "games", minutes: 30 }, r)).toBe(true);
    expect(loosens({ op: "budget", kind: "games", minutes: 10 }, r)).toBe(false);
    expect(loosens({ op: "budget", kind: "news", minutes: 30 }, r)).toBe(false); // newly watched
    expect(loosens({ op: "unwatch", kind: "games" }, r)).toBe(true);
    expect(loosens({ op: "siteLimit", domain: "lequipe.fr", minutes: null }, r)).toBe(true);
    expect(loosens({ op: "siteLimit", domain: "lequipe.fr", minutes: 10 }, r)).toBe(false);
    expect(loosens({ op: "siteLimit", domain: "x.com", minutes: 20 }, r)).toBe(false);
    expect(loosens({ op: "siteLimit", domain: "reddit.com", minutes: 10 }, r)).toBe(false);
    expect(loosens({ op: "dropSiteLimit", domain: "lequipe.fr" }, r)).toBe(true);
    expect(loosens({ op: "videoBudget", id: "v1", minutes: 30 }, r)).toBe(true);
    expect(loosens({ op: "dropVideo", id: "v1" }, r)).toBe(true);
    expect(loosens({ op: "examEnd" }, r)).toBe(true);
    expect(loosens({ op: "examStart", until: "x", goal: "", at: null }, r)).toBe(false);
    expect(loosens({ op: "dayStart", hour: 6 }, r)).toBe(true);
  });
});

describe("QA round 3, #3 (chat N2): an exam that's over gets a yes, never a flat no", () => {
  // #17b: exam mode set from the chat until Friday noon, no calendar link, so examAt is null.
  const body = {
    installId: crypto.randomUUID(),
    kind: "exam",
    goal: "Finish my thesis chapter 3 by November",
    changes: ["End exam mode early"],
    asked: "",
    message: "the exam got moved up, I took it this afternoon, it's over",
    exam: { until: "2026-10-23T12:00:00-04:00", goal: "Canvas", examAt: null },
    now: "2026-10-18T00:19:28-04:00",
  };

  it("tells the agent the exam's time isn't known, so a yes ends exam mode tomorrow morning", async () => {
    const calls = mockAnthropic({ answer: { decision: "allow", when: "morning", reply: "OK: exam mode ends tomorrow morning." } });
    const out = await (await post("/loosen", body)).json();
    expect(out).toEqual({ decision: "allow", when: "morning", reply: "OK: exam mode ends tomorrow morning." });
    expect(calls[0]!.body.messages[0].content).toContain("the exam's own time: not known to have passed: a yes ends exam mode tomorrow morning");
    expect(loosenPrompt).toContain("never answer a student who says the exam is over with a flat no");
  });

  it("keeps the morning when the model says now without the exam's time", async () => {
    mockAnthropic({ answer: { decision: "allow", when: "now", reply: "Exam mode ends now." } });
    expect(await (await post("/loosen", body)).json()).toEqual({ decision: "allow", when: "morning", reply: "OK: exam mode ends tomorrow morning." });
  });
});

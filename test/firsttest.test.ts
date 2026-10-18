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

describe("a loosening is never described as done, and the watch week never promises now", () => {
  it("'actually no 20min' (from 10) says Gatekeeper will ask why, not that Video is now 20", async () => {
    mockAnthropic({ answer: { reply: "Video is now limited to 20 minutes a day, replacing the 10-minute limit.", question: null, diff: [{ op: "budget", kind: "video", minutes: 20 }] } });
    const out = (await (await post("/rules", chat("actually no 20min"))).json()) as any;
    expect(out.diff).toEqual([{ op: "budget", kind: "video", minutes: 20 }]);
    expect(out.reply).toBe("Video: 10 → 20 minutes a day. That gives you more time, so Gatekeeper will ask you why before it changes.");
  });

  it("'limit youtube and videos to 15min' in the watch week doesn't say it applies now", async () => {
    mockAnthropic({ answer: { reply: "Video: 15 minutes a day. It applies now.", question: null, diff: [{ op: "budget", kind: "video", minutes: 15 }] } });
    const out = (await (await post("/rules", chat("limit youtube and videos to 15min", { rules: { ...RULES, kinds: {} }, watching: true }))).json()) as any;
    expect(out.reply).toBe("Video: 15 minutes a day. This first week Gatekeeper only watches and closes nothing, so your limits start when the week ends.");
  });

  it("a mixed card says which part waits for Gatekeeper", async () => {
    mockAnthropic({ answer: { reply: "Done.", question: null, diff: [{ op: "budget", kind: "video", minutes: 20 }, { op: "siteLimit", domain: "reddit.com", minutes: 10 }] } });
    const out = (await (await post("/rules", chat("20 min of video and limit reddit to 10"))).json()) as any;
    expect(out.reply).toBe("Video: 10 → 20 minutes a day. That gives you more time, so Gatekeeper will ask you why before it changes. The stricter part applies now.");
  });
});

describe("exam mode: a no on the rules doesn't block it, and a stuck student gets the address", () => {
  const EXAM = { until: "2026-10-23T12:00:00-04:00", goal: "Midterm" };

  it("keeps 'end exam mode' on the card when a no holds the rules", async () => {
    mockAnthropic({ answer: { reply: "OK.", question: null, diff: [{ op: "examEnd" }] } });
    const out = (await (await post("/rules", chat("need to end exam mode", { exam: EXAM, loosenLocked: true }))).json()) as any;
    expect(out.diff).toEqual([{ op: "examEnd" }]);
    expect(out.reply).not.toContain("I said no");
  });

  it("drops the looser rule but keeps exam mode's end, and says which is which", async () => {
    mockAnthropic({ answer: { reply: "OK.", question: null, diff: [{ op: "budget", kind: "video", minutes: 30 }, { op: "examEnd" }] } });
    const out = (await (await post("/rules", chat("more video and end exam mode", { exam: EXAM, loosenLocked: true }))).json()) as any;
    expect(out.diff).toEqual([{ op: "examEnd" }]);
    expect(out.reply).toBe("I said no to a loosening of your rules today, so the rest waits: ask again after 4:00. Ending exam mode early is separate: Gatekeeper will ask you why.");
  });

  it("tells the model a stuck student needs canvas.mit.edu, and that exam mode isn't locked by a no", async () => {
    const calls = mockAnthropic({ answer: { reply: "MIT's Canvas is canvas.mit.edu.", question: null, diff: [] } });
    await post("/rules", chat("need to end exam mode i couldnt access mit canvas because i didnt know the website name", { exam: EXAM, loosenLocked: true }));
    expect(calls[0]!.body.messages[0].content).toContain("Ending exam mode early is not locked by it.");
    expect(rulesPrompt).toContain("MIT's Canvas is canvas.mit.edu");
  });
});

describe("the gate in exam mode never sends someone off without a way", () => {
  it("tells the model to name the study site's address or give a short pass (search.brave.com, 'mit canvas')", async () => {
    expect(gatePrompt).toContain("Never send them off without a way.");
    expect(gatePrompt).toContain("MIT's Canvas is canvas.mit.edu");
    const answer = { decision: "allow", minutes: 2, reply: "MIT's Canvas is canvas.mit.edu. Two minutes to get there." };
    const calls = mockAnthropic({ answer });
    const out = await (await post("/gate", gateBody({
      site: "search.brave.com", kind: "other", message: "I'm looking for mit canvas", exam: { until: "2026-10-23T12:00:00-04:00", goal: "Midterm" },
    }))).json();
    expect(out).toEqual(answer);
    expect(calls[0]!.body.messages[0].content).toContain("site: search.brave.com");
  });
});

describe("a no from Gatekeeper is calm and gives a way forward", () => {
  it("tells the model never to answer with a bare no ('10min is too short cant do anything in 10min videos')", () => {
    expect(loosenPrompt).toContain('never a bare "No, 10 minutes stays."');
    expect(loosenPrompt).toContain("ask at the gate on that video; you can ask for more again tomorrow");
  });
});

describe("internal words never reach the student", () => {
  it("names the category instead of 'the Video kind', and 'not limited' instead of 'not watched'", () => {
    expect(voice("YouTube videos about astrophysics will count against that rule, not against the Video kind."))
      .toBe("YouTube videos about astrophysics will count against that rule, not against Video.");
    expect(voice("YouTube is a video site, so it falls under that kind.")).toBe("YouTube is a video site, so it falls under that category.");
    expect(voice("Gatekeeper's other YouTube videos are not limited, since the video kind is not watched."))
      .toBe("Gatekeeper's other YouTube videos are not limited, since video is not limited.");
    expect(voice("A kind of video you like stays free.")).toBe("A kind of video you like stays free."); // ordinary English is left alone
  });
});

it("capitalizes a category that starts a sentence after a swap", () => {
  expect(voice("The video kind is not watched. OK.")).toBe("Video is not limited. OK.");
});

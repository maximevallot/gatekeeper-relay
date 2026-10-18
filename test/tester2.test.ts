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

describe("'are you connected to my calendar now?' is answered from the calendar's status, never its events", () => {
  const ask = (calendar?: unknown) => chat("are you connected to my calendar now?", calendar === undefined ? {} : { calendar });

  it("tells the model the status, and never sends events or the link", async () => {
    for (const [calendar, line] of [
      [{ status: "connected", readAt: "2026-10-18T08:00:00-04:00" }, "- calendar link: connected, last read 2026-10-18T08:00:00-04:00; the events themselves are not sent to this chat"],
      [{ status: "failed", readAt: null }, "- calendar link: pasted, but the last time it was read it failed"],
      [{ status: "none", readAt: null }, "- calendar link: none pasted"],
      [undefined, "- calendar link: not known to this chat"],
    ] as const) {
      const calls = mockAnthropic({ answer: { reply: "OK.", question: null, diff: [] } });
      expect((await post("/rules", ask(calendar))).status).toBe(200);
      expect(calls[0]!.body.messages[0].content).toContain(line);
    }
  });

  it("reads the extension's names: not_working, lastRead and a count of events", async () => {
    let calls = mockAnthropic({ answer: { reply: "OK.", question: null, diff: [] } });
    await post("/rules", ask({ status: "connected", lastRead: "2026-10-18T08:00:00-04:00", events: 3 }));
    expect(calls[0]!.body.messages[0].content).toContain("- calendar link: connected, last read 2026-10-18T08:00:00-04:00, 3 events in the next two weeks; the events themselves are not sent to this chat");
    calls = mockAnthropic({ answer: { reply: "OK.", question: null, diff: [] } });
    await post("/rules", ask({ status: "not_working", lastRead: null, events: 0 }));
    expect(calls[0]!.body.messages[0].content).toContain("- calendar link: pasted, but the last time it was read it failed");
    mockAnthropic();
    expect((await post("/rules", ask({ status: "connected", events: "three" }))).status).toBe(400);
  });

  it("drops anything but the status: no events, no link", async () => {
    const calls = mockAnthropic({ answer: { reply: "OK.", question: null, diff: [] } });
    await post("/rules", ask({ status: "connected", readAt: null, url: "https://canvas.mit.edu/feeds/secret.ics", titles: [{ title: "Midterm", start: 1 }] }));
    const user: string = calls[0]!.body.messages[0].content;
    expect(user).not.toContain("secret.ics");
    expect(user).not.toContain("Midterm");
  });

  it("rejects a malformed status", async () => {
    mockAnthropic();
    expect((await post("/rules", ask({ status: "yes" }))).status).toBe(400);
    expect((await post("/rules", ask({ status: "connected", readAt: "this morning" }))).status).toBe(400);
  });

  it("tells the model where a calendar is added, and never to say Gatekeeper can't use one", () => {
    expect(rulesPrompt).toContain("Rules › Calendar (a link ending in .ics");
    expect(rulesPrompt).toContain("Never say Gatekeeper can't use a calendar at all.");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import gatePrompt from "../prompts/gate.md";
import judgePrompt from "../prompts/judge.md";
import { mockAnthropic, post } from "./helpers";

afterEach(() => vi.restoreAllMocks());

// A tester in exam mode for her stats exam wanted stats videos on YouTube. The gate asked for detail, she
// answered "econometrics", it asked again, the second question counted as a no, and she was blocked 10 minutes.
const EXAM = { until: "2026-10-20T09:00:00-04:00", goal: "stats exam" };
const gate = (message: string, extra: Record<string, unknown> = {}) => ({
  installId: crypto.randomUUID(), goal: "Pass the stats exam", site: "youtube.com", kind: "video", minutesUsed: 0, budget: 0,
  deadlines: [], message, now: "2026-10-18T22:00:00-04:00", exam: EXAM, ...extra,
});
const QUESTION = "Which part of stats do you need to study?";

describe("the gate in exam mode decides after one answer", () => {
  it("may ask once", async () => {
    mockAnthropic({ answer: { decision: "ask", minutes: 0, reply: QUESTION } });
    expect(await (await post("/gate", gate("I need them for my stats exam"))).json()).toEqual({ decision: "ask", minutes: 0, reply: QUESTION });
  });

  it("reads 'econometrics' as the answer, and when the model asks again, asks it once more to decide", async () => {
    const calls = mockAnthropic(
      { answer: { decision: "ask", minutes: 0, reply: "Which econometrics topic?" } },
      { answer: { decision: "allow", minutes: 5, reply: "Five minutes for econometrics videos." } },
    );
    const out = await (await post("/gate", gate("econometrics", { asked: QUESTION }))).json();
    expect(out).toEqual({ decision: "allow", minutes: 5, reply: "Five minutes for econometrics videos." });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.messages[0].content).toContain(`the gate already asked: ${QUESTION}`);
    expect(calls[1]!.body.messages[0].content).toContain("The student already answered your one question: return allow or deny.");
  });

  it("never asks a second question: if the model still asks, the answer is a no with a way forward", async () => {
    mockAnthropic({ answer: { decision: "ask", minutes: 0, reply: "Which econometrics topic?" } });
    const out = await (await post("/gate", gate("econometrics", { asked: QUESTION }))).json();
    expect(out).toEqual({ decision: "deny", minutes: 0, reply: "That stays closed for now. Open a video about stats and it will play." });
  });

  it("outside YouTube and outside exam mode, the no still says what to do", async () => {
    mockAnthropic({ answer: { decision: "ask", minutes: 0, reply: "Which page?" } });
    const site = (await (await post("/gate", gate("the course notes", { asked: QUESTION, site: "reddit.com", kind: "social" }))).json()) as any;
    expect(site.reply).toBe("That stays closed for now. Your course sites and study sites stay open; for this page, tell the gate exactly what you need for stats.");
    mockAnthropic({ answer: { decision: "ask", minutes: 0, reply: "Which page?" } });
    const normal = (await (await post("/gate", gate("work", { asked: "What for?", exam: null }))).json()) as any;
    expect(normal).toEqual({ decision: "deny", minutes: 0, reply: "That stays closed for now. Try again later and say exactly what you need it for." });
  });

  it("tells the model a nearby subject is a yes, and never to ask twice", () => {
    expect(gatePrompt).toContain("decide: allow or deny, never another question");
    expect(gatePrompt).toContain("econometrics, regression or probability for a stats exam");
  });
});

describe("/judge in exam mode: is this video about the exam's subject?", () => {
  const judge = (title: string, channel: string, extra: Record<string, unknown> = {}) => ({
    installId: crypto.randomUUID(), site: "youtube.com", title, channel, rules: [], exam: EXAM, ...extra,
  });

  it("judges against the exam's goal, even with no video rules", async () => {
    const calls = mockAnthropic({ answer: { rule: "none", forExam: true } });
    const out = await (await post("/judge", judge("Econometrics Lecture 5: Multiple Regression", "MIT OpenCourseWare"))).json();
    expect(out).toEqual({ rule: null, judged: true, forExam: true });
    const user: string = calls[0]!.body.messages[0].content;
    expect(user).toContain('exam mode: on, for "stats exam"');
    expect(user).toContain("rules: none");
  });

  it("passes a no for entertainment, and forExam is null outside exam mode", async () => {
    mockAnthropic({ answer: { rule: "none", forExam: false } });
    expect(await (await post("/judge", judge("Top 10 penalty kicks of 2026", "Sky Sports"))).json()).toEqual({ rule: null, judged: true, forExam: false });
    mockAnthropic({ answer: { rule: "v1", forExam: true } });
    const rules = [{ id: "v1", about: "sports highlights", except: "" }];
    expect(await (await post("/judge", judge("Top 10 penalty kicks", "Sky Sports", { exam: null, rules }))).json()).toEqual({ rule: "v1", judged: true, forExam: null });
  });

  it("still needs a rule or exam mode", async () => {
    mockAnthropic();
    expect((await post("/judge", judge("x", "y", { exam: null }))).status).toBe(400);
  });

  it("tells the model to be generous to coursework and strict on entertainment", () => {
    expect(judgePrompt).toContain("For a stats exam, econometrics, regression, probability and hypothesis-testing videos are all yes.");
    expect(judgePrompt).toContain("Be strict on entertainment");
  });
});

describe("the exam as a rule with id \"exam\" (the extension's form)", () => {
  const judge = (extra: Record<string, unknown> = {}) => ({
    installId: crypto.randomUUID(), site: "youtube.com", title: "Econometrics Lecture 5: Multiple Regression", channel: "MIT OpenCourseWare",
    rules: [{ id: "exam", about: "stats exam", except: "" }], ...extra,
  });

  it("answers an on-topic video as rule 'exam', and an off-topic one as none", async () => {
    const calls = mockAnthropic({ answer: { rule: "none", forExam: true } });
    expect(await (await post("/judge", judge())).json()).toEqual({ rule: "exam", judged: true, forExam: true });
    const user: string = calls[0]!.body.messages[0].content;
    expect(user).toContain('exam mode: on, for "stats exam"');
    expect(user).toContain("rules: none"); // the exam rule is not one of the student's video rules
    mockAnthropic({ answer: { rule: "none", forExam: false } });
    expect(await (await post("/judge", judge({ title: "Top 10 penalty kicks of 2026", channel: "Sky Sports" }))).json()).toEqual({ rule: null, judged: true, forExam: false });
  });

  it("keeps the student's own video rules beside it", async () => {
    mockAnthropic({ answer: { rule: "v1", forExam: false } });
    const rules = [{ id: "exam", about: "stats exam", except: "" }, { id: "v1", about: "sports highlights", except: "" }];
    expect(await (await post("/judge", judge({ rules, title: "Top 10 penalty kicks" }))).json()).toEqual({ rule: "v1", judged: true, forExam: false });
  });
});

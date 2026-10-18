import { afterEach, describe, expect, it, vi } from "vitest";
import { gateBody, mockAnthropic, post } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const NOW = "2026-10-17T14:05:00-04:00";
const EXAM = { until: "2026-10-21T08:30:00-04:00", goal: "Midterm 15.425" };

const rulesBody = (overrides: Record<string, unknown> = {}) => ({
  installId: crypto.randomUUID(),
  message: "lequipe should be blocked when in exam mode",
  today: "2026-10-17",
  now: NOW,
  exam: null,
  history: [],
  rules: { kinds: { video: 20 }, sites: {}, videos: [], dayStart: 4 },
  ...overrides,
});

async function rulesDiff(answerDiff: unknown[], overrides: Record<string, unknown> = {}) {
  mockAnthropic({ answer: { reply: "Here is the change.", question: null, diff: answerDiff } });
  const res = await post("/rules", rulesBody(overrides));
  expect(res.status).toBe(200);
  return ((await res.json()) as { diff: unknown[] }).diff;
}

describe("/rules knows exam mode", () => {
  it("tells Claude the local time and whether exam mode is on", async () => {
    const calls = mockAnthropic({ answer: { reply: "OK.", question: null, diff: [] } });
    await post("/rules", rulesBody({ exam: EXAM }));
    const user: string = calls[0]!.body.messages[0].content;
    expect(user.startsWith(`now: ${NOW}\n`)).toBe(true);
    expect(user).toContain(`- exam mode: on until ${EXAM.until}, for "Midterm 15.425"`);

    const off = mockAnthropic({ answer: { reply: "OK.", question: null, diff: [] } });
    await post("/rules", rulesBody());
    expect(off[0]!.body.messages[0].content).toContain("- exam mode: off");
  });

  it("offers examStart, examEnd and only the five limitable kinds in its schema", async () => {
    const calls = mockAnthropic({ answer: { reply: "OK.", question: null, diff: [] } });
    await post("/rules", rulesBody());
    const items = calls[0]!.body.output_config.format.schema.properties.diff.items.anyOf as any[];
    const ops = items.map((i) => i.properties.op.const);
    expect(ops).toContain("examStart");
    expect(ops).toContain("examEnd");
    const budget = items.find((i) => i.properties.op.const === "budget");
    expect(budget.properties.kind.enum).toEqual(["social", "video", "games", "news", "shopping"]);
  });

  it("passes the lequipe card through: lequipe.fr counts as news", async () => {
    const answer = {
      reply: "Exam mode closes news along with every other kind. On normal days news stays free.",
      question: null,
      diff: [{ op: "site", domain: "lequipe.fr", kind: "news" }],
    };
    mockAnthropic({ answer });
    const res = await post("/rules", rulesBody());
    expect(await res.json()).toEqual(answer);
  });

  it("drops changes to work, study or other", async () => {
    const diff = await rulesDiff([
      { op: "site", domain: "claude.ai", kind: "study" },
      { op: "budget", kind: "work", minutes: 30 },
      { op: "unwatch", kind: "other" },
      { op: "budget", kind: "games", minutes: 0 },
    ]);
    expect(diff).toEqual([{ op: "budget", kind: "games", minutes: 0 }]);
  });

  it("keeps an exam start that makes sense and drops one that does not", async () => {
    const start = { op: "examStart", until: "2026-10-21T08:30:00-04:00", goal: "Midterm 15.425" };
    expect(await rulesDiff([start])).toEqual([start]);
    expect(await rulesDiff([{ ...start, until: "2026-10-16T08:30:00-04:00" }])).toEqual([]); // in the past
    expect(await rulesDiff([{ ...start, until: "2026-12-21T08:30:00-04:00" }])).toEqual([]); // more than 30 days
    expect(await rulesDiff([{ ...start, until: "Wednesday 8:30" }])).toEqual([]); // not a time
    expect(await rulesDiff([{ ...start, until: "2026-10-21T08:30:00" }])).toEqual([]); // no offset
  });

  it("extends exam mode but never shortens it through examStart", async () => {
    const later = { op: "examStart", until: "2026-10-21T12:00:00-04:00", goal: "Midterm 15.425" };
    expect(await rulesDiff([later], { exam: EXAM })).toEqual([later]);
    const earlier = { ...later, until: "2026-10-20T12:00:00-04:00" };
    expect(await rulesDiff([earlier], { exam: EXAM })).toEqual([]);
  });

  it("allows examEnd only while exam mode is on, and one exam change per card", async () => {
    expect(await rulesDiff([{ op: "examEnd" }])).toEqual([]);
    expect(await rulesDiff([{ op: "examEnd" }], { exam: EXAM })).toEqual([{ op: "examEnd" }]);
    const start = { op: "examStart", until: "2026-10-22T08:30:00-04:00", goal: "" };
    expect(await rulesDiff([{ op: "examEnd" }, start], { exam: EXAM })).toEqual([{ op: "examEnd" }]);
  });

  it("rejects a malformed now or exam, and accepts requests without them", async () => {
    const calls = mockAnthropic({ answer: { reply: "OK.", question: null, diff: [] } });
    expect(await (await post("/rules", rulesBody({ now: "2pm" }))).json()).toEqual({ error: "invalid_now" });
    expect(await (await post("/rules", rulesBody({ exam: { until: "tomorrow" } }))).json()).toEqual({ error: "invalid_exam" });
    expect(await (await post("/rules", rulesBody({ exam: "on" }))).json()).toEqual({ error: "invalid_exam" });
    expect(calls).toHaveLength(0);
    const old = rulesBody({ unknownField: true });
    delete (old as Record<string, unknown>).now;
    delete (old as Record<string, unknown>).exam;
    expect((await post("/rules", old)).status).toBe(200);
    expect(calls[0]!.body.messages[0].content.startsWith("today: 2026-10-17\n")).toBe(true);
  });
});

describe("/gate in exam mode", () => {
  it("caps a pass at 5 minutes and tells Claude the exam", async () => {
    const calls = mockAnthropic({ answer: { decision: "allow", minutes: 10, reply: "Three minutes to look up ROCE." } });
    const res = await post("/gate", gateBody({ site: "investopedia.com", kind: "other", message: "what is ROCE", now: NOW, exam: EXAM }));
    expect(await res.json()).toEqual({ decision: "allow", minutes: 5, reply: "Three minutes to look up ROCE." });
    const user: string = calls[0]!.body.messages[0].content;
    expect(user).toContain(`now: ${NOW}`);
    expect(user).toContain(`exam mode: on until ${EXAM.until}, for "Midterm 15.425"`);
  });

  it("follows MAX_EXAM_PASS_MINUTES, never above MAX_PASS_MINUTES, and leaves normal days alone", async () => {
    mockAnthropic({ answer: { decision: "allow", minutes: 10, reply: "OK." } });
    expect(await (await post("/gate", gateBody({ exam: EXAM }), { env: { MAX_EXAM_PASS_MINUTES: "2" } })).json()).toMatchObject({ minutes: 2 });
    expect(await (await post("/gate", gateBody({ exam: EXAM }), { env: { MAX_PASS_MINUTES: "3", MAX_EXAM_PASS_MINUTES: "8" } })).json()).toMatchObject({ minutes: 3 });
    const normal = mockAnthropic({ answer: { decision: "allow", minutes: 10, reply: "OK." } });
    expect(await (await post("/gate", gateBody())).json()).toMatchObject({ minutes: 10 });
    expect(normal[0]!.body.messages[0].content).toContain("exam mode: off");
  });

  it("passes calendar deadlines through", async () => {
    const calls = mockAnthropic();
    await post("/gate", gateBody({ deadlines: [{ title: "Midterm 15.425", due: "2026-10-21 08:30" }] }));
    expect(calls[0]!.body.messages[0].content).toContain("- Midterm 15.425 (due 2026-10-21 08:30)");
  });
});

describe("/loosen ending exam mode", () => {
  const loosenBody = (overrides: Record<string, unknown> = {}) => ({
    installId: crypto.randomUUID(),
    kind: "exam",
    goal: "Midterm 15.425",
    changes: ["End exam mode early"],
    message: "I just took the midterm, it's over",
    now: NOW,
    exam: EXAM,
    ...overrides,
  });

  it("ends exam mode now when the agent says the exam is over", async () => {
    const calls = mockAnthropic({ answer: { decision: "allow", when: "now", reply: "Exam mode ends now." } });
    expect(await (await post("/loosen", loosenBody())).json()).toEqual({ decision: "allow", when: "now", reply: "Exam mode ends now." });
    const user: string = calls[0]!.body.messages[0].content;
    expect(user).toContain(`now: ${NOW}`);
    expect(user).toContain(`exam mode: on until ${EXAM.until}`);
    expect(calls[0]!.body.output_config.format.schema.required).toEqual(["decision", "when", "reply"]);
  });

  it("makes every other yes wait for the morning", async () => {
    mockAnthropic({ answer: { decision: "allow", when: "morning", reply: "Exam mode ends tomorrow morning." } });
    expect(await (await post("/loosen", loosenBody({ message: "the exam moved to next month" }))).json()).toMatchObject({ when: "morning" });
    // A rules loosening can never take effect now, whatever the model says.
    mockAnthropic({ answer: { decision: "allow", when: "now", reply: "OK." } });
    expect(await (await post("/loosen", loosenBody({ kind: "rules", changes: ["Video: 20 → 45 min"] }))).json()).toMatchObject({ when: "morning" });
    // A model that leaves `when` out gets the morning.
    mockAnthropic({ answer: { decision: "allow", reply: "OK." } });
    expect(await (await post("/loosen", loosenBody())).json()).toMatchObject({ when: "morning" });
  });

  it("gives deny and ask no timing", async () => {
    mockAnthropic({ answer: { decision: "deny", when: "now", reply: "No. The midterm is Wednesday at 8:30." } });
    expect(await (await post("/loosen", loosenBody({ message: "I need a break" }))).json()).toMatchObject({ decision: "deny", when: null });
    mockAnthropic({ answer: { decision: "ask", when: "morning", reply: "Is the exam over?" } });
    expect(await (await post("/loosen", loosenBody({ message: "done" }))).json()).toMatchObject({ decision: "ask", when: null });
  });
});

import { describe, expect, it } from "vitest";
import { addInterval, cleanSpans, countSpans, emptyDay, length, usageSeconds } from "../src/account/spans";

const T = Date.parse("2026-10-18T01:00:00Z");
const day = () => emptyDay("2026-10-17", T - 12 * 3600e3, T + 12 * 3600e3);
const s = (seq: number, fromS: number, toS: number, buckets: string[]) => ({ seq, from: T + fromS * 1000, to: T + toS * 1000, buckets });

describe("spans: real time, counted once", () => {
  it("joins overlapping and touching intervals", () => {
    let l = addInterval([], [0, 5000]);
    l = addInterval(l, [3000, 8000]);
    l = addInterval(l, [8500, 9000]); // within a second: one interval
    l = addInterval(l, [20000, 21000]);
    expect(l).toEqual([[0, 9000], [20000, 21000]]);
    expect(length(l)).toBe(10000);
    expect(length(l, 8000)).toBe(2000);
  });

  it("counts YouTube in front in two browsers at once only once", () => {
    let d = countSpans(day(), [s(1, 0, 60, ["video"])], 0, T + 3600e3); // Brave
    d = countSpans(d, [s(1, 30, 90, ["video"])], 0, T + 3600e3); // Safari, overlapping by 30 s
    expect(usageSeconds(d).seconds.video).toBe(90);
  });

  it("counts YouTube playing in one browser and Instagram in front in another as both", () => {
    let d = countSpans(day(), [s(1, 0, 60, ["video"])], 0, T + 3600e3);
    d = countSpans(d, [s(1, 0, 60, ["s:instagram.com", "social"])], 0, T + 3600e3);
    const u = usageSeconds(d);
    expect(u.seconds).toEqual({ video: 60, "s:instagram.com": 60, social: 60 });
    expect(u.twice).toBe(60); // the site's minute also counted in social: the week counts it once
  });

  it("changes nothing when a span is sent twice, or late", () => {
    let d = countSpans(day(), [s(1, 0, 30, ["games"]), s(2, 30, 60, ["games"])], 0, T + 3600e3);
    d = countSpans(d, [s(1, 0, 30, ["games"])], 0, T + 3600e3); // resent
    d = countSpans(d, [s(3, 10, 20, ["games"])], 0, T + 3600e3); // an offline span, late and inside
    expect(usageSeconds(d).seconds.games).toBe(60);
  });

  it("reads a device's clock through its offset, and cuts what lies outside the day or ahead of now", () => {
    // The device's clock is 2 hours behind: its "T - 2h" is the account's T.
    const offset = 2 * 3600e3;
    let d = countSpans(day(), [{ seq: 1, from: T - offset, to: T - offset + 30000, buckets: ["news"] }], offset, T + 3600e3);
    expect(usageSeconds(d).seconds.news).toBe(30);
    d = countSpans(d, [s(2, 3500, 3700, ["news"])], 0, T + 3600e3); // 100 s after now: cut
    expect(usageSeconds(d).seconds.news).toBe(130);
    d = countSpans(d, [s(3, -13 * 3600, -12 * 3600 + 10, ["news"])], 0, T + 3600e3); // mostly before the day began
    expect(usageSeconds(d).seconds.news).toBe(140);
  });

  it("adds seconds that came without spans", () => {
    const d = { ...countSpans(day(), [s(1, 0, 10, ["social"])], 0, T + 60e3), extra: { social: 300 } };
    expect(usageSeconds(d).seconds.social).toBe(310);
  });

  it("rejects malformed spans and buckets the engine doesn't have", () => {
    expect(cleanSpans([s(1, 0, 1, ["social"])])).toHaveLength(1);
    expect(cleanSpans(undefined)).toEqual([]);
    expect(cleanSpans([s(1, 0, 1, ["work"])])).toBeNull();
    expect(cleanSpans([s(1, 0, 1, ["https://example.com/page"])])).toBeNull();
    expect(cleanSpans([{ seq: -1, from: 0, to: 1, buckets: [] }])).toBeNull();
    expect(cleanSpans([{ seq: 1, from: "0", to: 1, buckets: [] }])).toBeNull();
    expect(cleanSpans("spans")).toBeNull();
  });
});

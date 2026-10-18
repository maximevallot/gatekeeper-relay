import { describe, expect, it } from "vitest";
import { engine } from "../src/account/engine";
import { validTimeZone, withTimeZone } from "../src/account/tz";

const E = engine as any;
const NY = "America/New_York";

describe("the engine in the account's time zone", () => {
  it("starts the day at 4:00 New York time, not 4:00 UTC", () => {
    const t = Date.parse("2026-10-18T06:30:00Z"); // 2:30 in New York, still yesterday's Gatekeeper day
    expect(withTimeZone(NY, () => E.dayKey(t, 4))).toBe("2026-10-17");
    expect(E.dayKey(t, 4)).toBe("2026-10-18"); // in UTC, without the wrapper
    expect(withTimeZone(NY, () => E.nextDayStart(t, 4))).toBe(Date.parse("2026-10-18T08:00:00Z")); // 4:00 EDT
  });

  it("writes local time with its offset", () => {
    const t = Date.parse("2026-10-17T18:05:00Z");
    expect(withTimeZone(NY, () => E.localIso(t))).toBe("2026-10-17T14:05:00-04:00");
    expect(withTimeZone("Europe/Paris", () => E.localIso(t))).toBe("2026-10-17T20:05:00+02:00");
  });

  it("handles the change from summer time", () => {
    // 1 November 2026: New York goes from -04:00 to -05:00 at 2:00. The next day starts at 4:00 EST.
    const t = Date.parse("2026-11-01T05:00:00Z"); // 1:00 EDT
    expect(withTimeZone(NY, () => E.nextDayStart(t, 4))).toBe(Date.parse("2026-11-01T09:00:00Z"));
  });

  it("puts Date back afterwards, even when the call throws", () => {
    const t = Date.parse("2026-10-17T18:05:00Z");
    expect(() => withTimeZone(NY, () => { throw new Error("x"); })).toThrow("x");
    expect(new Date(t).getUTCHours()).toBe(18);
    expect(new Date(t).getHours()).toBe(18); // the runtime's UTC again
  });

  it("checks time zone names", () => {
    expect(validTimeZone(NY)).toBe(true);
    expect(validTimeZone("Mars/Olympus")).toBe(false);
    expect(validTimeZone(42)).toBe(false);
  });
});

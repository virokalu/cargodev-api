import { describe, expect, it } from "vitest";
import { nextRunAfter, shouldCatchUp, todaysRunTime } from "../src/scheduler/time.js";

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe("nextRunAfter", () => {
  it("is today's run time when it is still ahead", () => {
    expect(iso(nextRunAfter(at("2026-03-10T01:30:00Z"), 2))).toBe("2026-03-10T02:00:00.000Z");
    expect(iso(nextRunAfter(at("2026-03-10T00:00:00Z"), 2))).toBe("2026-03-10T02:00:00.000Z");
  });

  it("rolls to tomorrow once the time has passed", () => {
    expect(iso(nextRunAfter(at("2026-03-10T02:00:01Z"), 2))).toBe("2026-03-11T02:00:00.000Z");
    expect(iso(nextRunAfter(at("2026-03-10T23:59:59.999Z"), 2))).toBe("2026-03-11T02:00:00.000Z");
  });

  it("is strictly after: exactly on the boundary means tomorrow, so a timer firing on time cannot loop", () => {
    expect(iso(nextRunAfter(at("2026-03-10T02:00:00.000Z"), 2))).toBe("2026-03-11T02:00:00.000Z");
  });

  it("one millisecond before the boundary is still today", () => {
    expect(iso(nextRunAfter(at("2026-03-10T01:59:59.999Z"), 2))).toBe("2026-03-10T02:00:00.000Z");
  });

  it("crosses month and year boundaries in UTC", () => {
    expect(iso(nextRunAfter(at("2026-12-31T23:00:00Z"), 2))).toBe("2027-01-01T02:00:00.000Z");
    expect(iso(nextRunAfter(at("2026-01-31T10:00:00Z"), 2))).toBe("2026-02-01T02:00:00.000Z");
    expect(iso(nextRunAfter(at("2026-02-28T10:00:00Z"), 2))).toBe("2026-03-01T02:00:00.000Z");
  });

  it("handles a leap day", () => {
    expect(iso(nextRunAfter(at("2028-02-28T10:00:00Z"), 2))).toBe("2028-02-29T02:00:00.000Z");
    expect(iso(nextRunAfter(at("2028-02-29T10:00:00Z"), 2))).toBe("2028-03-01T02:00:00.000Z");
  });

  it("works for hour 0 and hour 23", () => {
    expect(iso(nextRunAfter(at("2026-03-10T00:00:00.000Z"), 0))).toBe("2026-03-11T00:00:00.000Z");
    expect(iso(nextRunAfter(at("2026-03-10T23:59:59.999Z"), 0))).toBe("2026-03-11T00:00:00.000Z");
    expect(iso(nextRunAfter(at("2026-03-10T22:59:59.999Z"), 23))).toBe("2026-03-10T23:00:00.000Z");
    expect(iso(nextRunAfter(at("2026-03-10T23:00:00.000Z"), 23))).toBe("2026-03-11T23:00:00.000Z");
  });

  it("is always within 24 hours and strictly in the future", () => {
    for (const hour of [0, 2, 12, 23]) {
      for (let minute = 0; minute < 24 * 60; minute += 37) {
        const now = new Date(Date.UTC(2026, 5, 15, 0, minute, 0));
        const next = nextRunAfter(now, hour);
        expect(next.getTime()).toBeGreaterThan(now.getTime());
        expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(24 * 3600_000);
        expect(next.getUTCHours()).toBe(hour);
        expect(next.getUTCMinutes() + next.getUTCSeconds() + next.getUTCMilliseconds()).toBe(0);
      }
    }
  });

  it("does not depend on the machine's time zone", () => {
    // A date whose LOCAL day differs from its UTC day in any non-UTC zone.
    const now = at("2026-03-10T23:30:00Z");
    expect(iso(nextRunAfter(now, 2))).toBe("2026-03-11T02:00:00.000Z");
    expect(iso(todaysRunTime(now, 2))).toBe("2026-03-10T02:00:00.000Z");
  });
});

describe("shouldCatchUp (a missed run is recovered on startup)", () => {
  it("is false before today's run time", () => {
    expect(shouldCatchUp(at("2026-03-10T00:00:00Z"), 2)).toBe(false);
    expect(shouldCatchUp(at("2026-03-10T01:59:59.999Z"), 2)).toBe(false);
  });

  it("is true from the run time onward, for the rest of the UTC day", () => {
    expect(shouldCatchUp(at("2026-03-10T02:00:00.000Z"), 2)).toBe(true);
    expect(shouldCatchUp(at("2026-03-10T14:00:00Z"), 2)).toBe(true);
    expect(shouldCatchUp(at("2026-03-10T23:59:59.999Z"), 2)).toBe(true);
  });

  it("resets at UTC midnight", () => {
    expect(shouldCatchUp(at("2026-03-11T00:00:00.000Z"), 2)).toBe(false);
  });

  it("hour 0 means any time after midnight has already passed", () => {
    expect(shouldCatchUp(at("2026-03-10T00:00:00.000Z"), 0)).toBe(true);
    expect(shouldCatchUp(at("2026-03-10T10:00:00Z"), 0)).toBe(true);
  });
});

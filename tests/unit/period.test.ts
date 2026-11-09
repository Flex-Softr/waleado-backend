import { describe, expect, it } from "vitest";
import { addMonths, bonusPeriodMs, cycleLabel, daysUntil, DAY_MS, round2 } from "../../src/billing/period";

describe("addMonths", () => {
  it("adds calendar months", () => {
    expect(addMonths(new Date("2026-01-15T10:00:00Z"), 1).toISOString()).toBe("2026-02-15T10:00:00.000Z");
    expect(addMonths(new Date("2026-11-15T00:00:00Z"), 3).toISOString()).toBe("2027-02-15T00:00:00.000Z");
  });

  it("clamps to the last day of a shorter month", () => {
    expect(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(addMonths(new Date("2028-01-31T00:00:00Z"), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("does not mutate its input", () => {
    const start = new Date("2026-05-10T00:00:00Z");
    addMonths(start, 12);
    expect(start.toISOString()).toBe("2026-05-10T00:00:00.000Z");
  });
});

describe("daysUntil", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  it("rounds partial days up and never goes negative", () => {
    expect(daysUntil(new Date(now.getTime() + 1.2 * DAY_MS), now)).toBe(2);
    expect(daysUntil(new Date(now.getTime() - DAY_MS), now)).toBe(0);
  });
});

describe("bonusPeriodMs", () => {
  const start = new Date("2026-06-01T00:00:00Z");
  const end = addMonths(start, 1);

  it("is zero when credit does not exceed the price", () => {
    expect(bonusPeriodMs(1000, 999, start, end)).toBe(0);
    expect(bonusPeriodMs(1000, 1000, start, end)).toBe(0);
  });

  it("turns excess credit into time at the plan's rate", () => {
    const span = end.getTime() - start.getTime();
    expect(bonusPeriodMs(1000, 1500, start, end)).toBe(Math.floor(span / 2));
  });

  it("ignores a free price", () => {
    expect(bonusPeriodMs(0, 500, start, end)).toBe(0);
  });
});

describe("labels and rounding", () => {
  it("names billing cycles", () => {
    expect(cycleLabel(0)).toBe("Lifetime");
    expect(cycleLabel(1)).toBe("1 month");
    expect(cycleLabel(6)).toBe("6 months");
    expect(cycleLabel(12)).toBe("1 year");
    expect(cycleLabel(24)).toBe("2 years");
  });

  it("rounds to two decimals", () => {
    expect(round2(10.005)).toBeCloseTo(10.01, 2);
    expect(round2(2490 / 3)).toBe(830);
  });
});

import { describe, expect, it } from "vitest";
import {
  hourInTimezone,
  isValidTimezone,
  isWithinSendWindow,
  randomSendGapMs,
} from "../../src/lib/followup-schedule";

describe("timezone helpers", () => {
  it("validates IANA names", () => {
    expect(isValidTimezone("Asia/Dhaka")).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
  it("converts the hour", () => {
    const t = new Date("2026-11-17T03:30:00Z"); // 09:30 in Dhaka (UTC+6)
    expect(hourInTimezone(t, "Asia/Dhaka")).toBe(9);
    expect(hourInTimezone(t, "UTC")).toBe(3);
    expect(hourInTimezone(new Date("2026-11-17T18:05:00Z"), "Asia/Dhaka")).toBe(0);
    expect(hourInTimezone(t, "bogus")).toBe(3);
  });
});

describe("isWithinSendWindow", () => {
  const at = (iso: string) => new Date(iso);
  it("uses start inclusive / end exclusive", () => {
    expect(isWithinSendWindow(at("2026-11-17T03:00:00Z"), "Asia/Dhaka", 9, 21)).toBe(true);
    expect(isWithinSendWindow(at("2026-11-17T02:59:00Z"), "Asia/Dhaka", 9, 21)).toBe(false);
    expect(isWithinSendWindow(at("2026-11-17T14:59:00Z"), "Asia/Dhaka", 9, 21)).toBe(true);
    expect(isWithinSendWindow(at("2026-11-17T15:00:00Z"), "Asia/Dhaka", 9, 21)).toBe(false);
  });
  it("supports windows that wrap midnight and all-day windows", () => {
    expect(isWithinSendWindow(at("2026-11-17T20:00:00Z"), "UTC", 22, 6)).toBe(false);
    expect(isWithinSendWindow(at("2026-11-17T23:00:00Z"), "UTC", 22, 6)).toBe(true);
    expect(isWithinSendWindow(at("2026-11-17T03:00:00Z"), "UTC", 22, 6)).toBe(true);
    expect(isWithinSendWindow(at("2026-11-17T12:00:00Z"), "UTC", 0, 0)).toBe(true);
  });
});

describe("randomSendGapMs", () => {
  it("stays between 3 and 8 seconds", () => {
    expect(randomSendGapMs(() => 0)).toBe(3000);
    expect(randomSendGapMs(() => 0.999)).toBeLessThan(8000);
  });
});

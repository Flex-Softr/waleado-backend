/** Send-window helpers for automatic follow-ups (pure, unit tested). */

export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Hour of day (0-23) at `now` in the given IANA timezone. */
export function hourInTimezone(now: Date, tz: string): number {
  const zone = isValidTimezone(tz) ? tz : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const h = parts.find((p) => p.type === "hour")?.value;
  const n = h === undefined ? 0 : Number(h);
  return Number.isFinite(n) ? n % 24 : 0;
}

/**
 * True when `now` falls in [startHour, endHour) in the timezone. A window that wraps
 * midnight (start > end) is supported; start === end means "any time".
 */
export function isWithinSendWindow(
  now: Date,
  tz: string,
  startHour: number,
  endHour: number
): boolean {
  if (startHour === endHour) return true;
  const h = hourInTimezone(now, tz);
  return startHour < endHour
    ? h >= startHour && h < endHour
    : h >= startHour || h < endHour;
}

/** Random pause between automatic sends so a burst never looks like a bot. */
export function randomSendGapMs(random: () => number = Math.random): number {
  return 3_000 + Math.floor(random() * 5_000);
}

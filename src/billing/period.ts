import { LIFETIME_MONTHS } from "./catalog.service";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Adds calendar months, clamping to the last day of the target month (Jan 31 + 1 = Feb 28/29). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** Whole days from `now` until `end`, rounded up (0 on the last day). */
export function daysUntil(end: Date, now = new Date()): number {
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
}

export function cycleLabel(months: number): string {
  if (months === LIFETIME_MONTHS) return "Lifetime";
  if (months === 1) return "1 month";
  if (months === 12) return "1 year";
  if (months % 12 === 0) return `${months / 12} years`;
  return `${months} months`;
}

/** Upgrade credit above the price, converted to extra time at the new plan's daily rate. */
export function bonusPeriodMs(price: number, credit: number, start: Date, end: Date): number {
  const excess = credit - price;
  if (excess <= 0 || price <= 0) return 0;
  return Math.floor((excess / price) * (end.getTime() - start.getTime()));
}

export function formatBdt(n: number): string {
  return `৳${Math.round(n).toLocaleString("en-US")}`;
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dhaka" });
}

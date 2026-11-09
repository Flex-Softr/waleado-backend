import { Plan } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { resolvePlan, type WorkspaceBillingState } from "../../src/billing/entitlements.service";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-06-15T00:00:00Z");
const settings = { graceDays: 3, trialTier: Plan.PRO };

function ws(overrides: Partial<WorkspaceBillingState> = {}): WorkspaceBillingState {
  return {
    plan: Plan.FREE,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    billingMonths: null,
    lifetimeTier: null,
    trialEndsAt: null,
    ...overrides,
  };
}

describe("resolvePlan", () => {
  it("gives platform admins Business regardless of the workspace", () => {
    expect(resolvePlan(ws(), settings, true, now)).toMatchObject({ tier: Plan.BUSINESS, source: "admin" });
  });

  it("uses the paid plan while its period runs", () => {
    const end = new Date(now.getTime() + 10 * DAY);
    expect(resolvePlan(ws({ plan: Plan.PRO, currentPeriodEnd: end }), settings, false, now)).toMatchObject({
      tier: Plan.PRO,
      source: "paid",
      periodEnd: end,
    });
  });

  it("keeps the plan during grace, then drops to Free", () => {
    const state = ws({ plan: Plan.PRO, currentPeriodEnd: new Date(now.getTime() - 2 * DAY) });
    expect(resolvePlan(state, settings, false, now).source).toBe("grace");

    const lapsed = ws({ plan: Plan.PRO, currentPeriodEnd: new Date(now.getTime() - 4 * DAY) });
    expect(resolvePlan(lapsed, settings, false, now)).toMatchObject({ tier: Plan.FREE, source: "free" });
  });

  it("falls back to the lifetime tier when a higher timed plan lapses", () => {
    const state = ws({
      plan: Plan.BUSINESS,
      currentPeriodEnd: new Date(now.getTime() - 30 * DAY),
      lifetimeTier: Plan.STARTER,
    });
    expect(resolvePlan(state, settings, false, now)).toMatchObject({ tier: Plan.STARTER, source: "lifetime" });
  });

  it("treats a plan with no end as lifetime when bought as lifetime", () => {
    const state = ws({ plan: Plan.PRO, billingMonths: 0, lifetimeTier: Plan.PRO });
    expect(resolvePlan(state, settings, false, now).source).toBe("lifetime");
  });

  it("uses the trial tier only while the trial runs", () => {
    expect(resolvePlan(ws({ trialEndsAt: new Date(now.getTime() + DAY) }), settings, false, now)).toMatchObject({
      tier: Plan.PRO,
      source: "trial",
    });
    expect(resolvePlan(ws({ trialEndsAt: new Date(now.getTime() - DAY) }), settings, false, now).source).toBe(
      "free"
    );
  });
});

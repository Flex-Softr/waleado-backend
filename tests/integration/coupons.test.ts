import { Plan } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { quotePurchase } from "../../src/billing/checkout/quote.service";
import { createCoupon as createCouponByAdmin, couponInputSchema } from "../../src/billing/admin/coupons.service";
import { prisma, resetDb } from "../helpers/db";
import { buyPlan, createCoupon, createWorkspace, DAY, PRICE } from "../helpers/factories";

beforeEach(resetDb);

describe("coupons at checkout", () => {
  it("discounts the price and is case-insensitive", async () => {
    const ws = await createWorkspace();
    await createCoupon({ code: "FOUNDER20", discountValue: 20 });
    const quote = await quotePurchase(ws.id, Plan.PRO, 1, { couponCode: "founder20" });
    expect(quote.discount).toBeCloseTo(PRICE.PRO_1 * 0.2, 2);
    expect(quote.total).toBeCloseTo(PRICE.PRO_1 * 0.8, 2);
    expect(quote.coupon?.code).toBe("FOUNDER20");
  });

  it("rejects unknown, inactive, expired and not-yet-started coupons", async () => {
    const ws = await createWorkspace();
    await createCoupon({ code: "OFF", isActive: false });
    await createCoupon({ code: "OLD", expiresAt: new Date(Date.now() - DAY) });
    await createCoupon({ code: "SOON", startsAt: new Date(Date.now() + DAY) });

    for (const code of ["NOPE", "OFF", "OLD", "SOON"]) {
      await expect(quotePurchase(ws.id, Plan.PRO, 1, { couponCode: code })).rejects.toMatchObject({
        code: "COUPON_INVALID",
      });
    }
  });

  it("only applies to the plans and cycles it was made for", async () => {
    const ws = await createWorkspace();
    await createCoupon({ code: "PROYEAR", tiers: [Plan.PRO], cycles: [12] });
    await expect(quotePurchase(ws.id, Plan.BUSINESS, 12, { couponCode: "PROYEAR" })).rejects.toMatchObject({
      code: "COUPON_INVALID",
    });
    await expect(quotePurchase(ws.id, Plan.PRO, 1, { couponCode: "PROYEAR" })).rejects.toMatchObject({
      code: "COUPON_INVALID",
    });
    expect((await quotePurchase(ws.id, Plan.PRO, 12, { couponCode: "PROYEAR" })).discount).toBeGreaterThan(0);
  });

  it("enforces the per-workspace and total usage limits", async () => {
    const a = await createWorkspace();
    const b = await createWorkspace();
    await createCoupon({ code: "ONEUSE", maxRedemptions: 1 });

    await buyPlan(a.id, Plan.STARTER, 1, { couponCode: "ONEUSE" });
    await expect(quotePurchase(a.id, Plan.STARTER, 1, { couponCode: "ONEUSE" })).rejects.toMatchObject({
      code: "COUPON_INVALID",
    });
    await expect(quotePurchase(b.id, Plan.STARTER, 1, { couponCode: "ONEUSE" })).rejects.toMatchObject({
      code: "COUPON_INVALID",
    });
    expect(await prisma.couponRedemption.count()).toBe(1);
  });

  it("locks a forever coupon in and applies it to renewals automatically", async () => {
    const ws = await createWorkspace();
    await createCoupon({ code: "LIFE30", discountValue: 30, duration: "FOREVER" });
    await buyPlan(ws.id, Plan.PRO, 1, { couponCode: "LIFE30" });

    const renewal = await quotePurchase(ws.id, Plan.PRO, 1);
    expect(renewal.kind).toBe("renewal");
    expect(renewal.coupon?.code).toBe("LIFE30");
    expect(renewal.discount).toBeCloseTo(PRICE.PRO_1 * 0.3, 2);
  });

  it("is not counted as used until the invoice is paid", async () => {
    const ws = await createWorkspace();
    await createCoupon({ code: "ONCE" });
    await quotePurchase(ws.id, Plan.PRO, 1, { couponCode: "ONCE" });
    await quotePurchase(ws.id, Plan.PRO, 1, { couponCode: "ONCE" });
    expect(await prisma.couponRedemption.count()).toBe(0);
  });
});

describe("admin coupon management", () => {
  const input = (code: string) =>
    couponInputSchema.parse({ code, discountType: "PERCENT", discountValue: 10, duration: "ONCE" });

  it("rejects duplicate codes regardless of case", async () => {
    await createCouponByAdmin(input("launch"));
    await expect(createCouponByAdmin(input("LAUNCH"))).rejects.toMatchObject({ code: "COUPON_EXISTS" });
  });

  it("rejects percentages above 100", () => {
    expect(() =>
      couponInputSchema.parse({ code: "TOOMUCH", discountType: "PERCENT", discountValue: 120, duration: "ONCE" })
    ).toThrow();
  });
});

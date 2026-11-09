import { CouponDiscountType, CouponDuration, Prisma, type Coupon } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { couponDiscount, describeCoupon, normalizeCouponCode } from "../../src/billing/coupons/coupon.service";

function coupon(
  discountType: CouponDiscountType,
  value: number,
  duration: CouponDuration = CouponDuration.ONCE
): Coupon {
  return {
    id: "c1",
    code: "X",
    description: null,
    discountType,
    discountValue: new Prisma.Decimal(value),
    duration,
    tiers: [],
    cycles: [],
    maxRedemptions: null,
    perWorkspaceLimit: 1,
    startsAt: null,
    expiresAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("couponDiscount", () => {
  it("takes a percentage of the price", () => {
    expect(couponDiscount(coupon(CouponDiscountType.PERCENT, 20), 2490)).toBe(498);
  });

  it("never discounts more than the price", () => {
    expect(couponDiscount(coupon(CouponDiscountType.PERCENT, 150), 2490)).toBe(2490);
    expect(couponDiscount(coupon(CouponDiscountType.FIXED, 5000), 2490)).toBe(2490);
  });

  it("applies a fixed amount as-is", () => {
    expect(couponDiscount(coupon(CouponDiscountType.FIXED, 300), 2490)).toBe(300);
  });
});

describe("coupon text", () => {
  it("normalises codes to upper case", () => {
    expect(normalizeCouponCode("  founder50 ")).toBe("FOUNDER50");
  });

  it("describes forever coupons as recurring", () => {
    expect(describeCoupon(coupon(CouponDiscountType.PERCENT, 30, CouponDuration.FOREVER))).toBe(
      "30% off every renewal"
    );
    expect(describeCoupon(coupon(CouponDiscountType.FIXED, 500))).toBe("৳500 off");
  });
});

import {
  CouponDiscountType,
  CouponDuration,
  type Coupon,
  type Plan,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { round2 } from "../period";

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

function invalid(message: string): AppError {
  return new AppError(400, message, "COUPON_INVALID");
}

/** Throws COUPON_INVALID unless the coupon can be used for this plan and cycle right now. */
async function assertCouponUsable(
  coupon: Coupon,
  workspaceId: string,
  tier: Plan,
  months: number,
  options: { lockedIn: boolean },
  now = new Date()
): Promise<void> {
  if (!coupon.isActive) throw invalid("This coupon is no longer active.");
  if (coupon.startsAt && coupon.startsAt > now) throw invalid("This coupon is not active yet.");
  if (coupon.expiresAt && coupon.expiresAt <= now) throw invalid("This coupon has expired.");
  if (coupon.tiers.length && !coupon.tiers.includes(tier)) {
    throw invalid("This coupon does not apply to the selected plan.");
  }
  if (coupon.cycles.length && !coupon.cycles.includes(months)) {
    throw invalid("This coupon does not apply to the selected billing cycle.");
  }
  // A forever coupon already locked in for the workspace keeps working for renewals.
  if (options.lockedIn) return;

  if (coupon.maxRedemptions !== null) {
    const used = await prisma.couponRedemption.count({ where: { couponId: coupon.id } });
    if (used >= coupon.maxRedemptions) throw invalid("This coupon has reached its usage limit.");
  }
  const usedHere = await prisma.couponRedemption.count({
    where: { couponId: coupon.id, workspaceId },
  });
  if (usedHere >= coupon.perWorkspaceLimit) throw invalid("You have already used this coupon.");
}

/**
 * Picks the coupon for a purchase: the code the customer typed, otherwise the
 * forever coupon locked into the workspace (if it still applies). Returns null when none.
 */
export async function resolveCoupon(input: {
  workspaceId: string;
  tier: Plan;
  months: number;
  code?: string | null;
}): Promise<Coupon | null> {
  const code = input.code ? normalizeCouponCode(input.code) : "";
  if (code) {
    const coupon = await prisma.coupon.findUnique({ where: { code } });
    if (!coupon) throw invalid("Coupon code not found.");
    const ws = await prisma.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { recurringCouponId: true },
    });
    await assertCouponUsable(coupon, input.workspaceId, input.tier, input.months, {
      lockedIn: ws?.recurringCouponId === coupon.id,
    });
    return coupon;
  }

  const ws = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { recurringCoupon: true },
  });
  const locked = ws?.recurringCoupon;
  if (!locked) return null;
  try {
    await assertCouponUsable(locked, input.workspaceId, input.tier, input.months, { lockedIn: true });
    return locked;
  } catch {
    // A locked-in coupon that no longer fits this plan is simply not applied.
    return null;
  }
}

export function couponDiscount(coupon: Coupon, price: number): number {
  const value = Number(coupon.discountValue);
  const raw =
    coupon.discountType === CouponDiscountType.PERCENT ? (price * Math.min(100, value)) / 100 : value;
  return round2(Math.min(price, Math.max(0, raw)));
}

export function describeCoupon(coupon: Coupon): string {
  const value = Number(coupon.discountValue);
  const amount = coupon.discountType === CouponDiscountType.PERCENT ? `${value}% off` : `৳${value} off`;
  return coupon.duration === CouponDuration.FOREVER ? `${amount} every renewal` : amount;
}

/** Records that a paid invoice used its coupon; locks forever coupons into the workspace. */
export async function recordCouponRedemption(
  tx: Prisma.TransactionClient,
  invoice: { id: string; workspaceId: string; couponId: string | null; discount: Prisma.Decimal }
): Promise<void> {
  if (!invoice.couponId) return;
  const coupon = await tx.coupon.findUnique({ where: { id: invoice.couponId } });
  if (!coupon) return;
  await tx.couponRedemption.upsert({
    where: { invoiceId: invoice.id },
    create: {
      couponId: coupon.id,
      workspaceId: invoice.workspaceId,
      invoiceId: invoice.id,
      amount: invoice.discount,
    },
    update: {},
  });
  if (coupon.duration === CouponDuration.FOREVER) {
    await tx.workspace.update({
      where: { id: invoice.workspaceId },
      data: { recurringCouponId: coupon.id },
    });
  }
}

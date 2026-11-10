import { randomUUID } from "crypto";
import { CouponDiscountType, CouponDuration, Plan, type Coupon, type Invoice, type Prisma } from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { quotePurchase } from "../../src/billing/checkout/quote.service";
import { applyPaidInvoice, createInvoice } from "../../src/billing/invoices/invoice.service";

export const DAY = 24 * 60 * 60 * 1000;

/** Default list prices after the launch-price migration (BDT). */
export const PRICE = {
  STARTER_1: 149,
  PRO_1: 249,
  PRO_12: 1990,
  PRO_LIFETIME: 3990,
  BUSINESS_1: 349,
} as const;

/** A customer workspace with one owner. Starts on Free with no trial unless overridden. */
export async function createWorkspace(
  overrides: Partial<{
    plan: Plan;
    currentPeriodEnd: Date | null;
    billingMonths: number | null;
    lifetimeTier: Plan | null;
    walletBalance: number;
    autoRenew: boolean;
    trialEndsAt: Date | null;
    ownerRole: "CUSTOMER" | "ADMIN";
  }> = {}
) {
  const id = randomUUID().slice(0, 8);
  const { ownerRole = "CUSTOMER", ...data } = overrides;
  const user = await prisma.user.create({
    data: { email: `owner-${id}@test.local`, name: `Owner ${id}`, role: ownerRole },
  });
  return prisma.workspace.create({
    data: {
      name: `Workspace ${id}`,
      slug: `ws-${id}`,
      ...data,
      memberships: { create: { userId: user.id, role: "OWNER" } },
    },
  });
}

export async function createCoupon(overrides: Partial<Prisma.CouponCreateInput> = {}): Promise<Coupon> {
  return prisma.coupon.create({
    data: {
      code: `TEST${randomUUID().slice(0, 6).toUpperCase()}`,
      discountType: CouponDiscountType.PERCENT,
      discountValue: 10,
      duration: CouponDuration.ONCE,
      ...overrides,
    },
  });
}

/** Quotes, invoices and pays a plan the way checkout does, without a gateway. */
export async function buyPlan(
  workspaceId: string,
  tier: Plan,
  months: number,
  options: { couponCode?: string; useWallet?: boolean } = {}
): Promise<Invoice> {
  const quote = await quotePurchase(workspaceId, tier, months, options);
  const invoice = await createInvoice(workspaceId, quote);
  const { invoice: paid } = await applyPaidInvoice(invoice.id, "test", { notify: false });
  return paid;
}

/** Moves a paid invoice's period (and the workspace's end) back in time, as if `days` had passed. */
export async function ageInvoice(invoice: Invoice, days: number): Promise<void> {
  const shift = (d: Date | null) => (d ? new Date(d.getTime() - days * DAY) : d);
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { periodStart: shift(invoice.periodStart), periodEnd: shift(invoice.periodEnd) },
  });
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: invoice.workspaceId } });
  await prisma.workspace.update({
    where: { id: ws.id },
    data: { currentPeriodEnd: shift(ws.currentPeriodEnd) },
  });
}

export async function walletBalance(workspaceId: string): Promise<number> {
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return Number(ws.walletBalance);
}

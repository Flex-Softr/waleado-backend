import { Plan, type Coupon } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { planToApi, tierRank, type PlanIdApi } from "../../lib/plan-mapping";
import {
  getCatalog,
  LIFETIME_MONTHS,
  type CatalogPlan,
  type CatalogPrice,
} from "../catalog.service";
import { BILLING_WORKSPACE_SELECT, resolvePlan, workspaceHasPlatformAdmin } from "../entitlements.service";
import { couponDiscount, describeCoupon, resolveCoupon } from "../coupons/coupon.service";
import { getWalletBalance } from "../wallet/wallet.service";
import { addMonths, bonusPeriodMs, cycleLabel, DAY_MS, round2 } from "../period";

export const INVOICE_CURRENCY = "BDT";

export type InvoiceKind = "new" | "renewal" | "upgrade" | "topup";

/**
 * Everything needed to create an invoice. Amounts are in BDT:
 * total = subtotal − discount − credit − walletAmount (what the gateway charges).
 */
export type InvoiceDraft = {
  kind: InvoiceKind;
  tier: Plan | null;
  months: number;
  subtotal: number;
  discount: number;
  couponId: string | null;
  credit: number;
  walletAmount: number;
  total: number;
  currency: string;
  description: string;
};

export type PlanQuote = InvoiceDraft & {
  tier: Plan;
  planId: PlanIdApi;
  planName: string;
  isLifetime: boolean;
  coupon: { code: string; description: string } | null;
  /** Card amount in USD for Stripe (null when the price has no USD amount). */
  amountUsd: number | null;
  /** When the purchased period would start and end if paid now (null end = lifetime). */
  periodStart: string;
  periodEnd: string | null;
  /** Extra days granted when upgrade credit exceeds the price. */
  bonusDays: number;
};

function findPlanAndPrice(
  plans: CatalogPlan[],
  tier: Plan,
  months: number
): { plan: CatalogPlan; price: CatalogPrice } {
  const plan = plans.find((p) => p.tier === tier);
  const price = plan?.prices.find((p) => p.months === months);
  if (!plan || !price || !price.isActive) {
    throw new AppError(404, "This plan or billing cycle is not available.", "PRICE_NOT_FOUND");
  }
  if (!price.available) {
    const soldOut = price.remaining === 0;
    throw new AppError(
      409,
      `The ${plan.name} ${cycleLabel(months).toLowerCase()} offer ${soldOut ? "is sold out" : "has ended"}.`,
      soldOut ? "PRICE_SOLD_OUT" : "PRICE_ENDED"
    );
  }
  return { plan, price };
}

/** What a paid invoice was actually worth (list price minus coupon). */
const netValue = (inv: { subtotal: unknown; discount: unknown }) =>
  Number(inv.subtotal) - Number(inv.discount);

/**
 * Unused value of the timed periods still running for a tier.
 * Renewals stack, so every paid invoice that has not fully elapsed contributes its unused share.
 * Periods already converted into credit by an earlier upgrade are skipped.
 */
async function remainingTimedCredit(workspaceId: string, tier: Plan, now: Date): Promise<number> {
  const invoices = await prisma.invoice.findMany({
    where: { workspaceId, status: "paid", tier, months: { gt: 0 }, periodEnd: { gt: now }, supersededAt: null },
    select: { subtotal: true, discount: true, periodStart: true, periodEnd: true },
  });
  let credit = 0;
  for (const inv of invoices) {
    if (!inv.periodStart || !inv.periodEnd) continue;
    const totalMs = inv.periodEnd.getTime() - inv.periodStart.getTime();
    if (totalMs <= 0) continue;
    const unusedMs = inv.periodEnd.getTime() - Math.max(now.getTime(), inv.periodStart.getTime());
    credit += netValue(inv) * Math.min(1, Math.max(0, unusedMs / totalMs));
  }
  return round2(credit);
}

/** What the workspace paid for the lifetime tier it currently owns. */
async function lifetimeCredit(workspaceId: string, tier: Plan): Promise<number> {
  const inv = await prisma.invoice.findFirst({
    where: { workspaceId, status: "paid", tier, months: LIFETIME_MONTHS },
    orderBy: { paidAt: "desc" },
    select: { subtotal: true, discount: true },
  });
  return inv ? netValue(inv) : 0;
}

/**
 * Decides whether the purchase is new, a renewal or an upgrade, and the credit owed from what
 * the workspace already has. Rejects downgrades mid-period and plans a lifetime already covers.
 */
async function classifyPurchase(
  workspaceId: string,
  tier: Plan,
  months: number,
  plans: CatalogPlan[],
  settings: Parameters<typeof resolvePlan>[1],
  now: Date
): Promise<{ kind: Exclude<InvoiceKind, "topup">; credit: number; periodStart: Date }> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: BILLING_WORKSPACE_SELECT,
  });
  if (!ws) throw new AppError(404, "Workspace not found", "NOT_FOUND");

  const resolved = resolvePlan(ws, settings, false, now);
  const lifetime = ws.lifetimeTier && ws.lifetimeTier !== Plan.FREE ? ws.lifetimeTier : null;
  const timedTier =
    (resolved.source === "paid" || resolved.source === "grace") && resolved.periodEnd ? ws.plan : null;
  const nameOf = (t: Plan) => plans.find((p) => p.tier === t)?.name ?? planToApi(t);

  if (lifetime && tierRank(tier) <= tierRank(lifetime)) {
    throw new AppError(
      409,
      months === LIFETIME_MONTHS
        ? `You already own ${nameOf(lifetime)} for life.`
        : `Your lifetime ${nameOf(lifetime)} plan already covers this.`,
      "ALREADY_OWNED"
    );
  }

  if (months === LIFETIME_MONTHS) {
    let credit = 0;
    if (lifetime) credit += await lifetimeCredit(workspaceId, lifetime);
    if (timedTier && tierRank(tier) >= tierRank(timedTier)) {
      credit += await remainingTimedCredit(workspaceId, timedTier, now);
    }
    return { kind: credit > 0 || lifetime ? "upgrade" : "new", credit, periodStart: now };
  }

  if (!timedTier) return { kind: "new", credit: 0, periodStart: now };
  if (tier === timedTier) {
    const runningEnd = resolved.periodEnd && resolved.periodEnd > now ? resolved.periodEnd : now;
    return { kind: "renewal", credit: 0, periodStart: runningEnd };
  }
  if (tierRank(tier) > tierRank(timedTier)) {
    return { kind: "upgrade", credit: await remainingTimedCredit(workspaceId, timedTier, now), periodStart: now };
  }
  const ends = resolved.periodEnd?.toISOString().slice(0, 10);
  throw new AppError(
    409,
    `You can switch to a lower plan after your current plan ends${ends ? ` on ${ends}` : ""}.`,
    "DOWNGRADE_NOT_ALLOWED",
    { periodEnd: resolved.periodEnd?.toISOString() ?? null }
  );
}

function invoiceDescription(planName: string, months: number, kind: InvoiceKind): string {
  const suffix = kind === "renewal" ? " (renewal)" : kind === "upgrade" ? " (upgrade)" : "";
  return `Waleado ${planName} — ${cycleLabel(months)}${suffix}`;
}

/**
 * Prices a plan purchase for a workspace. Order of deductions:
 * list price → coupon → upgrade credit → wallet balance → amount left for the gateway.
 */
export async function quotePurchase(
  workspaceId: string,
  tier: Plan,
  months: number,
  options: { couponCode?: string | null; useWallet?: boolean } = {},
  now = new Date()
): Promise<PlanQuote> {
  if (tier === Plan.FREE) {
    throw new AppError(400, "The Free plan does not need a payment.", "VALIDATION");
  }
  if (await workspaceHasPlatformAdmin(workspaceId)) {
    throw new AppError(400, "Platform admin workspaces already have full access.", "ADMIN_WORKSPACE");
  }
  const catalog = await getCatalog();
  const { plan, price } = findPlanAndPrice(catalog.plans, tier, months);
  const isLifetime = months === LIFETIME_MONTHS;
  const { kind, credit: rawCredit, periodStart } = await classifyPurchase(
    workspaceId,
    tier,
    months,
    catalog.plans,
    catalog.settings,
    now
  );

  const coupon: Coupon | null = await resolveCoupon({ workspaceId, tier, months, code: options.couponCode });
  const subtotal = round2(price.amountBdt);
  const discount = coupon ? couponDiscount(coupon, subtotal) : 0;
  const net = round2(subtotal - discount);

  // Lifetime has no time to extend, so credit is capped at the price. For timed plans, credit
  // beyond the price becomes extra days on the new plan instead of being lost.
  const credit = round2(isLifetime ? Math.min(rawCredit, net) : rawCredit);
  const due = round2(Math.max(0, net - credit));
  const walletAmount = options.useWallet ? round2(Math.min(due, await getWalletBalance(workspaceId))) : 0;
  const total = round2(due - walletAmount);

  const baseEnd = isLifetime ? null : addMonths(periodStart, months);
  const bonusMs = baseEnd ? bonusPeriodMs(net, credit, periodStart, baseEnd) : 0;
  const amountUsd =
    price.amountUsd !== null && subtotal > 0 ? round2((price.amountUsd * total) / subtotal) : null;

  return {
    kind,
    tier,
    months,
    planId: planToApi(tier),
    planName: plan.name,
    isLifetime,
    subtotal,
    discount,
    couponId: coupon?.id ?? null,
    coupon: coupon ? { code: coupon.code, description: describeCoupon(coupon) } : null,
    credit,
    walletAmount,
    total,
    currency: INVOICE_CURRENCY,
    amountUsd,
    description: invoiceDescription(plan.name, months, kind),
    periodStart: periodStart.toISOString(),
    periodEnd: baseEnd ? new Date(baseEnd.getTime() + bonusMs).toISOString() : null,
    bonusDays: Math.floor(bonusMs / DAY_MS),
  };
}

/** Prices adding money to the wallet; bounds come from billing settings. */
export async function quoteTopup(amount: number): Promise<InvoiceDraft> {
  const { settings } = await getCatalog();
  const min = Number(settings.walletMinTopup);
  const max = Number(settings.walletMaxTopup);
  const value = round2(amount);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new AppError(400, `Top-up amount must be between ৳${min} and ৳${max}.`, "TOPUP_AMOUNT_INVALID", {
      min,
      max,
    });
  }
  return {
    kind: "topup",
    tier: null,
    months: 0,
    subtotal: value,
    discount: 0,
    couponId: null,
    credit: 0,
    walletAmount: 0,
    total: value,
    currency: INVOICE_CURRENCY,
    description: "Waleado wallet top-up",
  };
}

import { Plan } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { planToApi } from "../../lib/plan-mapping";
import { LIFETIME_MONTHS } from "../catalog.service";
import { DAY_MS, round2 } from "../period";

const TIERS: Plan[] = [Plan.FREE, Plan.STARTER, Plan.PRO, Plan.BUSINESS];

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/**
 * Billing numbers for the admin dashboard.
 * - cash: money actually collected through gateways and manual payments (top-ups included)
 * - MRR: each workspace on a running timed plan, its latest invoice's net price per month
 */
export async function getBillingReport(now = new Date()) {
  const yearAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const [paid, byPlan, lifetimeOwners, running, wallet, newWorkspaces, coupons] = await Promise.all([
    prisma.invoice.findMany({
      where: { status: "paid", paidAt: { gte: yearAgo } },
      select: { paidAt: true, total: true, kind: true, months: true, subtotal: true, discount: true },
    }),
    prisma.workspace.groupBy({ by: ["plan"], _count: { _all: true } }),
    prisma.workspace.groupBy({
      by: ["lifetimeTier"],
      where: { lifetimeTier: { not: null } },
      _count: { _all: true },
    }),
    // Workspaces on a running timed plan, with the latest paid invoice for that plan.
    prisma.workspace.findMany({
      where: { plan: { not: Plan.FREE }, billingMonths: { gt: 0 }, currentPeriodEnd: { gt: now } },
      select: {
        plan: true,
        invoices: {
          where: { status: "paid", months: { gt: 0 }, kind: { not: "topup" } },
          orderBy: { paidAt: "desc" },
          take: 1,
          select: { tier: true, subtotal: true, discount: true, months: true },
        },
      },
    }),
    prisma.workspace.aggregate({ _sum: { walletBalance: true } }),
    prisma.workspace.findMany({
      where: { createdAt: { gte: new Date(now.getTime() - 90 * DAY_MS) } },
      select: { id: true, invoices: { where: { status: "paid", kind: { not: "topup" } }, select: { id: true }, take: 1 } },
    }),
    prisma.couponRedemption.aggregate({ _count: { _all: true }, _sum: { amount: true } }),
  ]);

  const months: Record<string, { cash: number; invoices: number }> = {};
  for (let i = 0; i < 12; i++) {
    months[monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1)))] = { cash: 0, invoices: 0 };
  }
  let lifetimeSales = 0;
  let lifetimeRevenue = 0;
  for (const inv of paid) {
    const bucket = months[monthKey(inv.paidAt as Date)];
    if (bucket) {
      bucket.cash += Number(inv.total);
      bucket.invoices += 1;
    }
    if (inv.kind !== "topup" && inv.months === LIFETIME_MONTHS) {
      lifetimeSales += 1;
      lifetimeRevenue += Number(inv.subtotal) - Number(inv.discount);
    }
  }

  const mrr = running.reduce((sum, ws) => {
    const inv = ws.invoices[0];
    if (!inv || inv.tier !== ws.plan) return sum;
    return sum + (Number(inv.subtotal) - Number(inv.discount)) / inv.months;
  }, 0);
  const converted = newWorkspaces.filter((w) => w.invoices.length > 0).length;
  const thisMonth = months[monthKey(now)] ?? { cash: 0, invoices: 0 };

  return {
    revenueByMonth: Object.entries(months).map(([month, v]) => ({ month, cash: round2(v.cash), invoices: v.invoices })),
    cashThisMonth: round2(thisMonth.cash),
    paidInvoicesThisMonth: thisMonth.invoices,
    mrr: round2(mrr),
    activePaidPeriods: running.length,
    workspacesByPlan: Object.fromEntries(TIERS.map((t) => [planToApi(t), byPlan.find((r) => r.plan === t)?._count._all ?? 0])),
    lifetimeOwnersByPlan: Object.fromEntries(
      TIERS.map((t) => [planToApi(t), lifetimeOwners.find((r) => r.lifetimeTier === t)?._count._all ?? 0])
    ),
    lifetimeSales,
    lifetimeRevenue: round2(lifetimeRevenue),
    walletBalanceTotal: round2(Number(wallet._sum.walletBalance ?? 0)),
    conversion90d: {
      signups: newWorkspaces.length,
      paid: converted,
      rate: newWorkspaces.length ? round2((converted / newWorkspaces.length) * 100) : 0,
    },
    coupons: { redemptions: coupons._count._all, totalDiscount: round2(Number(coupons._sum.amount ?? 0)) },
  };
}

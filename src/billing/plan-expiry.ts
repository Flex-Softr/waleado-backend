import { Plan } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getCatalog, LIFETIME_MONTHS } from "./catalog.service";
import { invalidateEntitlements } from "./entitlements.service";
import { DAY_MS } from "./period";

/**
 * Ends lapsed timed plans once their grace period is over. Workspaces that own a lifetime
 * tier fall back to it; others drop to Free. Stripe-managed subscriptions are left to webhooks.
 */
export async function expireLapsedPlans(now = new Date()): Promise<number> {
  const { settings } = await getCatalog();
  const cutoff = new Date(now.getTime() - Math.max(0, settings.graceDays) * DAY_MS);
  const rows = await prisma.workspace.findMany({
    where: { plan: { not: Plan.FREE }, currentPeriodEnd: { lt: cutoff }, stripeSubscriptionId: null },
    select: { id: true, lifetimeTier: true },
  });
  for (const row of rows) {
    const fallback = row.lifetimeTier && row.lifetimeTier !== Plan.FREE ? row.lifetimeTier : null;
    await prisma.workspace.updateMany({
      where: { id: row.id, currentPeriodEnd: { lt: cutoff } },
      data: fallback
        ? { plan: fallback, currentPeriodEnd: null, billingMonths: LIFETIME_MONTHS, subscriptionStatus: "active" }
        : {
            plan: Plan.FREE,
            currentPeriodEnd: null,
            billingMonths: null,
            subscriptionStatus: "expired",
            lastPaymentGateway: null,
          },
    });
    invalidateEntitlements(row.id);
  }
  return rows.length;
}

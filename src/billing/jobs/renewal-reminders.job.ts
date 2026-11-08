import { Plan, type Invoice } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { getCatalog, getCatalogPlan } from "../catalog.service";
import { quotePurchase } from "../checkout/quote.service";
import { createInvoice } from "../invoices/invoice.service";
import { payLinkUrl } from "../invoices/pay-link";
import { daysUntil, DAY_MS, formatBdt, formatDate } from "../period";
import { billingLink, dispatchSystemMessage } from "../../system-messages/dispatcher.service";

/** Timed, prepaid plans (not lifetime, not Stripe-managed) that end within the window or are in grace. */
async function findRenewableWorkspaces(windowDays: number, graceDays: number, now: Date) {
  return prisma.workspace.findMany({
    where: {
      plan: { not: Plan.FREE },
      billingMonths: { gt: 0 },
      stripeSubscriptionId: null,
      autoRenew: false,
      currentPeriodEnd: {
        lte: new Date(now.getTime() + windowDays * DAY_MS),
        gt: new Date(now.getTime() - graceDays * DAY_MS),
      },
      // Workspaces of platform admins never pay.
      memberships: { none: { user: { role: "ADMIN" } } },
    },
    select: { id: true, plan: true, billingMonths: true, currentPeriodEnd: true },
  });
}

/** Re-uses the open renewal invoice, or creates one (without touching the wallet). */
async function ensureRenewalInvoice(ws: { id: string; plan: Plan; billingMonths: number | null }): Promise<Invoice | null> {
  const open = await prisma.invoice.findFirst({
    where: { workspaceId: ws.id, status: "unpaid", tier: ws.plan },
    orderBy: { createdAt: "desc" },
  });
  if (open) return open;
  try {
    const quote = await quotePurchase(ws.id, ws.plan, ws.billingMonths ?? 1, { useWallet: false });
    return await createInvoice(ws.id, quote);
  } catch (err) {
    // E.g. the admin stopped selling this cycle: reminders still go out with the billing link.
    console.warn(`[renewal] no renewal invoice for ${ws.id}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Prepares the renewal invoice ahead of time, sends reminders with its pay link on the
 * configured days, then a notice once the plan has ended. Each message is sent once per period.
 * Workspaces with auto-renew on are handled by the auto-renew job instead.
 */
export async function runRenewalReminders(now = new Date()): Promise<void> {
  const { settings } = await getCatalog();
  const windowDays = Math.max(settings.renewalInvoiceDays, ...settings.reminderDays, 0);
  const workspaces = await findRenewableWorkspaces(windowDays, settings.graceDays, now);

  for (const ws of workspaces) {
    const end = ws.currentPeriodEnd as Date;
    const endKey = end.toISOString();
    const planName = (await getCatalogPlan(ws.plan))?.name ?? ws.plan;

    if (end <= now) {
      const invoice = await ensureRenewalInvoice(ws);
      await dispatchSystemMessage({
        key: "plan_expired",
        workspaceId: ws.id,
        dedupeKey: `plan_expired:${ws.id}:${endKey}`,
        vars: {
          plan: planName,
          date: formatDate(new Date(end.getTime() + settings.graceDays * DAY_MS)),
          pay_link: invoice ? payLinkUrl(invoice.id) : billingLink(),
        },
      });
      continue;
    }

    const daysLeft = daysUntil(end, now);
    const isReminderDay = settings.reminderDays.includes(daysLeft);
    if (!isReminderDay && daysLeft > settings.renewalInvoiceDays) continue;

    // The invoice is prepared quietly; reminders carry its pay link.
    const invoice = await ensureRenewalInvoice(ws);
    if (!isReminderDay) continue;
    await dispatchSystemMessage({
      key: "renewal_reminder",
      workspaceId: ws.id,
      dedupeKey: `renewal_reminder:${ws.id}:${endKey}:${daysLeft}`,
      vars: {
        plan: planName,
        days: daysLeft,
        date: formatDate(end),
        amount: invoice ? formatBdt(Number(invoice.total)) : "see your billing page",
        invoice: invoice?.number ?? "—",
        pay_link: invoice ? payLinkUrl(invoice.id) : billingLink(),
      },
    });
  }
}

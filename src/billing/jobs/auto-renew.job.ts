import { Plan } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { getCatalogPlan } from "../catalog.service";
import { quotePurchase } from "../checkout/quote.service";
import { applyPaidInvoice, createInvoice } from "../invoices/invoice.service";
import { getWalletBalance } from "../wallet/wallet.service";
import { DAY_MS, formatBdt, formatDate } from "../period";
import { dispatchSystemMessage } from "../../system-messages/dispatcher.service";

/** How long before the end we try to renew, so a short balance can still be topped up. */
const RENEW_AHEAD_MS = DAY_MS;

/**
 * Renews plans from the wallet for workspaces that turned on auto-renew. When the balance is
 * not enough, the owner is told once per period (the renewal can still be paid normally).
 */
export async function runAutoRenew(now = new Date()): Promise<void> {
  const due = await prisma.workspace.findMany({
    where: {
      autoRenew: true,
      plan: { not: Plan.FREE },
      billingMonths: { gt: 0 },
      stripeSubscriptionId: null,
      currentPeriodEnd: { lte: new Date(now.getTime() + RENEW_AHEAD_MS) },
    },
    select: { id: true, plan: true, billingMonths: true, currentPeriodEnd: true },
  });

  for (const ws of due) {
    const endKey = (ws.currentPeriodEnd as Date).toISOString();
    const planName = (await getCatalogPlan(ws.plan))?.name ?? ws.plan;
    try {
      const quote = await quotePurchase(ws.id, ws.plan, ws.billingMonths ?? 1, { useWallet: true });
      if (quote.total > 0) {
        await dispatchSystemMessage({
          key: "auto_renew_failed",
          workspaceId: ws.id,
          dedupeKey: `auto_renew_failed:${ws.id}:${endKey}`,
          vars: {
            plan: planName,
            amount: formatBdt(quote.walletAmount + quote.total),
            balance: formatBdt(await getWalletBalance(ws.id)),
          },
        });
        continue;
      }
      const invoice = await createInvoice(ws.id, quote, { gateway: "wallet", note: "Auto-renewed from wallet" });
      const { invoice: paid } = await applyPaidInvoice(invoice.id, "wallet", { notify: false });
      await dispatchSystemMessage({
        key: "auto_renew_success",
        workspaceId: ws.id,
        dedupeKey: `auto_renew_success:${ws.id}:${endKey}`,
        vars: {
          plan: planName,
          amount: formatBdt(quote.walletAmount),
          date: paid.periodEnd ? formatDate(paid.periodEnd) : "—",
          balance: formatBdt(await getWalletBalance(ws.id)),
        },
      });
    } catch (err) {
      console.error(`[auto-renew] workspace ${ws.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

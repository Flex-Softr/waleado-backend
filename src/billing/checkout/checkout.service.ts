import type { Invoice } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { apiPlanToDb, planToApi, type PaidPlanIdApi } from "../../lib/plan-mapping";
import { initiatePaidCheckout } from "../../payments/checkout.facade";
import type { PaymentGatewayId } from "../../payments/types";
import { applyPaidInvoice, cancelInvoice, createInvoice, serializeInvoice } from "../invoices/invoice.service";
import { quotePurchase, quoteTopup } from "./quote.service";

export type Payer = { email: string; name: string | null; phone: string | null };

export type CheckoutResult =
  | { activated: true; invoice: ReturnType<typeof serializeInvoice> }
  | { url: string; gateway: PaymentGatewayId; invoice: ReturnType<typeof serializeInvoice> };

/** SSLCommerz requires a phone; fall back to a placeholder rather than failing checkout. */
function payerPhone(gateway: PaymentGatewayId, payer: Payer): string {
  return payer.phone?.trim() || (gateway === "sslcommerz" ? "01700000000" : "0000000000");
}

/**
 * Sends an unpaid invoice to a payment gateway. Invoices with nothing left to pay
 * (covered by wallet or credit) are activated immediately.
 */
export async function payInvoice(
  invoice: Invoice,
  gateway: PaymentGatewayId,
  payer: Payer,
  returnTo: "billing" | "pay-link" = "billing"
): Promise<CheckoutResult> {
  if (invoice.status !== "unpaid") {
    throw new AppError(409, `This invoice is ${invoice.status}.`, "INVALID_STATUS");
  }
  const total = Number(invoice.total);
  if (total <= 0) {
    const gatewayLabel = Number(invoice.walletAmount) > 0 ? "wallet" : "credit";
    const { invoice: paid } = await applyPaidInvoice(invoice.id, gatewayLabel);
    return { activated: true, invoice: serializeInvoice(paid) };
  }

  const result = await initiatePaidCheckout(gateway, {
    workspaceId: invoice.workspaceId,
    userEmail: payer.email,
    userName: payer.name,
    customerPhone: payerPhone(gateway, payer),
    invoiceId: invoice.id,
    planId: invoice.tier ? planToApi(invoice.tier) : "free",
    amount: total,
    currency: invoice.currency,
    amountUsd: await invoiceAmountUsd(invoice),
    description: invoice.description,
    returnTo,
  });
  if (result.kind === "activated") {
    const fresh = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    return { activated: true, invoice: serializeInvoice(fresh) };
  }
  return { url: result.url, gateway, invoice: serializeInvoice(invoice) };
}

/** Creates the invoice and sends it to the gateway; if the gateway can't start, the invoice is
 * cancelled so any reserved wallet money goes straight back. */
async function createAndPay(
  workspaceId: string,
  draft: Parameters<typeof createInvoice>[1],
  gateway: PaymentGatewayId,
  payer: Payer
): Promise<CheckoutResult> {
  const invoice = await createInvoice(workspaceId, draft, { gateway });
  try {
    return await payInvoice(invoice, gateway, payer);
  } catch (err) {
    await cancelInvoice(invoice.id).catch(() => undefined);
    throw err;
  }
}

/** What the invoice's amount due costs by card in USD (Stripe), pro-rated from the plan's USD price.
 * Null when the plan has no USD price (e.g. top-ups), meaning Stripe can't be used. */
export async function invoiceAmountUsd(invoice: Invoice): Promise<number | null> {
  const subtotal = Number(invoice.subtotal);
  if (!invoice.tier || subtotal <= 0) return null;
  const price = await prisma.planPrice.findUnique({
    where: { tier_months: { tier: invoice.tier, months: invoice.months } },
    select: { amountUsd: true },
  });
  if (!price?.amountUsd) return null;
  return Math.round(((Number(price.amountUsd) * Number(invoice.total)) / subtotal) * 100) / 100;
}

export async function startPlanCheckout(
  workspaceId: string,
  payer: Payer,
  input: {
    planId: PaidPlanIdApi;
    months: number;
    couponCode?: string | null;
    useWallet: boolean;
    gateway: PaymentGatewayId;
  }
): Promise<CheckoutResult> {
  const quote = await quotePurchase(workspaceId, apiPlanToDb(input.planId), input.months, {
    couponCode: input.couponCode,
    useWallet: input.useWallet,
  });
  return createAndPay(workspaceId, quote, input.gateway, payer);
}

export async function startWalletTopup(
  workspaceId: string,
  payer: Payer,
  input: { amount: number; gateway: PaymentGatewayId }
): Promise<CheckoutResult> {
  return createAndPay(workspaceId, await quoteTopup(input.amount), input.gateway, payer);
}

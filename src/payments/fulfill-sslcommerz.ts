import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { apiPlanToDb, planToApi, type PlanIdApi } from "../lib/plan-mapping";
import { applyPaidInvoice, INVOICE_CURRENCY } from "../billing/invoices.service";
import { getEntitlements } from "../billing/entitlements.service";
import * as sslApi from "./sslcommerz/sslcommerz-api";

const PAID_STATUSES = new Set(["VALID", "VALIDATED"]);

function amountsRoughlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.02;
}

/**
 * Transactions created before invoices existed have no invoice: create a matching
 * one-month invoice so the payment is applied through the same path.
 */
async function ensureInvoiceForLegacyTransaction(row: {
  id: string;
  workspaceId: string;
  planId: string;
  amount: unknown;
  currency: string;
  invoiceId: string | null;
}): Promise<string> {
  if (row.invoiceId) return row.invoiceId;
  const tier = apiPlanToDb(row.planId as PlanIdApi);
  const amount = Number(row.amount);
  const seq = await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('invoice_number_seq') AS n`;
  const number = `WLD-${new Date().getUTCFullYear()}-${String(Number(seq[0]?.n)).padStart(6, "0")}`;
  const invoice = await prisma.invoice.create({
    data: {
      number,
      workspaceId: row.workspaceId,
      tier,
      months: 1,
      kind: "new",
      subtotal: amount,
      credit: 0,
      total: amount,
      currency: row.currency || INVOICE_CURRENCY,
      gateway: "sslcommerz",
      description: `Waleado ${row.planId} — 1 month`,
    },
  });
  await prisma.paymentTransaction.update({ where: { id: row.id }, data: { invoiceId: invoice.id } });
  return invoice.id;
}

/**
 * Confirms payment with the SSLCommerz validation API, then applies the invoice.
 * Idempotent: a transaction already marked paid is not applied twice.
 */
export async function fulfillSslCommerzByValId(input: {
  tranId: string;
  valId: string;
}): Promise<{ planId: PlanIdApi }> {
  const row = await prisma.paymentTransaction.findUnique({
    where: { tranId: input.tranId },
  });
  if (!row || row.gateway !== "sslcommerz") {
    throw new AppError(404, "Unknown transaction", "TRANSACTION_NOT_FOUND");
  }
  if (row.status === "paid") {
    const ent = await getEntitlements(row.workspaceId);
    return { planId: ent.planId };
  }

  const validated = await sslApi.validateTransaction(input.valId);
  const st = (validated.status ?? "").toUpperCase();
  if (!PAID_STATUSES.has(st)) {
    throw new AppError(400, "Payment not validated by SSLCommerz", "PAYMENT_INVALID");
  }
  if (!validated.tran_id || validated.tran_id !== input.tranId) {
    throw new AppError(400, "Transaction mismatch", "TRANSACTION_MISMATCH");
  }

  const expectedAmount = Number(row.amount);
  const gotAmount = Number(validated.amount ?? validated.currency_amount);
  if (!Number.isFinite(gotAmount) || !amountsRoughlyEqual(gotAmount, expectedAmount)) {
    throw new AppError(400, "Amount mismatch", "AMOUNT_MISMATCH");
  }

  const expectedCurrency = row.currency.trim().toUpperCase();
  const gotCurrency = (validated.currency_type ?? "").trim().toUpperCase();
  if (gotCurrency && gotCurrency !== expectedCurrency) {
    throw new AppError(400, "Currency mismatch", "CURRENCY_MISMATCH");
  }

  // Apply first (idempotent per invoice), then record the transaction as paid,
  // so a failure in between can be retried by the IPN or the admin "verify" action.
  const invoiceId = await ensureInvoiceForLegacyTransaction(row);
  await applyPaidInvoice(invoiceId, "sslcommerz");
  await prisma.paymentTransaction.updateMany({
    where: { id: row.id, status: { not: "paid" } },
    data: { status: "paid", valId: input.valId },
  });

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { tier: true } });
  return { planId: invoice ? planToApi(invoice.tier) : "free" };
}

export async function markTransactionFailed(tranId: string): Promise<void> {
  await prisma.paymentTransaction.updateMany({
    where: { tranId, status: "pending" },
    data: { status: "failed" },
  });
}

export async function markTransactionCancelled(tranId: string): Promise<void> {
  await prisma.paymentTransaction.updateMany({
    where: { tranId, status: "pending" },
    data: { status: "cancelled" },
  });
}

import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { env } from "../env";
import { apiPaidPlanToDb, planToApi, type PlanIdApi } from "../lib/plan-mapping";
import * as sslApi from "./sslcommerz/sslcommerz-api";

const PAID_STATUSES = new Set(["VALID", "VALIDATED"]);

function amountsRoughlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.02;
}

/**
 * Confirms payment with SSLCommerz validation API and upgrades the workspace plan.
 * Idempotent: if the transaction row is already `paid`, returns without error.
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
    const ws = await prisma.workspace.findUnique({
      where: { id: row.workspaceId },
      select: { plan: true },
    });
    return { planId: ws ? planToApi(ws.plan) : "free" };
  }

  const validated = await sslApi.validateTransaction(input.valId);
  const st = (validated.status ?? "").toUpperCase();
  if (!PAID_STATUSES.has(st)) {
    throw new AppError(400, "Payment not validated by SSLCommerz", "PAYMENT_INVALID");
  }
  if (validated.tran_id && validated.tran_id !== input.tranId) {
    throw new AppError(400, "Transaction mismatch", "TRANSACTION_MISMATCH");
  }

  const expectedAmount = Number(row.amount);
  const gotAmount = Number(validated.amount ?? validated.currency_amount);
  if (!Number.isFinite(gotAmount) || !amountsRoughlyEqual(gotAmount, expectedAmount)) {
    throw new AppError(400, "Amount mismatch", "AMOUNT_MISMATCH");
  }

  const plan = apiPaidPlanToDb(row.planId as Exclude<PlanIdApi, "free">);
  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + 30);

  await prisma.$transaction([
    prisma.workspace.update({
      where: { id: row.workspaceId },
      data: {
        plan,
        lastPaymentGateway: "sslcommerz",
        subscriptionStatus: "active",
        currentPeriodEnd: periodEnd,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      },
    }),
    prisma.paymentTransaction.update({
      where: { id: row.id },
      data: {
        status: "paid",
        valId: input.valId,
      },
    }),
  ]);

  return { planId: row.planId as PlanIdApi };
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

export function planAmount(plan: Exclude<PlanIdApi, "free">): { amount: string; currency: string } {
  const currency = env.SSLCOMMERZ_CURRENCY.trim().toUpperCase();
  const raw =
    plan === "pro" ? env.SSLCOMMERZ_PRO_AMOUNT : env.SSLCOMMERZ_BUSINESS_AMOUNT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.5) {
    throw new AppError(
      500,
      "Invalid SSLCOMMERZ plan amount in environment",
      "SSLCOMMERZ_CONFIG"
    );
  }
  return { amount: n.toFixed(2), currency };
}

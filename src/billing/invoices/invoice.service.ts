import { Plan, Prisma, type Invoice } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { planToApi, tierRank } from "../../lib/plan-mapping";
import { invalidateCatalogCache, LIFETIME_MONTHS } from "../catalog.service";
import { BILLING_WORKSPACE_SELECT, invalidateEntitlements } from "../entitlements.service";
import { recordCouponRedemption } from "../coupons/coupon.service";
import { changeWalletBalance } from "../wallet/wallet.service";
import type { InvoiceDraft } from "../checkout/quote.service";
import { addMonths, bonusPeriodMs, cycleLabel } from "../period";
import { notifyInvoicePaid } from "./invoice-notifications";
import { createPayToken } from "./pay-link";

type Tx = Prisma.TransactionClient;

async function nextInvoiceNumber(): Promise<string> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('invoice_number_seq') AS n`;
  const n = Number(rows[0]?.n ?? Date.now());
  return `WLD-${new Date().getUTCFullYear()}-${String(n).padStart(6, "0")}`;
}

/** Cancels an unpaid invoice and returns any wallet money it had reserved. */
async function cancelInvoiceTx(tx: Tx, invoice: Invoice): Promise<void> {
  const changed = await tx.invoice.updateMany({
    where: { id: invoice.id, status: "unpaid" },
    data: { status: "cancelled" },
  });
  if (changed.count === 1 && Number(invoice.walletAmount) > 0) {
    await changeWalletBalance(tx, {
      workspaceId: invoice.workspaceId,
      amount: Number(invoice.walletAmount),
      type: "invoice_refund",
      invoiceId: invoice.id,
      note: `Invoice ${invoice.number} cancelled`,
    });
  }
}

export async function cancelInvoice(invoiceId: string): Promise<Invoice> {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new AppError(404, "Invoice not found", "NOT_FOUND");
    if (invoice.status !== "unpaid") {
      throw new AppError(409, `Only unpaid invoices can be cancelled (this one is ${invoice.status}).`, "INVALID_STATUS");
    }
    await cancelInvoiceTx(tx, invoice);
    return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  });
}

/**
 * Creates an unpaid invoice from a draft. Older unpaid invoices of the same sort (plan or
 * top-up) are cancelled, refunding their reserved wallet money; this invoice's wallet share
 * is reserved now.
 */
export async function createInvoice(
  workspaceId: string,
  draft: InvoiceDraft,
  options: { gateway?: string | null; note?: string | null } = {}
): Promise<Invoice> {
  const number = await nextInvoiceNumber();
  return prisma.$transaction(async (tx) => {
    const open = await tx.invoice.findMany({
      where: { workspaceId, status: "unpaid", kind: draft.kind === "topup" ? "topup" : { not: "topup" } },
    });
    for (const inv of open) await cancelInvoiceTx(tx, inv);

    const invoice = await tx.invoice.create({
      data: {
        number,
        workspaceId,
        tier: draft.tier,
        months: draft.months,
        kind: draft.kind,
        subtotal: draft.subtotal,
        discount: draft.discount,
        couponId: draft.couponId,
        credit: draft.credit,
        walletAmount: draft.walletAmount,
        total: draft.total,
        currency: draft.currency,
        gateway: options.gateway ?? null,
        description: draft.description,
        note: options.note ?? null,
      },
    });
    if (draft.walletAmount > 0) {
      await changeWalletBalance(tx, {
        workspaceId,
        amount: -draft.walletAmount,
        type: "invoice_payment",
        invoiceId: invoice.id,
        note: invoice.description,
      });
    }
    return invoice;
  });
}

/** The old plan's running periods end here: their unused value was (or would be) credited to the new plan. */
async function supersedeRunningPeriods(tx: Tx, workspaceId: string, tier: Plan, now: Date): Promise<void> {
  await tx.invoice.updateMany({
    where: { workspaceId, status: "paid", tier, months: { gt: 0 }, periodEnd: { gt: now }, supersededAt: null },
    data: { supersededAt: now },
  });
}

/** Moves the workspace onto the plan an invoice paid for and returns the period it covers. */
async function applyPlanInvoice(
  tx: Tx,
  invoice: Invoice,
  gateway: string | null,
  now: Date
): Promise<{ periodStart: Date; periodEnd: Date | null }> {
  const tier = invoice.tier as Plan;
  const ws = await tx.workspace.findUniqueOrThrow({
    where: { id: invoice.workspaceId },
    select: BILLING_WORKSPACE_SELECT,
  });
  const data: Prisma.WorkspaceUpdateInput = {
    subscriptionStatus: "active",
    lastPaymentGateway: gateway ?? invoice.gateway ?? null,
  };
  // Moving to another tier (or to lifetime) ends the timed periods of the current tier.
  const replacesTimedPlan = ws.plan !== tier || invoice.months === LIFETIME_MONTHS;

  if (invoice.months === LIFETIME_MONTHS) {
    data.lifetimeTier = tier;
    const higherTimedPlanRunning =
      ws.plan !== Plan.FREE &&
      tierRank(ws.plan) > tierRank(tier) &&
      ws.currentPeriodEnd !== null &&
      ws.currentPeriodEnd > now;
    if (!higherTimedPlanRunning) {
      data.plan = tier;
      data.currentPeriodEnd = null;
      data.billingMonths = LIFETIME_MONTHS;
      if (replacesTimedPlan) await supersedeRunningPeriods(tx, invoice.workspaceId, ws.plan, now);
    }
    await tx.workspace.update({ where: { id: invoice.workspaceId }, data });
    return { periodStart: now, periodEnd: null };
  }

  // Same plan still running: the new period starts when the current one ends (no days lost).
  const sameTierRunning = ws.plan === tier && ws.currentPeriodEnd !== null && ws.currentPeriodEnd > now;
  const periodStart = sameTierRunning ? (ws.currentPeriodEnd as Date) : now;
  const baseEnd = addMonths(periodStart, invoice.months);
  const net = Number(invoice.subtotal) - Number(invoice.discount);
  const periodEnd = new Date(baseEnd.getTime() + bonusPeriodMs(net, Number(invoice.credit), periodStart, baseEnd));

  if (replacesTimedPlan) await supersedeRunningPeriods(tx, invoice.workspaceId, ws.plan, now);
  data.plan = tier;
  data.currentPeriodEnd = periodEnd;
  data.billingMonths = invoice.months;
  await tx.workspace.update({ where: { id: invoice.workspaceId }, data });
  return { periodStart, periodEnd };
}

/**
 * Marks an invoice paid (once) and applies it: top-ups credit the wallet, plan invoices move
 * the workspace onto the plan. Safe to call repeatedly; only the first call changes anything.
 */
export async function applyPaidInvoice(
  invoiceId: string,
  gateway: string | null,
  options: { paymentRef?: string | null; note?: string | null; notify?: boolean } = {}
): Promise<{ applied: boolean; invoice: Invoice }> {
  const now = new Date();
  const result = await prisma.$transaction(
    async (tx) => {
      const before = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!before) throw new AppError(404, "Invoice not found", "NOT_FOUND");
      // A payment can complete after the invoice was cancelled (customer paid an old tab).
      const claimed = await tx.invoice.updateMany({
        where: { id: invoiceId, status: { in: ["unpaid", "cancelled"] } },
        data: {
          status: "paid",
          paidAt: now,
          ...(gateway ? { gateway } : {}),
          ...(options.paymentRef ? { paymentRef: options.paymentRef } : {}),
          ...(options.note ? { note: options.note } : {}),
        },
      });
      if (claimed.count === 0) return { applied: false, invoice: before };

      // Cancelling refunded the reserved wallet share; take it again now that it is paid.
      if (before.status === "cancelled" && Number(before.walletAmount) > 0) {
        await changeWalletBalance(tx, {
          workspaceId: before.workspaceId,
          amount: -Number(before.walletAmount),
          type: "invoice_payment",
          invoiceId: before.id,
          note: before.description,
          allowNegative: true,
        });
      }

      let period: { periodStart: Date | null; periodEnd: Date | null } = { periodStart: null, periodEnd: null };
      if (before.kind === "topup") {
        await changeWalletBalance(tx, {
          workspaceId: before.workspaceId,
          amount: Number(before.subtotal),
          type: "topup",
          invoiceId: before.id,
          note: `Top-up via ${gateway ?? before.gateway ?? "payment"}`,
        });
      } else {
        period = await applyPlanInvoice(tx, before, gateway, now);
        await recordCouponRedemption(tx, before);
      }

      const invoice = await tx.invoice.update({ where: { id: before.id }, data: period });
      return { applied: true, invoice };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  if (result.applied) {
    invalidateEntitlements(result.invoice.workspaceId);
    invalidateCatalogCache();
    if (options.notify !== false) void notifyInvoicePaid(result.invoice);
  }
  return result;
}

export function serializeInvoice(inv: Invoice) {
  return {
    id: inv.id,
    number: inv.number,
    planId: inv.tier ? planToApi(inv.tier) : null,
    months: inv.months,
    isLifetime: inv.kind !== "topup" && inv.months === LIFETIME_MONTHS,
    cycle: inv.kind === "topup" ? "Wallet" : cycleLabel(inv.months),
    kind: inv.kind,
    subtotal: Number(inv.subtotal),
    discount: Number(inv.discount),
    credit: Number(inv.credit),
    walletAmount: Number(inv.walletAmount),
    total: Number(inv.total),
    currency: inv.currency,
    status: inv.status,
    gateway: inv.gateway,
    paymentRef: inv.paymentRef,
    description: inv.description,
    periodStart: inv.periodStart?.toISOString() ?? null,
    periodEnd: inv.periodEnd?.toISOString() ?? null,
    paidAt: inv.paidAt?.toISOString() ?? null,
    createdAt: inv.createdAt.toISOString(),
    payToken: inv.status === "unpaid" ? createPayToken(inv.id) : null,
  };
}

export async function listWorkspaceInvoices(workspaceId: string) {
  const rows = await prisma.invoice.findMany({
    where: { workspaceId, status: { not: "cancelled" } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map(serializeInvoice);
}

const INVOICE_DETAIL_INCLUDE = {
  coupon: { select: { code: true } },
  workspace: {
    select: {
      name: true,
      memberships: {
        where: { role: "OWNER" as const },
        take: 1,
        select: { user: { select: { name: true, email: true, phone: true } } },
      },
    },
  },
} satisfies Prisma.InvoiceInclude;

type InvoiceWithDetail = Prisma.InvoiceGetPayload<{ include: typeof INVOICE_DETAIL_INCLUDE }>;

function serializeInvoiceDetail(inv: InvoiceWithDetail) {
  const owner = inv.workspace.memberships[0]?.user ?? null;
  return {
    ...serializeInvoice(inv),
    couponCode: inv.coupon?.code ?? null,
    billedTo: {
      workspace: inv.workspace.name,
      name: owner?.name ?? null,
      email: owner?.email ?? null,
      phone: owner?.phone ?? null,
    },
  };
}

export async function getWorkspaceInvoice(workspaceId: string, invoiceId: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, workspaceId },
    include: INVOICE_DETAIL_INCLUDE,
  });
  if (!inv) throw new AppError(404, "Invoice not found", "NOT_FOUND");
  return serializeInvoiceDetail(inv);
}

/** Invoice by id with its owner, for the public pay page. */
export async function getInvoiceDetailById(invoiceId: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: INVOICE_DETAIL_INCLUDE });
  return inv ? serializeInvoiceDetail(inv) : null;
}

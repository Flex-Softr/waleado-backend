import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { apiPlanToDb, type PaidPlanIdApi } from "../../lib/plan-mapping";
import { getCatalogPlan, LIFETIME_MONTHS } from "../catalog.service";
import { INVOICE_CURRENCY, quoteTopup } from "../checkout/quote.service";
import { applyPaidInvoice, cancelInvoice, createInvoice, serializeInvoice } from "../invoices/invoice.service";
import { cycleLabel, round2 } from "../period";
import { logBillingAction } from "../audit";

export async function listAdminInvoices(input: {
  page: number;
  pageSize: number;
  status?: string;
  kind?: string;
  q?: string;
}) {
  const where: Prisma.InvoiceWhereInput = {};
  if (input.status) where.status = input.status;
  if (input.kind) where.kind = input.kind;
  const q = input.q?.trim();
  if (q) {
    where.OR = [
      { number: { contains: q, mode: "insensitive" } },
      { paymentRef: { contains: q, mode: "insensitive" } },
      { workspace: { name: { contains: q, mode: "insensitive" } } },
      { workspace: { memberships: { some: { user: { email: { contains: q, mode: "insensitive" } } } } } },
    ];
  }
  const [total, rows] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: {
        coupon: { select: { code: true } },
        workspace: {
          select: {
            id: true,
            name: true,
            memberships: {
              where: { role: "OWNER" },
              take: 1,
              select: { user: { select: { email: true, name: true } } },
            },
          },
        },
      },
    }),
  ]);
  return {
    page: input.page,
    pageSize: input.pageSize,
    total,
    invoices: rows.map((r) => ({
      ...serializeInvoice(r),
      couponCode: r.coupon?.code ?? null,
      note: r.note,
      workspace: { id: r.workspace.id, name: r.workspace.name },
      owner: r.workspace.memberships[0]?.user ?? null,
    })),
  };
}

/** Confirms an invoice paid outside the gateways (e.g. bKash send-money), with its reference. */
export async function markInvoicePaidManually(input: {
  invoiceId: string;
  paymentRef: string;
  note?: string | null;
  actorUserId: string;
}) {
  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) throw new AppError(404, "Invoice not found", "NOT_FOUND");
  if (invoice.status === "paid") throw new AppError(409, "Invoice is already paid", "ALREADY_PAID");

  const { invoice: paid } = await applyPaidInvoice(invoice.id, "manual", {
    paymentRef: input.paymentRef,
    note: input.note,
  });
  await logBillingAction({
    action: "invoice.mark_paid",
    actorUserId: input.actorUserId,
    workspaceId: invoice.workspaceId,
    detail: { invoiceId: invoice.id, number: invoice.number, paymentRef: input.paymentRef, note: input.note },
  });
  return serializeInvoice(paid);
}

export async function cancelInvoiceByAdmin(invoiceId: string, actorUserId: string) {
  const invoice = await cancelInvoice(invoiceId);
  await logBillingAction({
    action: "invoice.cancel",
    actorUserId,
    workspaceId: invoice.workspaceId,
    detail: { invoiceId, number: invoice.number },
  });
  return serializeInvoice(invoice);
}

/**
 * Admin-made invoice with a custom amount: a plan period or a wallet top-up.
 * Optionally marked paid immediately (e.g. cash or bKash received).
 */
export async function createManualInvoice(input: {
  workspaceId: string;
  kind: "plan" | "topup";
  planId?: PaidPlanIdApi;
  months?: number;
  amount: number;
  note?: string | null;
  markPaid?: { paymentRef: string } | null;
  actorUserId: string;
}) {
  const ws = await prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { id: true } });
  if (!ws) throw new AppError(404, "Workspace not found", "NOT_FOUND");
  const amount = round2(input.amount);

  let draft;
  if (input.kind === "topup") {
    draft = { ...(await quoteTopup(amount)), description: "Waleado wallet top-up (manual)" };
  } else {
    if (!input.planId || input.months === undefined) {
      throw new AppError(400, "Plan and billing cycle are required", "VALIDATION");
    }
    const tier = apiPlanToDb(input.planId);
    const planName = (await getCatalogPlan(tier))?.name ?? input.planId;
    draft = {
      kind: "new" as const,
      tier,
      months: input.months,
      subtotal: amount,
      discount: 0,
      couponId: null,
      credit: 0,
      walletAmount: 0,
      total: amount,
      currency: INVOICE_CURRENCY,
      description: `Waleado ${planName} — ${cycleLabel(input.months ?? LIFETIME_MONTHS)}`,
    };
  }

  let invoice = await createInvoice(ws.id, draft, { note: input.note ?? null });
  if (input.markPaid) {
    ({ invoice } = await applyPaidInvoice(invoice.id, "manual", { paymentRef: input.markPaid.paymentRef }));
  }
  await logBillingAction({
    action: "invoice.create_manual",
    actorUserId: input.actorUserId,
    workspaceId: ws.id,
    detail: { invoiceId: invoice.id, number: invoice.number, kind: input.kind, amount, paid: Boolean(input.markPaid) },
  });
  return serializeInvoice(invoice);
}

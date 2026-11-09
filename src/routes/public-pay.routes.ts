import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { asyncHandler } from "../lib/async-handler";
import { verifyPayToken } from "../billing/invoices/pay-link";
import { getInvoiceDetailById } from "../billing/invoices/invoice.service";
import { invoiceAmountUsd, payInvoice } from "../billing/checkout/checkout.service";
import { listPaymentGateways } from "../payments/gateway-catalog";

/**
 * Login-free invoice payment (links sent in reminders). Mounted under /v1/public/pay.
 * The signed token is the only credential, so responses expose just what the payer needs.
 */
const router = Router();

function invoiceIdFrom(token: string): string {
  const id = verifyPayToken(token);
  if (!id) throw new AppError(404, "This payment link is not valid.", "NOT_FOUND");
  return id;
}

router.get("/:token", asyncHandler(async (req, res) => {
  const invoiceId = invoiceIdFrom(req.params.token);
  const [invoice, row] = await Promise.all([
    getInvoiceDetailById(invoiceId),
    prisma.invoice.findUnique({ where: { id: invoiceId } }),
  ]);
  if (!invoice || !row) throw new AppError(404, "This payment link is not valid.", "NOT_FOUND");
  res.json({
    invoice: {
      number: invoice.number,
      description: invoice.description,
      status: invoice.status,
      subtotal: invoice.subtotal,
      discount: invoice.discount,
      credit: invoice.credit,
      walletAmount: invoice.walletAmount,
      total: invoice.total,
      amountUsd: invoice.status === "unpaid" ? await invoiceAmountUsd(row) : null,
      currency: invoice.currency,
      couponCode: invoice.couponCode,
      createdAt: invoice.createdAt,
      paidAt: invoice.paidAt,
      workspace: invoice.billedTo.workspace,
    },
    gateways: listPaymentGateways().filter((g) => g.configured),
  });
}));

router.post("/:token/checkout", asyncHandler(async (req, res) => {
  const invoiceId = invoiceIdFrom(req.params.token);
  const { gateway } = z.object({ gateway: z.enum(["stripe", "sslcommerz"]).default("sslcommerz") }).parse(req.body ?? {});
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      workspace: {
        select: {
          memberships: {
            where: { role: "OWNER" },
            take: 1,
            select: { user: { select: { email: true, name: true, phone: true, verifiedPhone: true } } },
          },
        },
      },
    },
  });
  const owner = invoice?.workspace.memberships[0]?.user;
  if (!invoice || !owner) throw new AppError(404, "This payment link is not valid.", "NOT_FOUND");
  const result = await payInvoice(invoice, gateway, {
    email: owner.email,
    name: owner.name,
    phone: owner.verifiedPhone ?? owner.phone,
  }, "pay-link");
  // The pay page only needs where to go next.
  res.json("url" in result ? { url: result.url } : { activated: true });
}));

export { router as publicPayRouter };

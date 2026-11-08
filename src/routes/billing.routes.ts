import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { initiatePaidCheckout } from "../payments/checkout.facade";
import type { PaymentGatewayId } from "../payments/types";
import * as billing from "../services/billing.service";
import { apiPlanToDb, PAID_PLAN_ID_VALUES } from "../lib/plan-mapping";
import { getPublicPricing } from "../billing/catalog.service";
import {
  createInvoiceFromQuote,
  getWorkspaceInvoice,
  listWorkspaceInvoices,
  quotePurchase,
  serializeInvoice,
} from "../billing/invoices.service";

const router = Router();
router.use(requireAuth);

const purchaseBody = z.object({
  planId: z.enum(PAID_PLAN_ID_VALUES),
  /** Billing cycle in months; 0 = lifetime. */
  months: z.coerce.number().int().min(0).max(60).default(1),
});

const checkoutBody = purchaseBody.extend({
  gateway: z.enum(["stripe", "sslcommerz"]).default("sslcommerz"),
  customerPhone: z.string().max(32).optional(),
});

function serializeQuote(q: Awaited<ReturnType<typeof quotePurchase>>) {
  const { price: _price, tier: _tier, ...rest } = q;
  return rest;
}

function asyncHandler(
  fn: (req: AuthedRequest, res: import("express").Response) => Promise<void>
) {
  return (
    req: AuthedRequest,
    res: import("express").Response,
    next: import("express").NextFunction
  ) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const data = await billing.getBillingForWorkspace(auth.wid, auth.sub);
    res.json(data);
  })
);

router.get(
  "/pricing",
  asyncHandler(async (_req, res) => {
    res.json(await getPublicPricing());
  })
);

router.post(
  "/quote",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = purchaseBody.parse(req.body);
    const quote = await quotePurchase(auth.wid, apiPlanToDb(body.planId), body.months);
    res.json(serializeQuote(quote));
  })
);

router.post(
  "/checkout",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = checkoutBody.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: auth.sub },
      select: { email: true, name: true, phone: true },
    });
    if (!user) {
      throw new AppError(404, "User not found", "NOT_FOUND");
    }
    const gateway = body.gateway as PaymentGatewayId;
    const quote = await quotePurchase(auth.wid, apiPlanToDb(body.planId), body.months);
    const invoice = await createInvoiceFromQuote(auth.wid, quote, gateway);
    const customerPhone =
      body.customerPhone?.trim() ||
      user.phone ||
      (gateway === "sslcommerz" ? "01700000000" : "0000000000");
    const result = await initiatePaidCheckout(gateway, {
      workspaceId: auth.wid,
      userEmail: user.email,
      userName: user.name,
      customerPhone,
      invoiceId: invoice.id,
      planId: body.planId,
      amount: quote.total,
      currency: quote.currency,
      amountUsd: quote.amountUsd,
      description: quote.description,
    });
    if (result.kind === "activated") {
      res.json({ activated: true, invoice: serializeInvoice(invoice) });
      return;
    }
    res.json({ url: result.url, gateway, invoice: serializeInvoice(invoice) });
  })
);

router.get(
  "/invoices",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    res.json({ invoices: await listWorkspaceInvoices(auth.wid) });
  })
);

router.get(
  "/invoices/:id",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    res.json({ invoice: await getWorkspaceInvoice(auth.wid, id) });
  })
);

router.get(
  "/confirm",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
    if (!sessionId) {
      throw new AppError(400, "session_id required", "VALIDATION");
    }
    const out = await billing.confirmCheckoutSession({
      workspaceId: auth.wid,
      sessionId,
    });
    res.json(out);
  })
);

router.post(
  "/reset-to-free",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    await billing.resetWorkspaceToFree(auth.wid);
    res.status(204).send();
  })
);

router.post(
  "/stripe-portal",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const out = await billing.createStripeCustomerPortalSession(auth.wid);
    res.json(out);
  })
);

export { router as billingRouter };

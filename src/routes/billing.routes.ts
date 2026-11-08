import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { asyncHandler } from "../lib/async-handler";
import { apiPlanToDb, PAID_PLAN_ID_VALUES } from "../lib/plan-mapping";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as billing from "../services/billing.service";
import { getCatalog, getPublicPricing } from "../billing/catalog.service";
import { quotePurchase } from "../billing/checkout/quote.service";
import { startPlanCheckout, startWalletTopup, type Payer } from "../billing/checkout/checkout.service";
import { getWorkspaceInvoice, listWorkspaceInvoices } from "../billing/invoices/invoice.service";
import { getWalletBalance, listWalletTransactions, setAutoRenew } from "../billing/wallet/wallet.service";

const router = Router();
router.use(requireAuth);

const gatewaySchema = z.enum(["stripe", "sslcommerz"]).default("sslcommerz");

const purchaseBody = z.object({
  planId: z.enum(PAID_PLAN_ID_VALUES),
  /** Billing cycle in months; 0 = lifetime. */
  months: z.coerce.number().int().min(0).max(60).default(1),
  couponCode: z.string().trim().max(32).nullable().optional(),
  useWallet: z.boolean().default(true),
});

function auth(req: AuthedRequest) {
  if (!req.auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  return req.auth;
}

async function payerFor(userId: string, phoneOverride?: string): Promise<Payer> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, phone: true, verifiedPhone: true },
  });
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  return { email: user.email, name: user.name, phone: phoneOverride || user.verifiedPhone || user.phone };
}

router.get("/", asyncHandler<AuthedRequest>(async (req, res) => {
  const { wid, sub } = auth(req);
  res.json(await billing.getBillingForWorkspace(wid, sub));
}));

router.get("/pricing", asyncHandler(async (_req, res) => {
  res.json(await getPublicPricing());
}));

router.post("/quote", asyncHandler<AuthedRequest>(async (req, res) => {
  const { wid } = auth(req);
  const body = purchaseBody.parse(req.body);
  const { tier: _tier, couponId: _couponId, ...quote } = await quotePurchase(wid, apiPlanToDb(body.planId), body.months, {
    couponCode: body.couponCode,
    useWallet: body.useWallet,
  });
  res.json(quote);
}));

router.post("/checkout", asyncHandler<AuthedRequest>(async (req, res) => {
  const { wid, sub } = auth(req);
  const body = purchaseBody.extend({ gateway: gatewaySchema, customerPhone: z.string().max(32).optional() }).parse(req.body);
  res.json(await startPlanCheckout(wid, await payerFor(sub, body.customerPhone), body));
}));

router.get("/invoices", asyncHandler<AuthedRequest>(async (req, res) => {
  res.json({ invoices: await listWorkspaceInvoices(auth(req).wid) });
}));

router.get("/invoices/:id", asyncHandler<AuthedRequest>(async (req, res) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  res.json({ invoice: await getWorkspaceInvoice(auth(req).wid, id) });
}));

// Wallet
router.get("/wallet", asyncHandler<AuthedRequest>(async (req, res) => {
  const { wid } = auth(req);
  const [{ settings }, balance, transactions, ws] = await Promise.all([
    getCatalog(),
    getWalletBalance(wid),
    listWalletTransactions(wid),
    prisma.workspace.findUnique({ where: { id: wid }, select: { autoRenew: true } }),
  ]);
  res.json({
    balance,
    autoRenew: ws?.autoRenew ?? false,
    minTopup: Number(settings.walletMinTopup),
    maxTopup: Number(settings.walletMaxTopup),
    transactions,
  });
}));

router.post("/wallet/topup", asyncHandler<AuthedRequest>(async (req, res) => {
  const { wid, sub } = auth(req);
  const body = z
    .object({ amount: z.coerce.number().positive(), gateway: gatewaySchema, customerPhone: z.string().max(32).optional() })
    .parse(req.body);
  res.json(await startWalletTopup(wid, await payerFor(sub, body.customerPhone), body));
}));

router.put("/wallet/auto-renew", asyncHandler<AuthedRequest>(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  await setAutoRenew(auth(req).wid, enabled);
  res.json({ autoRenew: enabled });
}));

// Stripe return + legacy actions
router.get("/confirm", asyncHandler<AuthedRequest>(async (req, res) => {
  const { session_id: sessionId } = z.object({ session_id: z.string().min(1) }).parse(req.query);
  res.json(await billing.confirmCheckoutSession({ workspaceId: auth(req).wid, sessionId }));
}));

router.post("/reset-to-free", asyncHandler<AuthedRequest>(async (req, res) => {
  await billing.resetWorkspaceToFree(auth(req).wid);
  res.status(204).send();
}));

router.post("/stripe-portal", asyncHandler<AuthedRequest>(async (req, res) => {
  res.json(await billing.createStripeCustomerPortalSession(auth(req).wid));
}));

export { router as billingRouter };

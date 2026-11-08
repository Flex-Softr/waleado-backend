import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { PAID_PLAN_ID_VALUES } from "../../lib/plan-mapping";
import type { AuthedRequest } from "../../middleware/auth";
import {
  adminBillingUpdateSchema,
  getAdminBillingConfig,
  updateAdminBillingConfig,
} from "../../billing/admin/pricing.service";
import {
  cancelInvoiceByAdmin,
  createManualInvoice,
  listAdminInvoices,
  markInvoicePaidManually,
} from "../../billing/admin/invoices.service";
import {
  couponInputSchema,
  createCoupon,
  deleteCoupon,
  listCoupons,
  updateCoupon,
} from "../../billing/admin/coupons.service";
import { getBillingReport } from "../../billing/admin/reports.service";
import {
  adjustWallet,
  extendPaidPeriod,
  getWorkspaceBillingDetail,
} from "../../billing/admin/workspace-actions.service";

/** Mounted under /v1/admin/billing (auth + platform admin already enforced by the parent). */
const router = Router();
const idParam = z.object({ id: z.string().uuid() });
const actor = (req: AuthedRequest) => req.auth?.sub as string;

// Packages, prices, trial / reminder / wallet settings
router.get("/config", asyncHandler(async (_req, res) => {
  res.json(await getAdminBillingConfig());
}));
router.put("/config", asyncHandler(async (req, res) => {
  res.json(await updateAdminBillingConfig(adminBillingUpdateSchema.parse(req.body)));
}));

router.get("/report", asyncHandler(async (_req, res) => {
  res.json(await getBillingReport());
}));

// Invoices
router.get("/invoices", asyncHandler(async (req, res) => {
  const q = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
      status: z.enum(["unpaid", "paid", "cancelled"]).optional(),
      kind: z.enum(["new", "renewal", "upgrade", "topup"]).optional(),
      q: z.string().max(200).optional(),
    })
    .parse(req.query);
  res.json(await listAdminInvoices(q));
}));

router.post("/invoices", asyncHandler<AuthedRequest>(async (req, res) => {
  const body = z
    .object({
      workspaceId: z.string().uuid(),
      kind: z.enum(["plan", "topup"]),
      planId: z.enum(PAID_PLAN_ID_VALUES).optional(),
      months: z.coerce.number().int().min(0).max(60).optional(),
      amount: z.coerce.number().positive().max(10_000_000),
      note: z.string().trim().max(500).nullable().optional(),
      paymentRef: z.string().trim().min(1).max(100).nullable().optional(),
    })
    .parse(req.body);
  const invoice = await createManualInvoice({
    ...body,
    markPaid: body.paymentRef ? { paymentRef: body.paymentRef } : null,
    actorUserId: actor(req),
  });
  res.status(201).json({ invoice });
}));

router.post("/invoices/:id/mark-paid", asyncHandler<AuthedRequest>(async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z
    .object({ paymentRef: z.string().trim().min(1).max(100), note: z.string().trim().max(500).nullable().optional() })
    .parse(req.body);
  res.json({ invoice: await markInvoicePaidManually({ invoiceId: id, ...body, actorUserId: actor(req) }) });
}));

router.post("/invoices/:id/cancel", asyncHandler<AuthedRequest>(async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json({ invoice: await cancelInvoiceByAdmin(id, actor(req)) });
}));

// Coupons
router.get("/coupons", asyncHandler(async (_req, res) => {
  res.json({ coupons: await listCoupons() });
}));
router.post("/coupons", asyncHandler(async (req, res) => {
  await createCoupon(couponInputSchema.parse(req.body));
  res.status(201).json({ coupons: await listCoupons() });
}));
router.put("/coupons/:id", asyncHandler(async (req, res) => {
  const { id } = idParam.parse(req.params);
  await updateCoupon(id, couponInputSchema.parse(req.body));
  res.json({ coupons: await listCoupons() });
}));
router.delete("/coupons/:id", asyncHandler(async (req, res) => {
  const { id } = idParam.parse(req.params);
  const result = await deleteCoupon(id);
  res.json({ ...result, coupons: await listCoupons() });
}));

// Per-workspace actions
router.get("/workspaces/:id", asyncHandler(async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json(await getWorkspaceBillingDetail(id));
}));
router.post("/workspaces/:id/extend", asyncHandler<AuthedRequest>(async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z
    .object({ days: z.coerce.number().int().min(-365).max(3650).refine((d) => d !== 0), reason: z.string().trim().min(3).max(300) })
    .parse(req.body);
  res.json(await extendPaidPeriod({ workspaceId: id, ...body, actorUserId: actor(req) }));
}));
router.post("/workspaces/:id/wallet", asyncHandler<AuthedRequest>(async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z
    .object({ amount: z.coerce.number().min(-10_000_000).max(10_000_000), note: z.string().trim().min(3).max(300) })
    .parse(req.body);
  res.json(await adjustWallet({ workspaceId: id, ...body, actorUserId: actor(req) }));
}));

export { router as adminBillingRouter };

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { initiatePaidCheckout } from "../payments/checkout.facade";
import type { PaymentGatewayId } from "../payments/types";
import * as billing from "../services/billing.service";

const router = Router();
router.use(requireAuth);

const checkoutBody = z.object({
  planId: z.enum(["pro", "business"]),
  gateway: z.enum(["stripe", "sslcommerz"]).default("sslcommerz"),
  customerPhone: z.string().max(32).optional(),
});

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
    const data = await billing.getBillingForWorkspace(auth.wid);
    res.json(data);
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
      select: { email: true, name: true },
    });
    if (!user) {
      throw new AppError(404, "User not found", "NOT_FOUND");
    }
    const gateway = body.gateway as PaymentGatewayId;
    const customerPhone =
      body.customerPhone?.trim() ||
      (gateway === "sslcommerz" ? "01700000000" : "0000000000");
    const result = await initiatePaidCheckout(gateway, {
      workspaceId: auth.wid,
      userEmail: user.email,
      userName: user.name,
      customerPhone,
      planId: body.planId,
    });
    if (result.kind === "demo") {
      res.json({ demo: true, planId: result.planId });
      return;
    }
    res.json({ url: result.url, gateway });
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

export { router as billingRouter };

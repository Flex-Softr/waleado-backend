import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { requirePlatformAdmin } from "../middleware/require-platform-admin";
import * as admin from "../services/admin.service";

const router = Router();
router.use(requireAuth);
router.use(requirePlatformAdmin);

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

const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  q: z.string().max(200).optional(),
});

router.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    const overview = await admin.getAdminOverview();
    res.json(overview);
  })
);

router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const result = await admin.listAdminUsers(query);
    res.json(result);
  })
);

router.post(
  "/users",
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        email: z.string().email().max(320),
        password: z.string().min(10).max(200),
        name: z.string().trim().min(1).max(120).optional(),
        role: z.enum(["ADMIN", "CUSTOMER"]).default("CUSTOMER"),
      })
      .parse(req.body);
    const user = await admin.createAdminUser(body);
    res.status(201).json({ user });
  })
);

router.patch(
  "/users/:id/role",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        role: z.enum(["ADMIN", "CUSTOMER"]),
      })
      .parse(req.body);
    const user = await admin.setUserPlatformRole({
      actorUserId: auth.sub,
      targetUserId: id,
      role: body.role,
    });
    res.json({ user });
  })
);

router.delete(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await admin.deleteAdminUser({
      actorUserId: auth.sub,
      targetUserId: id,
    });
    res.json(result);
  })
);

router.post(
  "/users/:id/block",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const user = await admin.setUserBlocked({
      actorUserId: auth.sub,
      targetUserId: id,
      blocked: true,
    });
    res.json({ user });
  })
);

router.post(
  "/users/:id/unblock",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const user = await admin.setUserBlocked({
      actorUserId: auth.sub,
      targetUserId: id,
      blocked: false,
    });
    res.json({ user });
  })
);

router.get(
  "/subscriptions",
  asyncHandler(async (req, res) => {
    const query = listQuery
      .extend({
        plan: z.enum(["free", "pro", "business"]).optional(),
      })
      .parse(req.query);
    const result = await admin.listAdminSubscriptions(query);
    res.json(result);
  })
);

router.patch(
  "/subscriptions/:workspaceId",
  asyncHandler(async (req, res) => {
    const { workspaceId } = z
      .object({ workspaceId: z.string().uuid() })
      .parse(req.params);
    const body = z
      .object({
        plan: z.enum(["free", "pro", "business"]),
        subscriptionStatus: z.string().max(64).nullable().optional(),
        currentPeriodEnd: z.string().datetime().nullable().optional(),
      })
      .parse(req.body);
    const subscription = await admin.updateAdminSubscription({
      workspaceId,
      ...body,
    });
    res.json({ subscription });
  })
);

router.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const query = listQuery
      .extend({
        status: z
          .enum(["pending", "paid", "failed", "cancelled"])
          .optional(),
      })
      .parse(req.query);
    const result = await admin.listAdminPayments(query);
    res.json(result);
  })
);

router.post(
  "/payments/:id/verify",
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        force: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const result = await admin.verifyAdminPayment({
      paymentId: id,
      force: body.force,
    });
    res.json(result);
  })
);

router.post(
  "/payments/:id/reject",
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const result = await admin.rejectAdminPayment(id);
    res.json(result);
  })
);

export { router as adminRouter };

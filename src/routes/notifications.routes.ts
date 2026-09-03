import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { AppError } from "../lib/errors";
import * as notificationsService from "../services/notifications.service";

const router = Router();
router.use(requireAuth);

function getCaller(req: AuthedRequest): notificationsService.AuthCallerContext {
  if (!req.auth) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }
  return {
    userId: req.auth.sub,
    workspaceId: req.auth.wid,
    userRole: req.auth.userRole || "CUSTOMER",
  };
}

const listQuerySchema = z.object({
  unreadOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

/**
 * GET /v1/notifications
 * Lists notifications for the active user/workspace.
 */
router.get("/", async (req: AuthedRequest, res: Response, next) => {
  try {
    const caller = getCaller(req);
    const query = listQuerySchema.parse(req.query);
    const data = await notificationsService.listNotifications(caller, query);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/notifications/unread-count
 * Returns unread count for badge indicator.
 */
router.get("/unread-count", async (req: AuthedRequest, res: Response, next) => {
  try {
    const caller = getCaller(req);
    const unreadCount = await notificationsService.getUnreadNotificationCount(caller);
    res.json({ unreadCount });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /v1/notifications/:id/read
 * Marks a single notification as read.
 */
router.patch("/:id/read", async (req: AuthedRequest, res: Response, next) => {
  try {
    const caller = getCaller(req);
    const { id } = uuidParamSchema.parse(req.params);
    const updated = await notificationsService.markNotificationAsRead(caller, id);
    res.json({ notification: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/notifications/mark-all-read
 * Marks all unread notifications as read.
 */
router.post("/mark-all-read", async (req: AuthedRequest, res: Response, next) => {
  try {
    const caller = getCaller(req);
    const result = await notificationsService.markAllNotificationsAsRead(caller);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /v1/notifications/:id
 * Dismisses a notification.
 */
router.delete("/:id", async (req: AuthedRequest, res: Response, next) => {
  try {
    const caller = getCaller(req);
    const { id } = uuidParamSchema.parse(req.params);
    await notificationsService.deleteNotification(caller, id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export { router as notificationsRouter };

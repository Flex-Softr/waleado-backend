import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as followUps from "../services/followups.service";
import { LEAD_STAGES } from "../lib/followup-analysis";
import { isValidTimezone } from "../lib/followup-schedule";

const router = Router();
router.use(requireAuth);

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

function workspaceId(req: AuthedRequest): string {
  if (!req.auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  return req.auth.wid;
}

const listQuery = z.object({
  view: z.enum(["today", "suggested", "scheduled", "converted", "all"]).default("today"),
  /** ISO time: start of the user's local day for the "today" view. */
  since: z.string().datetime().optional(),
  deviceId: z.string().uuid().optional(),
});

const patchBody = z
  .object({
    stage: z.enum(LEAD_STAGES).optional(),
    followUpAt: z.string().datetime().nullable().optional(),
    followUpMessage: z.string().max(1500).nullable().optional(),
    followUpStatus: z.enum(["SCHEDULED", "CANCELED"]).optional(),
    needsHuman: z.boolean().optional(),
    manualLock: z.boolean().optional(),
    note: z.string().max(1000).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "At least one field is required",
  });

const settingsBody = z
  .object({
    autoSend: z.boolean().optional(),
    aiMode: z.enum(["AUTO", "SUGGEST", "OFF"]).optional(),
    timezone: z.string().max(100).refine(isValidTimezone, "Unknown timezone").optional(),
    windowStartHour: z.number().int().min(0).max(23).optional(),
    windowEndHour: z.number().int().min(0).max(23).optional(),
    maxFollowUps: z.number().int().min(1).max(5).optional(),
    dailyLimitPerDevice: z.number().int().min(1).max(500).optional(),
    idleHours: z.number().int().min(1).max(24).optional(),
    maxDays: z.number().int().min(1).max(90).optional(),
    instructions: z.string().max(3000).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "At least one field is required",
  });

// Declared before "/:id" so "settings" is never read as an id.
router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    res.json({ settings: await followUps.getFollowUpSettings(workspaceId(req)) });
  })
);

router.put(
  "/settings",
  asyncHandler(async (req, res) => {
    const body = settingsBody.parse(req.body);
    res.json({ settings: await followUps.saveFollowUpSettings(workspaceId(req), body) });
  })
);

const createBody = z.object({
  deviceId: z.string().uuid(),
  phone: z.string().min(3).max(40),
  name: z.string().max(200).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  followUpAt: z.string().datetime(),
  followUpMessage: z.string().min(1).max(1500),
});

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createBody.parse(req.body);
    const result = await followUps.createManualFollowUp(workspaceId(req), {
      ...body,
      followUpAt: new Date(body.followUpAt),
    });
    res.status(201).json(result);
  })
);

router.post(
  "/approve-all",
  asyncHandler(async (req, res) => {
    res.json(await followUps.approveAllSuggestions(workspaceId(req)));
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const q = listQuery.parse(req.query);
    const items = await followUps.listFollowUps(workspaceId(req), {
      view: q.view,
      since: q.since ? new Date(q.since) : undefined,
      deviceId: q.deviceId,
    });
    res.json({ items });
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = patchBody.parse(req.body);
    const item = await followUps.updateFollowUp(workspaceId(req), id, {
      stage: body.stage,
      followUpAt:
        body.followUpAt === undefined
          ? undefined
          : body.followUpAt === null
            ? null
            : new Date(body.followUpAt),
      followUpMessage: body.followUpMessage,
      followUpStatus: body.followUpStatus,
      needsHuman: body.needsHuman,
      manualLock: body.manualLock,
      note: body.note,
    });
    res.json({ item });
  })
);

router.post(
  "/:id/send-now",
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const item = await followUps.sendFollowUpNow(workspaceId(req), id);
    res.json({ item });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await followUps.deleteFollowUp(workspaceId(req), id);
    res.status(204).end();
  })
);

export { router as followUpsRouter };

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as followUps from "../services/followups.service";
import { LEAD_STAGES } from "../lib/followup-analysis";

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
  view: z.enum(["today", "scheduled", "converted", "all"]).default("today"),
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
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "At least one field is required",
  });

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

export { router as followUpsRouter };

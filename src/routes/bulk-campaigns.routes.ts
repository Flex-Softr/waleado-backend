import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as bulkCampaigns from "../services/bulk_campaigns.service";

const uuidParam = z.string().uuid();

const router = Router();
router.use(requireAuth);

const createBody = z
  .object({
    name: z.string().min(1).max(200),
    deviceIds: z.array(z.string().uuid()).min(1).max(20),
    kind: z.enum(["text", "template"]),
    bodyText: z.string().max(4096).optional(),
    templateId: z.string().uuid().optional(),
    selectionMode: z.enum(["groups", "all_verified", "manual"]),
    groupIds: z.array(z.string().uuid()).max(100).optional(),
    manualPhones: z.array(z.string()).max(5000).optional(),
    attachmentType: z
      .enum(["image", "video", "document", "audio"])
      .optional()
      .nullable(),
    attachmentAssetId: z.string().uuid().optional().nullable(),
    scheduleType: z.enum(["immediate", "scheduled"]),
    scheduledAt: z.string().optional().nullable(),
    deviceMode: z.enum(["single", "failover", "round_robin"]),
    delayMinSec: z.number().int().min(0).max(3600),
    delayMaxSec: z.number().int().min(0).max(3600),
    maxRetries: z.number().int().min(0).max(10),
    antiBlock: z
      .object({
        enabled: z.boolean().optional(),
        spintax: z.boolean().optional(),
        verifyNumbers: z.boolean().optional(),
        repliedOnly: z.boolean().optional(),
        recent24hOnly: z.boolean().optional(),
        uniquenessMode: z
          .enum(["none", "campaign", "workspace_window"])
          .optional(),
        batchPauseEvery: z.number().int().min(1).max(5000).optional(),
        batchPauseSec: z.number().int().min(1).max(3600).optional(),
        failLimitInRow: z.number().int().min(1).max(1000).optional(),
        activeHoursStart: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .optional()
          .nullable(),
        activeHoursEnd: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .optional()
          .nullable(),
        inactiveHoursStart: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .optional()
          .nullable(),
        inactiveHoursEnd: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .optional()
          .nullable(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "text" && !(data.bodyText?.trim().length)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Message text is required",
        path: ["bodyText"],
      });
    }
    if (data.kind === "template" && !data.templateId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Template is required",
        path: ["templateId"],
      });
    }
    if (
      data.selectionMode === "groups" &&
      (!data.groupIds || data.groupIds.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select at least one group",
        path: ["groupIds"],
      });
    }
    if (
      data.selectionMode === "manual" &&
      (!data.manualPhones || data.manualPhones.length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter at least one phone number",
        path: ["manualPhones"],
      });
    }
    if (
      data.scheduleType === "scheduled" &&
      !(data.scheduledAt && data.scheduledAt.trim().length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Scheduled time is required",
        path: ["scheduledAt"],
      });
    }
    if (data.deviceMode === "single" && data.deviceIds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select exactly one device for single-device mode",
        path: ["deviceIds"],
      });
    }
    if (data.antiBlock) {
      const hasStart = Boolean(data.antiBlock.activeHoursStart?.trim());
      const hasEnd = Boolean(data.antiBlock.activeHoursEnd?.trim());
      if (hasStart !== hasEnd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Both active-hours start and end are required",
          path: ["antiBlock", hasStart ? "activeHoursEnd" : "activeHoursStart"],
        });
      }
      const hasInactiveStart = Boolean(data.antiBlock.inactiveHoursStart?.trim());
      const hasInactiveEnd = Boolean(data.antiBlock.inactiveHoursEnd?.trim());
      if (hasInactiveStart !== hasInactiveEnd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Both inactive-hours start and end are required",
          path: [
            "antiBlock",
            hasInactiveStart ? "inactiveHoursEnd" : "inactiveHoursStart",
          ],
        });
      }
    }
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
    try {
      const auth = req.auth;

      if (!auth) {
        throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      }

    //  console.log("AUTH:", auth);

      const list = await bulkCampaigns.listBulkCampaigns(auth.wid);

      res.json({ campaigns: list });
    } catch (error) {
    //  console.error("Bulk campaigns error:", error);

      res.status(500).json({
        message: (error as Error).message ?? "Internal server error",
      });
    }
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const parsed = uuidParam.safeParse(req.params.id);
    if (!parsed.success) {
      throw new AppError(400, "Invalid campaign id", "VALIDATION");
    }
    const detail = await bulkCampaigns.getBulkCampaignDetail(auth.wid, parsed.data);
    res.json(detail);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = createBody.parse(req.body);
    const out = await bulkCampaigns.createBulkCampaign(auth.wid, {
      name: body.name,
      deviceIds: body.deviceIds,
      deviceMode: body.deviceMode,
      kind: body.kind,
      bodyText: body.bodyText,
      templateId: body.templateId,
      selectionMode: body.selectionMode,
      groupIds: body.groupIds,
      manualPhones: body.manualPhones,
      attachmentType: body.attachmentType,
      attachmentAssetId: body.attachmentAssetId,
      scheduleType: body.scheduleType,
      scheduledAt: body.scheduledAt,
      delayMinSec: body.delayMinSec,
      delayMaxSec: body.delayMaxSec,
      maxRetries: body.maxRetries,
      antiBlock: body.antiBlock,
    });
    res.status(201).json(out);
  })
);

router.patch(
  "/:id/pause",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const parsed = uuidParam.safeParse(req.params.id);
    if (!parsed.success) {
      throw new AppError(400, "Invalid campaign id", "VALIDATION");
    }
    const campaign = await bulkCampaigns.pauseBulkCampaign(auth.wid, parsed.data);
    res.json({ campaign });
  })
);

router.patch(
  "/:id/resume",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const parsed = uuidParam.safeParse(req.params.id);
    if (!parsed.success) {
      throw new AppError(400, "Invalid campaign id", "VALIDATION");
    }
    const campaign = await bulkCampaigns.resumeBulkCampaign(auth.wid, parsed.data);
    res.json({ campaign });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const parsed = uuidParam.safeParse(req.params.id);
    if (!parsed.success) {
      throw new AppError(400, "Invalid campaign id", "VALIDATION");
    }
    await bulkCampaigns.deleteBulkCampaign(auth.wid, parsed.data);
    res.status(204).send();
  })
);

export { router as bulkCampaignsRouter };

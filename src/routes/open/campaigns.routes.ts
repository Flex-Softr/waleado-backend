import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { openApiSuccess } from "../../lib/open-api-response";
import type { ApiClientRequest } from "../../middleware/api-client-auth";
import * as bulkCampaigns from "../../services/bulk_campaigns.service";

const uuidParam = z.string().uuid();

const createBody = z
  .object({
    name: z.string().min(1).max(200),
    deviceIds: z.array(z.string().uuid()).min(1).max(20),
    kind: z.enum(["text", "template"]).default("text"),
    bodyText: z.string().max(4096).optional(),
    bodyTexts: z.array(z.string().min(1).max(4096)).min(1).max(20).optional(),
    templateId: z.string().uuid().optional(),
    selectionMode: z.enum(["groups", "all_verified", "manual"]).default("groups"),
    groupIds: z.array(z.string().uuid()).max(100).optional(),
    manualPhones: z.array(z.string()).max(5000).optional(),
    scheduleType: z.enum(["immediate", "scheduled"]).default("immediate"),
    scheduledAt: z.string().optional().nullable(),
    deviceMode: z
      .enum(["single", "failover", "round_robin"])
      .default("single"),
    delayMinSec: z.number().int().min(0).max(3600).default(12),
    delayMaxSec: z.number().int().min(0).max(3600).default(45),
    maxRetries: z.number().int().min(0).max(10).default(3),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "text") {
      const hasBodyText = Boolean(data.bodyText?.trim().length);
      const hasBodyTexts = Boolean(
        data.bodyTexts?.some((t) => t.trim().length > 0)
      );
      if (!hasBodyText && !hasBodyTexts) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Message text is required",
          path: ["bodyText"],
        });
      }
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
  });

const router = Router();

function asyncHandler(
  fn: (req: ApiClientRequest, res: import("express").Response) => Promise<void>
) {
  return (
    req: ApiClientRequest,
    res: import("express").Response,
    next: import("express").NextFunction
  ) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

function requireWorkspace(req: ApiClientRequest): string {
  const workspaceId = req.apiClient?.workspaceId;
  if (!workspaceId) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }
  return workspaceId;
}

/** Create and start a bulk campaign (group / verified / manual recipients). */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const workspaceId = requireWorkspace(req);
    const body = createBody.parse(req.body);
    const out = await bulkCampaigns.createBulkCampaign(workspaceId, {
      name: body.name,
      deviceIds: body.deviceIds,
      deviceMode: body.deviceMode,
      kind: body.kind,
      bodyText: body.bodyText,
      bodyTexts: body.bodyTexts,
      templateId: body.templateId,
      selectionMode: body.selectionMode,
      groupIds: body.groupIds,
      manualPhones: body.manualPhones,
      scheduleType: body.scheduleType,
      scheduledAt: body.scheduledAt,
      delayMinSec: body.delayMinSec,
      delayMaxSec: body.delayMaxSec,
      maxRetries: body.maxRetries,
    });
    openApiSuccess(res, "Campaign created successfully.", out, 201);
  })
);

/** Poll campaign status after bulk send. */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const workspaceId = requireWorkspace(req);
    const parsed = uuidParam.safeParse(req.params.id);
    if (!parsed.success) {
      throw new AppError(400, "Invalid campaign id", "VALIDATION");
    }
    const detail = await bulkCampaigns.getBulkCampaignDetail(
      workspaceId,
      parsed.data
    );
    openApiSuccess(res, "Campaign retrieved successfully.", detail);
  })
);

export { router as openCampaignsRouter };

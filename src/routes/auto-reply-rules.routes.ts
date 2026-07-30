import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as autoReply from "../services/auto_reply_rules.service";

const router = Router();
router.use(requireAuth);

const triggerTypeSchema = z.enum([
  "keyword",
  "exact",
  "contains",
  "starts_with",
  "ends_with",
  "regex",
]);

const messageModeSchema = z.enum(["text", "template", "media"]);

const openAiSettingsSchema = z
  .object({
    credentialId: z.string().uuid().optional(),
    /** Legacy pasted key — still accepted for dual-read of old rules */
    apiKey: z.string().min(1).optional(),
    model: z.string().min(1).max(200).optional(),
    baseUrl: z.string().max(500).optional(),
    systemPrompt: z.string().max(8000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional().nullable(),
    continuousChat: z.boolean().optional(),
  })
  .passthrough()
  .refine(
    (o) =>
      Boolean(o.credentialId?.trim()) || Boolean(o.apiKey?.trim()),
    { message: "credentialId or apiKey is required" }
  );

const createBody = z.object({
  name: z.string().min(1).max(200),
  keyword: z.string().min(1).max(8000),
  triggerType: triggerTypeSchema,
  caseSensitive: z.boolean(),
  deviceId: z.string().uuid(),
  priority: z.number().int().min(0).max(1_000_000),
  cooldownMinutes: z.number().int().min(0).max(10_080),
  messageMode: messageModeSchema,
  templateId: z.string().uuid().optional().nullable(),
  mediaAssetId: z.string().uuid().optional().nullable(),
  mediaCaption: z.string().max(4096).optional().nullable(),
  response: z.string().max(4096),
  openAiEnabled: z.boolean(),
  openAiSettings: openAiSettingsSchema.optional().nullable(),
  active: z.boolean(),
});

const patchBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    keyword: z.string().min(1).max(8000).optional(),
    triggerType: triggerTypeSchema.optional(),
    caseSensitive: z.boolean().optional(),
    deviceId: z.string().uuid().optional(),
    priority: z.number().int().min(0).max(1_000_000).optional(),
    cooldownMinutes: z.number().int().min(0).max(10_080).optional(),
    messageMode: messageModeSchema.optional(),
    templateId: z.string().uuid().optional().nullable(),
    mediaAssetId: z.string().uuid().optional().nullable(),
    mediaCaption: z.string().max(4096).optional().nullable(),
    response: z.string().max(4096).optional(),
    openAiEnabled: z.boolean().optional(),
    openAiSettings: openAiSettingsSchema.optional().nullable(),
    active: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "At least one field is required",
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
    const rules = await autoReply.listAutoReplyRules(auth.wid);
    res.json({ rules });
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
    const row = await autoReply.createAutoReplyRule(auth.wid, body);
    res.status(201).json({ rule: row });
  })
);

router.patch(
  "/:ruleId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { ruleId } = z.object({ ruleId: z.string().uuid() }).parse(req.params);
    const body = patchBody.parse(req.body);
    const row = await autoReply.updateAutoReplyRule(auth.wid, ruleId, body);
    res.json({ rule: row });
  })
);

router.delete(
  "/:ruleId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { ruleId } = z.object({ ruleId: z.string().uuid() }).parse(req.params);
    await autoReply.deleteAutoReplyRule(auth.wid, ruleId);
    res.status(204).send();
  })
);

export { router as autoReplyRulesRouter };

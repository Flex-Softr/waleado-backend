import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { AppError } from "../../lib/errors";
import {
  getSystemMessagingConfig,
  sendTestMessage,
  updateSystemMessagingSettings,
} from "../../system-messages/admin.service";
import { isTemplateKey } from "../../system-messages/templates";
import { listTemplates, resetTemplate, saveTemplateOverride } from "../../system-messages/template-store.service";

/** Mounted under /v1/admin/system (auth + platform admin already enforced by the parent). */
const router = Router();

router.get("/messaging", asyncHandler(async (_req, res) => {
  res.json(await getSystemMessagingConfig());
}));

router.put("/messaging", asyncHandler(async (req, res) => {
  const body = z
    .object({
      senderDeviceId: z.string().uuid().nullable(),
      emailEnabled: z.boolean(),
      whatsappEnabled: z.boolean(),
      requirePhoneVerification: z.boolean(),
      idleFreeDeviceDays: z.coerce.number().int().min(0).max(365),
    })
    .parse(req.body);
  res.json(await updateSystemMessagingSettings(body));
}));

router.post("/messaging/test", asyncHandler(async (req, res) => {
  const body = z.object({ channel: z.enum(["email", "whatsapp"]), to: z.string().trim().min(3).max(320) }).parse(req.body);
  res.json(await sendTestMessage(body));
}));

router.get("/templates", asyncHandler(async (_req, res) => {
  res.json({ templates: await listTemplates() });
}));

function templateKey(raw: string) {
  if (!isTemplateKey(raw)) throw new AppError(404, "Unknown template", "NOT_FOUND");
  return raw;
}

router.put("/templates/:key", asyncHandler(async (req, res) => {
  const key = templateKey(req.params.key);
  const body = z
    .object({
      whatsappBody: z.string().max(4000).nullable().optional(),
      emailSubject: z.string().max(200).nullable().optional(),
      emailBody: z.string().max(10000).nullable().optional(),
      whatsappEnabled: z.boolean().optional(),
      emailEnabled: z.boolean().optional(),
    })
    .parse(req.body);
  res.json({ template: await saveTemplateOverride(key, body) });
}));

router.delete("/templates/:key", asyncHandler(async (req, res) => {
  res.json({ template: await resetTemplate(templateKey(req.params.key)) });
}));

export { router as adminSystemRouter };

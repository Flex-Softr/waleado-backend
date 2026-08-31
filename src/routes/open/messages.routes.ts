import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { openApiSuccess } from "../../lib/open-api-response";
import { validateAndFormatPhoneRequireCountryCode } from "../../lib/phone";
import type { ApiClientRequest } from "../../middleware/api-client-auth";
import * as devices from "../../services/devices.service";
import * as messaging from "../../services/messaging.service";
import { assertE164RegisteredOnWhatsApp } from "../../services/wa-phone-presence.service";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB limit
});

const validatePhoneBody = z.object({
  phone: z.string(),
});

const singleSendSchema = z.object({
  toPhone: z.string().min(3),
  bodyText: z.string().max(4096).optional(),
  message: z.string().max(4096).optional(),
  caption: z.string().max(4096).optional(),
  fileUrl: z.string().optional(),
  mediaUrl: z.string().optional(),
  fileBase64: z.string().optional(),
  fileData: z.string().optional(),
  fileName: z.string().max(255).optional(),
  mimeType: z.string().max(100).optional(),
  templateId: z.string().uuid().optional(),
  kind: z.enum(["text", "template", "media"]).optional(),
});

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

router.post(
  "/validate-phone",
  asyncHandler(async (req, res) => {
    requireWorkspace(req);
    const body = validatePhoneBody.parse(req.body);
    const result = validateAndFormatPhoneRequireCountryCode(body.phone);
    if (result.valid) {
      openApiSuccess(res, "Phone number validated successfully.", {
        valid: true,
        e164: result.e164,
      });
      return;
    }
    openApiSuccess(res, "Phone number validation failed.", {
      valid: false,
      e164: null,
      message: result.message,
    });
  })
);

const handleSingleMessageSend = asyncHandler(async (req, res) => {
  const workspaceId = requireWorkspace(req);
  const body = singleSendSchema.parse(req.body);

  const phone = validateAndFormatPhoneRequireCountryCode(body.toPhone);
  if (!phone.valid) {
    throw new AppError(400, phone.message, "INVALID_PHONE");
  }

  const device = await devices.getDefaultDeviceOrThrow(workspaceId);
  await assertE164RegisteredOnWhatsApp(workspaceId, phone.e164, device.id);

  const rawText = (body.bodyText || body.message || body.caption || "").trim();
  const fileUrl = (body.fileUrl || body.mediaUrl || "").trim();
  const fileBase64 = (body.fileBase64 || body.fileData || "").trim();
  const uploadedFile = req.file;

  const hasMedia = Boolean(uploadedFile || fileUrl || fileBase64);

  let payload: messaging.SingleSendPayload;

  if (body.templateId) {
    payload = {
      deviceId: device.id,
      toPhone: phone.e164,
      kind: "template",
      templateId: body.templateId,
    };
  } else if (hasMedia) {
    payload = {
      deviceId: device.id,
      toPhone: phone.e164,
      kind: "media",
      bodyText: rawText,
      fileBuffer: uploadedFile?.buffer,
      fileBase64: fileBase64 || undefined,
      fileUrl: fileUrl || undefined,
      fileName: body.fileName || uploadedFile?.originalname,
      mimeType: body.mimeType || uploadedFile?.mimetype,
    };
  } else {
    if (!rawText) {
      throw new AppError(
        400,
        "Message bodyText or media attachment (fileUrl, fileBase64, or file upload) is required",
        "VALIDATION"
      );
    }
    payload = {
      deviceId: device.id,
      toPhone: phone.e164,
      kind: "text",
      bodyText: rawText,
    };
  }

  const out = await messaging.sendSingleMessage(workspaceId, payload);
  openApiSuccess(res, "Message sent successfully.", out, 201);
});

router.post("/single", upload.single("file"), handleSingleMessageSend);
router.post("/media", upload.single("file"), handleSingleMessageSend);
router.post("/document", upload.single("file"), handleSingleMessageSend);

export { router as openMessagesRouter };

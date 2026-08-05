import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { openApiSuccess } from "../../lib/open-api-response";
import { validateAndFormatPhoneRequireCountryCode } from "../../lib/phone";
import type { ApiClientRequest } from "../../middleware/api-client-auth";
import * as devices from "../../services/devices.service";
import * as messaging from "../../services/messaging.service";
import { assertE164RegisteredOnWhatsApp } from "../../services/wa-phone-presence.service";

const router = Router();

const validatePhoneBody = z.object({
  phone: z.string(),
});

const singleSendSchema = z.object({
  toPhone: z.string().min(3),
  bodyText: z.string().min(1).max(4096),
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

router.post(
  "/single",
  asyncHandler(async (req, res) => {
    const workspaceId = requireWorkspace(req);
    const body = singleSendSchema.parse(req.body);

    const phone = validateAndFormatPhoneRequireCountryCode(body.toPhone);
    if (!phone.valid) {
      throw new AppError(400, phone.message, "INVALID_PHONE");
    }

    const device = await devices.getDefaultDeviceOrThrow(workspaceId);
    await assertE164RegisteredOnWhatsApp(workspaceId, phone.e164, device.id);

    const out = await messaging.sendSingleMessage(workspaceId, {
      deviceId: device.id,
      toPhone: phone.e164,
      kind: "text",
      bodyText: body.bodyText,
    });
    openApiSuccess(res, "Message sent successfully.", out, 201);
  })
);

export { router as openMessagesRouter };

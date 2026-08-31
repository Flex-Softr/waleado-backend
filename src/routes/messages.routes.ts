import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { validateAndFormatPhone } from "../lib/phone";
import * as messaging from "../services/messaging.service";

const router = Router();
router.use(requireAuth);

const validatePhoneBody = z.object({
  phone: z.string(),
});

const singleSendSchema = z.discriminatedUnion("kind", [
  z.object({
    deviceId: z.string().uuid(),
    toPhone: z.string().min(3),
    kind: z.literal("text"),
    bodyText: z.string().min(1).max(4096),
  }),
  z.object({
    deviceId: z.string().uuid(),
    toPhone: z.string().min(3),
    kind: z.literal("template"),
    templateId: z.string().uuid(),
  }),
  z.object({
    deviceId: z.string().uuid(),
    toPhone: z.string().min(3),
    kind: z.literal("media"),
    bodyText: z.string().max(4096).optional(),
    fileUrl: z.string().optional(),
    fileBase64: z.string().optional(),
    fileName: z.string().max(255).optional(),
    mimeType: z.string().max(100).optional(),
  }),
]);

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

router.post(
  "/validate-phone",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = validatePhoneBody.parse(req.body);
    const result = validateAndFormatPhone(body.phone);
    if (result.valid) {
      res.json({ valid: true, e164: result.e164 });
      return;
    }
    res.json({
      valid: false,
      e164: null,
      message: result.message,
    });
  })
);

router.post(
  "/single",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = singleSendSchema.parse(req.body);
    const out = await messaging.sendSingleMessage(auth.wid, body);
    res.status(201).json(out);
  })
);

export { router as messagesRouter };

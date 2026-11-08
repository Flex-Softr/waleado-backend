import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { asyncHandler } from "../lib/async-handler";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import {
  getPhoneVerificationState,
  sendPhoneOtp,
  verifyPhoneOtp,
} from "../phone-verification/phone-verification.service";

/** Mounted under /v1/auth/phone. */
const router = Router();
router.use(requireAuth);

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMIT", message: "Too many attempts" } },
});

function userId(req: AuthedRequest): string {
  if (!req.auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  return req.auth.sub;
}

router.get("/", asyncHandler<AuthedRequest>(async (req, res) => {
  res.json(await getPhoneVerificationState(userId(req)));
}));

router.post("/send-otp", otpLimiter, asyncHandler<AuthedRequest>(async (req, res) => {
  const { phone } = z.object({ phone: z.string().trim().min(5).max(30) }).parse(req.body);
  res.json(await sendPhoneOtp(userId(req), phone));
}));

router.post("/verify", otpLimiter, asyncHandler<AuthedRequest>(async (req, res) => {
  const { code } = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") }).parse(req.body);
  res.json(await verifyPhoneOtp(userId(req), code));
}));

export { router as phoneVerificationRouter };

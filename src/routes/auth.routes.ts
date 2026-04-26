import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  loginUser,
  logoutAllSessions,
  logoutSession,
  refreshSession,
  registerUser,
  getMeForUser,
} from "../services/auth.service";
import { setRefreshCookie, clearRefreshCookie, getRefreshCookieName } from "../lib/cookies";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { AppError } from "../lib/errors";

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMIT", message: "Too many attempts" } },
});

const strictAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMIT", message: "Too many attempts" } },
});

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(128),
  name: z.string().trim().max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

function asyncHandler(
  fn: (req: AuthedRequest, res: import("express").Response) => Promise<void>
) {
  return (req: AuthedRequest, res: import("express").Response, next: import("express").NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

router.post(
  "/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const prior = req.cookies[getRefreshCookieName()] as string | undefined;
    if (prior) {
      await logoutSession(prior);
    }
    const { rawRefresh, ...payload } = await registerUser(body);
    setRefreshCookie(res, rawRefresh);
    res.status(201).json(payload);
  })
);

router.post(
  "/login",
  strictAuthLimiter,
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const prior = req.cookies[getRefreshCookieName()] as string | undefined;
    if (prior) {
      await logoutSession(prior);
    }
    const { rawRefresh, ...payload } = await loginUser(body);
    setRefreshCookie(res, rawRefresh);
    res.json(payload);
  })
);

router.post(
  "/refresh",
  authLimiter,
  asyncHandler(async (req, res) => {
    const raw = req.cookies[getRefreshCookieName()] as string | undefined;
    const { response, rawRefresh } = await refreshSession(raw);
    setRefreshCookie(res, rawRefresh);
    res.json({
      user: response.user,
      workspace: response.workspace,
      accessToken: response.accessToken,
    });
  })
);

router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const raw = req.cookies[getRefreshCookieName()] as string | undefined;
    await logoutSession(raw);
    clearRefreshCookie(res);
    res.status(204).send();
  })
);

router.post(
  "/logout-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    await logoutAllSessions(auth.sub);
    clearRefreshCookie(res);
    res.status(204).send();
  })
);

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const me = await getMeForUser(auth.sub, auth.wid);
    res.json(me);
  })
);

export { router as authRouter };

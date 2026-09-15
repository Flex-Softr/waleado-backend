import { randomBytes } from "crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  loginUser,
  logoutAllSessions,
  logoutSession,
  refreshSession,
  registerUser,
  requestPasswordReset,
  resetPassword,
  getMeForUser,
  updateMeForUser,
  changePasswordForUser,
  signInOrRegisterGoogleUser,
} from "../services/auth.service";
import {
  setRefreshCookie,
  clearRefreshCookie,
  getRefreshCookieName,
  setGoogleOAuthCookies,
  readGoogleOAuthCookies,
  clearGoogleOAuthCookies,
} from "../lib/cookies";
import { isSafeInternalPath } from "../lib/safe-redirect";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { AppError } from "../lib/errors";
import { env, isGoogleOAuthConfigured } from "../env";
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleAuthCode,
} from "../services/google-oauth.service";

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
    .min(8, "Password must be at least 8 characters")
    .max(128),
  name: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(30).optional().nullable(),
  phoneNumber: z.string().trim().max(30).optional().nullable(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

const forgotPasswordSchema = z.object({
  email: z.string().email().max(255),
});

const resetPasswordSchema = z.object({
  token: z.string().min(20).max(256),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
});

const updateMeSchema = z.object({
  name: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  phoneNumber: z.string().trim().max(30).optional().nullable(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().max(128).optional(),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
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
    const phoneInput = body.phone !== undefined ? body.phone : body.phoneNumber;
    const { rawRefresh, ...payload } = await registerUser({
      email: body.email,
      password: body.password,
      name: body.name,
      phone: phoneInput,
    });
    setRefreshCookie(res, rawRefresh);
    res.status(201).json(payload);
  })
);

router.get(
  "/google/start",
  authLimiter,
  asyncHandler(async (req, res) => {
    const nextRaw =
      typeof req.query.next === "string" ? req.query.next : undefined;
    const next =
      nextRaw && isSafeInternalPath(nextRaw) ? nextRaw : undefined;

    const frontendBase = env.APP_PUBLIC_URL.replace(/\/$/, "");
    if (!isGoogleOAuthConfigured()) {
      clearGoogleOAuthCookies(res);
      const q = new URLSearchParams({ error: "oauth_not_configured" });
      res.redirect(`${frontendBase}/oauth/google/callback?${q}`);
      return;
    }

    const prior = req.cookies[getRefreshCookieName()] as string | undefined;
    if (prior) {
      await logoutSession(prior);
    }

    const state = randomBytes(24).toString("hex");
    setGoogleOAuthCookies(res, state, next);
    const url = buildGoogleAuthorizeUrl(state);
    res.redirect(302, url);
  })
);

router.get(
  "/google/callback",
  authLimiter,
  asyncHandler(async (req, res) => {
    const frontendBase = env.APP_PUBLIC_URL.replace(/\/$/, "");

    const redirectError = (code: string) => {
      clearGoogleOAuthCookies(res);
      const q = new URLSearchParams({ error: code });
      res.redirect(302, `${frontendBase}/oauth/google/callback?${q}`);
    };

    const oauthErr =
      typeof req.query.error === "string" ? req.query.error : undefined;
    if (oauthErr) {
      redirectError(
        oauthErr === "access_denied" ? "access_denied" : "oauth_failed"
      );
      return;
    }

    const code =
      typeof req.query.code === "string" ? req.query.code : undefined;
    const state =
      typeof req.query.state === "string" ? req.query.state : undefined;
    const { state: cookieState, next: cookieNext } =
      readGoogleOAuthCookies(req);

    if (!code || !state || !cookieState || state !== cookieState) {
      console.warn("[Google OAuth] State validation failed or missing parameters:", {
        hasCode: Boolean(code),
        hasState: Boolean(state),
        hasCookieState: Boolean(cookieState),
        stateMatch: state === cookieState,
      });
      redirectError("invalid_state");
      return;
    }

    try {
      const claims = await exchangeGoogleAuthCode(code);
      const prior = req.cookies[getRefreshCookieName()] as string | undefined;
      if (prior) {
        await logoutSession(prior);
      }
      const { rawRefresh } = await signInOrRegisterGoogleUser({
        googleSub: claims.sub,
        email: claims.email,
        name: claims.name,
      });
      setRefreshCookie(res, rawRefresh);
      clearGoogleOAuthCookies(res);
      const q = new URLSearchParams({ ok: "1" });
      if (cookieNext && isSafeInternalPath(cookieNext)) {
        q.set("next", cookieNext);
      }
      res.redirect(302, `${frontendBase}/oauth/google/callback?${q}`);
    } catch (err) {
      console.error("[Google OAuth] Callback processing failed:", err);
      const code =
        err instanceof AppError ? err.code ?? "oauth_failed" : "oauth_failed";
      redirectError(code);
    }
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
  "/forgot-password",
  strictAuthLimiter,
  asyncHandler(async (req, res) => {
    const body = forgotPasswordSchema.parse(req.body);
    const out = await requestPasswordReset(body);
    res.json(out);
  })
);

router.post(
  "/reset-password",
  strictAuthLimiter,
  asyncHandler(async (req, res) => {
    const body = resetPasswordSchema.parse(req.body);
    const out = await resetPassword(body);
    clearRefreshCookie(res);
    res.json(out);
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

router.patch(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = updateMeSchema.parse(req.body);
    const phoneInput = body.phone !== undefined ? body.phone : body.phoneNumber;
    const me = await updateMeForUser(auth.sub, auth.wid, {
      name: body.name,
      phone: phoneInput,
    });
    res.json(me);
  })
);

router.post(
  "/change-password",
  requireAuth,
  strictAuthLimiter,
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = changePasswordSchema.parse(req.body);
    const result = await changePasswordForUser(auth.sub, body);
    res.json(result);
  })
);

export { router as authRouter };


import type { CookieOptions, Response } from "express";
import { env } from "../env";

const REFRESH_COOKIE = "waleado_refresh";
const LEGACY_REFRESH_COOKIE = "fw_refresh";
/** Cookie scoped to auth routes only — not sent to other API paths. */
const REFRESH_PATH = "/v1/auth";

const OAUTH_GOOGLE_STATE = "waleado_oauth_google_state";
const OAUTH_GOOGLE_NEXT = "waleado_oauth_google_next";

export function getRefreshCookieName(): string {
  return REFRESH_COOKIE;
}

export function readRefreshCookie(req: { cookies: Record<string, unknown> }): string | undefined {
  const token = req.cookies[REFRESH_COOKIE] ?? req.cookies[LEGACY_REFRESH_COOKIE];
  return typeof token === "string" ? token : undefined;
}

function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === "true") return true;
  if (process.env.COOKIE_SECURE === "false") return false;
  if (env.APP_PUBLIC_URL.startsWith("http://") && !env.APP_PUBLIC_URL.startsWith("https://")) {
    return false;
  }
  return env.NODE_ENV === "production";
}

function sameSite(): CookieOptions["sameSite"] {
  const envVal = process.env.COOKIE_SAME_SITE || env.COOKIE_SAME_SITE;
  if (envVal === "none") return "none";
  if (envVal === "strict") return "strict";
  if (envVal === "lax") return "lax";
  return cookieSecure() ? "none" : "lax";
}

export function setRefreshCookie(res: Response, rawToken: string): void {
  const maxAgeMs = env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  res.cookie(REFRESH_COOKIE, rawToken, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: sameSite(),
    path: REFRESH_PATH,
    maxAge: maxAgeMs,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: sameSite(),
    path: REFRESH_PATH,
  });
  res.clearCookie(LEGACY_REFRESH_COOKIE, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: sameSite(),
    path: REFRESH_PATH,
  });
}

const oauthCookieOpts = (): Pick<
  CookieOptions,
  "httpOnly" | "secure" | "sameSite" | "path"
> => ({
  httpOnly: true,
  secure: cookieSecure(),
  sameSite: sameSite(),
  path: REFRESH_PATH,
});

/** Short-lived CSRF state + optional post-login path for Google OAuth. */
export function setGoogleOAuthCookies(
  res: Response,
  state: string,
  nextPath?: string
): void {
  const base = oauthCookieOpts();
  const maxAge = 10 * 60 * 1000;
  res.cookie(OAUTH_GOOGLE_STATE, state, { ...base, maxAge });
  if (nextPath) {
    res.cookie(OAUTH_GOOGLE_NEXT, nextPath, { ...base, maxAge });
  } else {
    res.clearCookie(OAUTH_GOOGLE_NEXT, base);
  }
}

export function readGoogleOAuthCookies(req: import("express").Request): {
  state?: string;
  next?: string;
} {
  return {
    state: req.cookies[OAUTH_GOOGLE_STATE] as string | undefined,
    next: req.cookies[OAUTH_GOOGLE_NEXT] as string | undefined,
  };
}

export function clearGoogleOAuthCookies(res: Response): void {
  const base = oauthCookieOpts();
  res.clearCookie(OAUTH_GOOGLE_STATE, base);
  res.clearCookie(OAUTH_GOOGLE_NEXT, base);
}

import type { CookieOptions, Response } from "express";
import { env } from "../env";

const REFRESH_COOKIE = "fw_refresh";
/** Cookie scoped to auth routes only — not sent to other API paths. */
const REFRESH_PATH = "/v1/auth";

export function getRefreshCookieName(): string {
  return REFRESH_COOKIE;
}

function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === "true") return true;
  if (process.env.COOKIE_SECURE === "false") return false;
  return env.NODE_ENV === "production";
}

function sameSite(): CookieOptions["sameSite"] {
  const s = env.COOKIE_SAME_SITE;
  if (s === "none") return "none";
  if (s === "strict") return "strict";
  return "lax";
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
}

import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, type AccessPayload } from "../lib/jwt";
import { AppError } from "../lib/errors";

export type AuthedRequest = Request & { auth?: AccessPayload };

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.auth) {
    next();
    return;
  }
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(new AppError(401, "Missing or invalid authorization header", "UNAUTHORIZED"));
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    next(new AppError(401, "Missing access token", "UNAUTHORIZED"));
    return;
  }
  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch {
    next(new AppError(401, "Invalid or expired access token", "TOKEN_INVALID"));
  }
}

import type { NextFunction, Response } from "express";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "./auth";

/** Requires Bearer auth and platform UserRole ADMIN (JWT userRole claim). */
export function requirePlatformAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.auth) {
    requireAuth(req, res, (err) => {
      if (err) return next(err);
      proceedPlatformAdmin(req, res, next);
    });
    return;
  }
  proceedPlatformAdmin(req, res, next);
}

function proceedPlatformAdmin(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction
): void {
  if (!req.auth || req.auth.userRole !== "ADMIN") {
    next(
      new AppError(
        403,
        "Platform admin access required",
        "FORBIDDEN"
      )
    );
    return;
  }
  next();
}

import type { NextFunction, Response } from "express";
import { AppError } from "../lib/errors";
import type { AuthedRequest } from "./auth";

/** Requires Bearer auth and platform UserRole ADMIN (JWT userRole claim). */
export function requirePlatformAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.auth) {
    next(new AppError(401, "Unauthorized", "UNAUTHORIZED"));
    return;
  }
  if (req.auth.userRole !== "ADMIN") {
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

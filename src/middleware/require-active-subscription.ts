import type { NextFunction, Response } from "express";
import { AppError } from "../lib/errors";
import type { AuthedRequest } from "./auth";
import { checkWorkspaceSubscriptionAccess } from "../services/billing.service";

/**
 * Ensures the workspace has an active subscription or active 3-day free trial.
 * If the 3-day trial has expired and no paid plan is active, returns 402 SUBSCRIPTION_REQUIRED.
 * Platform admins bypass this check.
 */
export async function requireActiveSubscription(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const auth = req.auth;
  if (!auth) {
    next(new AppError(401, "Unauthorized", "UNAUTHORIZED"));
    return;
  }

  // Platform admins always have platform-wide operational access
  if (auth.userRole === "ADMIN") {
    next();
    return;
  }

  try {
    const access = await checkWorkspaceSubscriptionAccess(auth.wid, auth.sub);
    if (!access.hasAccess) {
      next(
        new AppError(
          402,
          "Your 3-day free trial has expired. Please choose a subscription plan to continue using this feature.",
          "SUBSCRIPTION_REQUIRED"
        )
      );
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

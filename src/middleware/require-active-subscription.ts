import type { NextFunction, Response } from "express";
import { requireAuth, type AuthedRequest } from "./auth";
import { assertFeature, getEntitlements } from "../billing/entitlements.service";
import type { PlanFeature } from "../billing/limits";
import { assertPhoneVerified } from "../phone-verification/phone-verification.service";

/**
 * Gate for workspace features: authenticated, WhatsApp number verified (when required), and
 * entitlements loaded. Every workspace has at least the Free plan, so there is no plan lockout;
 * plan-specific access is enforced with `requireFeature` and per-action limit checks.
 * Kept under its old name so existing routers keep working.
 */
export function requireActiveSubscription(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.auth) return next();
    const { sub, wid } = req.auth;
    assertPhoneVerified(sub)
      .then(() => getEntitlements(wid))
      .then(() => next())
      .catch(next);
  });
}

/** Blocks the route unless the workspace's current plan includes `feature`. */
export function requireFeature(feature: PlanFeature) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    requireAuth(req, res, (err?: unknown) => {
      if (err) return next(err);
      if (!req.auth) return next();
      const { sub, wid } = req.auth;
      assertPhoneVerified(sub)
        .then(() => assertFeature(wid, feature))
        .then(() => next())
        .catch(next);
    });
  };
}

import type { NextFunction, Response } from "express";
import { requireAuth, type AuthedRequest } from "./auth";
import { assertFeature, getEntitlements } from "../billing/entitlements.service";
import type { PlanFeature } from "../billing/limits";

/**
 * Every workspace now has at least the Free plan, so this only authenticates and
 * warms the entitlement cache. Kept under the old name so existing routers keep working.
 * Plan-specific access is enforced with `requireFeature` and per-action limit checks.
 */
export function requireActiveSubscription(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    if (!req.auth) return next();
    getEntitlements(req.auth.wid)
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
      assertFeature(req.auth.wid, feature)
        .then(() => next())
        .catch(next);
    });
  };
}

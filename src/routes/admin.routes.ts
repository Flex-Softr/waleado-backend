import { Router } from "express";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import { getAdminOverview } from "../services/admin_overview.service";
import * as adminSubscriptions from "../services/admin_subscriptions.service";
import * as adminBilling from "../services/admin_billing.service";
import * as adminTenants from "../services/admin_tenants.service";
import * as adminUsers from "../services/admin_users.service";
import * as adminUsage from "../services/admin_usage.service";
import * as adminFleet from "../services/admin_fleet.service";
import * as adminCompliance from "../services/admin_compliance.service";
import * as adminModeration from "../services/admin_moderation.service";
import { getAdminScreen } from "../services/admin_screen.service";

const router = Router();
router.use(requireAuth);

function asyncHandler(
  fn: (req: AuthedRequest, res: import("express").Response) => Promise<void>
) {
  return (
    req: AuthedRequest,
    res: import("express").Response,
    next: import("express").NextFunction
  ) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

function requireWorkspaceAdminRole(role: string | undefined): void {
  if (role === "OWNER" || role === "ADMIN") return;
  throw new AppError(403, "Admin requires workspace owner or admin", "FORBIDDEN");
}

router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const overview = await getAdminOverview(auth.email, auth.wid);
    res.json(overview);
  })
);

router.get(
  "/subscriptions",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminSubscriptions.getAdminSubscriptions(
      auth.email,
      auth.wid
    );
    res.json(json);
  })
);

router.get(
  "/billing",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminBilling.getAdminBilling(auth.email, auth.wid);
    res.json(json);
  })
);

router.get(
  "/tenants",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminTenants.getAdminTenants(auth.email, auth.wid);
    res.json(json);
  })
);

router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminUsers.getAdminUsers(auth.email, auth.wid);
    res.json(json);
  })
);

router.get(
  "/usage",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminUsage.getAdminUsage(auth.email, auth.wid);
    res.json(json);
  })
);

router.get(
  "/fleet",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminFleet.getAdminFleet(auth.email, auth.wid);
    res.json(json);
  })
);

router.get(
  "/compliance",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminCompliance.getAdminCompliance(
      auth.email,
      auth.wid
    );
    res.json(json);
  })
);

router.get(
  "/moderation",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminModeration.getAdminModeration(
      auth.email,
      auth.wid
    );
    res.json(json);
  })
);

router.get(
  "/screen/:moduleId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await getAdminScreen(
      req.params.moduleId,
      auth.email,
      auth.wid
    );
    res.json(json);
  })
);

export { router as adminRouter };

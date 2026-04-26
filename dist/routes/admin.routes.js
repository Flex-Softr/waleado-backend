"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminRouter = void 0;
const express_1 = require("express");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const admin_overview_service_1 = require("../services/admin_overview.service");
const adminSubscriptions = __importStar(require("../services/admin_subscriptions.service"));
const adminBilling = __importStar(require("../services/admin_billing.service"));
const adminTenants = __importStar(require("../services/admin_tenants.service"));
const adminUsers = __importStar(require("../services/admin_users.service"));
const adminUsage = __importStar(require("../services/admin_usage.service"));
const adminFleet = __importStar(require("../services/admin_fleet.service"));
const adminCompliance = __importStar(require("../services/admin_compliance.service"));
const adminModeration = __importStar(require("../services/admin_moderation.service"));
const admin_screen_service_1 = require("../services/admin_screen.service");
const router = (0, express_1.Router)();
exports.adminRouter = router;
router.use(auth_1.requireAuth);
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res)).catch(next);
    };
}
function requireWorkspaceAdminRole(role) {
    if (role === "OWNER" || role === "ADMIN")
        return;
    throw new errors_1.AppError(403, "Admin requires workspace owner or admin", "FORBIDDEN");
}
router.get("/overview", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const overview = await (0, admin_overview_service_1.getAdminOverview)(auth.email, auth.wid);
    res.json(overview);
}));
router.get("/subscriptions", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminSubscriptions.getAdminSubscriptions(auth.email, auth.wid);
    res.json(json);
}));
router.get("/billing", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminBilling.getAdminBilling(auth.email, auth.wid);
    res.json(json);
}));
router.get("/tenants", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminTenants.getAdminTenants(auth.email, auth.wid);
    res.json(json);
}));
router.get("/users", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminUsers.getAdminUsers(auth.email, auth.wid);
    res.json(json);
}));
router.get("/usage", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminUsage.getAdminUsage(auth.email, auth.wid);
    res.json(json);
}));
router.get("/fleet", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminFleet.getAdminFleet(auth.email, auth.wid);
    res.json(json);
}));
router.get("/compliance", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminCompliance.getAdminCompliance(auth.email, auth.wid);
    res.json(json);
}));
router.get("/moderation", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await adminModeration.getAdminModeration(auth.email, auth.wid);
    res.json(json);
}));
router.get("/screen/:moduleId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth?.email || !auth.wid) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireWorkspaceAdminRole(auth.role);
    const json = await (0, admin_screen_service_1.getAdminScreen)(req.params.moduleId, auth.email, auth.wid);
    res.json(json);
}));

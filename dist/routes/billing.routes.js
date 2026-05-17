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
exports.billingRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const checkout_facade_1 = require("../payments/checkout.facade");
const billing = __importStar(require("../services/billing.service"));
const router = (0, express_1.Router)();
exports.billingRouter = router;
router.use(auth_1.requireAuth);
const checkoutBody = zod_1.z.object({
    planId: zod_1.z.enum(["pro", "business"]),
    gateway: zod_1.z.enum(["stripe", "sslcommerz"]).default("sslcommerz"),
    customerPhone: zod_1.z.string().max(32).optional(),
});
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res)).catch(next);
    };
}
router.get("/", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const data = await billing.getBillingForWorkspace(auth.wid);
    res.json(data);
}));
router.post("/checkout", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = checkoutBody.parse(req.body);
    const user = await prisma_1.prisma.user.findUnique({
        where: { id: auth.sub },
        select: { email: true, name: true },
    });
    if (!user) {
        throw new errors_1.AppError(404, "User not found", "NOT_FOUND");
    }
    const gateway = body.gateway;
    const customerPhone = body.customerPhone?.trim() ||
        (gateway === "sslcommerz" ? "01700000000" : "0000000000");
    const result = await (0, checkout_facade_1.initiatePaidCheckout)(gateway, {
        workspaceId: auth.wid,
        userEmail: user.email,
        userName: user.name,
        customerPhone,
        planId: body.planId,
    });
    if (result.kind === "demo") {
        res.json({ demo: true, planId: result.planId });
        return;
    }
    res.json({ url: result.url, gateway });
}));
router.get("/confirm", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
    if (!sessionId) {
        throw new errors_1.AppError(400, "session_id required", "VALIDATION");
    }
    const out = await billing.confirmCheckoutSession({
        workspaceId: auth.wid,
        sessionId,
    });
    res.json(out);
}));
router.post("/reset-to-free", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    await billing.resetWorkspaceToFree(auth.wid);
    res.status(204).send();
}));
router.post("/stripe-portal", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const out = await billing.createStripeCustomerPortalSession(auth.wid);
    res.json(out);
}));

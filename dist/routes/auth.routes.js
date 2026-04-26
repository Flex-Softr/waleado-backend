"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const zod_1 = require("zod");
const auth_service_1 = require("../services/auth.service");
const cookies_1 = require("../lib/cookies");
const auth_1 = require("../middleware/auth");
const errors_1 = require("../lib/errors");
const router = (0, express_1.Router)();
exports.authRouter = router;
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMIT", message: "Too many attempts" } },
});
const strictAuthLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 25,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMIT", message: "Too many attempts" } },
});
const registerSchema = zod_1.z.object({
    email: zod_1.z.string().email().max(255),
    password: zod_1.z
        .string()
        .min(10, "Password must be at least 10 characters")
        .max(128),
    name: zod_1.z.string().trim().max(120).optional(),
});
const loginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(1).max(128),
});
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res)).catch(next);
    };
}
router.post("/register", authLimiter, asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const prior = req.cookies[(0, cookies_1.getRefreshCookieName)()];
    if (prior) {
        await (0, auth_service_1.logoutSession)(prior);
    }
    const { rawRefresh, ...payload } = await (0, auth_service_1.registerUser)(body);
    (0, cookies_1.setRefreshCookie)(res, rawRefresh);
    res.status(201).json(payload);
}));
router.post("/login", strictAuthLimiter, asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const prior = req.cookies[(0, cookies_1.getRefreshCookieName)()];
    if (prior) {
        await (0, auth_service_1.logoutSession)(prior);
    }
    const { rawRefresh, ...payload } = await (0, auth_service_1.loginUser)(body);
    (0, cookies_1.setRefreshCookie)(res, rawRefresh);
    res.json(payload);
}));
router.post("/refresh", authLimiter, asyncHandler(async (req, res) => {
    const raw = req.cookies[(0, cookies_1.getRefreshCookieName)()];
    const { response, rawRefresh } = await (0, auth_service_1.refreshSession)(raw);
    (0, cookies_1.setRefreshCookie)(res, rawRefresh);
    res.json({
        user: response.user,
        workspace: response.workspace,
        accessToken: response.accessToken,
    });
}));
router.post("/logout", asyncHandler(async (req, res) => {
    const raw = req.cookies[(0, cookies_1.getRefreshCookieName)()];
    await (0, auth_service_1.logoutSession)(raw);
    (0, cookies_1.clearRefreshCookie)(res);
    res.status(204).send();
}));
router.post("/logout-all", auth_1.requireAuth, asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    await (0, auth_service_1.logoutAllSessions)(auth.sub);
    (0, cookies_1.clearRefreshCookie)(res);
    res.status(204).send();
}));
router.get("/me", auth_1.requireAuth, asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const me = await (0, auth_service_1.getMeForUser)(auth.sub, auth.wid);
    res.json(me);
}));

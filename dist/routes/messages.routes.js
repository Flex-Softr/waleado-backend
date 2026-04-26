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
exports.messagesRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const phone_1 = require("../lib/phone");
const messaging = __importStar(require("../services/messaging.service"));
const router = (0, express_1.Router)();
exports.messagesRouter = router;
router.use(auth_1.requireAuth);
const validatePhoneBody = zod_1.z.object({
    phone: zod_1.z.string(),
});
const singleSendSchema = zod_1.z.discriminatedUnion("kind", [
    zod_1.z.object({
        deviceId: zod_1.z.string().uuid(),
        toPhone: zod_1.z.string().min(3),
        kind: zod_1.z.literal("text"),
        bodyText: zod_1.z.string().min(1).max(4096),
    }),
    zod_1.z.object({
        deviceId: zod_1.z.string().uuid(),
        toPhone: zod_1.z.string().min(3),
        kind: zod_1.z.literal("template"),
        templateId: zod_1.z.string().uuid(),
    }),
]);
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res)).catch(next);
    };
}
router.post("/validate-phone", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = validatePhoneBody.parse(req.body);
    const result = (0, phone_1.validateAndFormatPhone)(body.phone);
    if (result.valid) {
        res.json({ valid: true, e164: result.e164 });
        return;
    }
    res.json({
        valid: false,
        e164: null,
        message: result.message,
    });
}));
router.post("/single", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = singleSendSchema.parse(req.body);
    const out = await messaging.sendSingleMessage(auth.wid, body);
    res.status(201).json(out);
}));

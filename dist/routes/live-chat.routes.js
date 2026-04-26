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
exports.liveChatRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const liveChat = __importStar(require("../services/live_chat.service"));
const template_media_assets_service_1 = require("../services/template-media-assets.service");
const live_chat_media_sign_service_1 = require("../services/live_chat_media_sign.service");
const router = (0, express_1.Router)();
exports.liveChatRouter = router;
router.get("/media/:assetId", asyncHandler(async (req, res) => {
    const { assetId } = zod_1.z.object({ assetId: zod_1.z.string().uuid() }).parse(req.params);
    const { wid, exp, sig } = zod_1.z
        .object({
        wid: zod_1.z.string().uuid(),
        exp: zod_1.z.string(),
        sig: zod_1.z.string().min(16),
    })
        .parse(req.query);
    const ok = (0, live_chat_media_sign_service_1.verifyLiveChatMediaToken)({ workspaceId: wid, assetId, exp, sig });
    if (!ok) {
        throw new errors_1.AppError(401, "Invalid or expired media token", "UNAUTHORIZED");
    }
    const result = await (0, template_media_assets_service_1.getAssetFilePath)(wid, assetId);
    if (!result) {
        throw new errors_1.AppError(404, "File not found", "NOT_FOUND");
    }
    res.setHeader("Content-Type", result.mimeType || "application/octet-stream");
    res.sendFile(result.absolutePath);
}));
router.use(auth_1.requireAuth);
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res)).catch(next);
    };
}
router.get("/threads", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { deviceId } = zod_1.z
        .object({ deviceId: zod_1.z.string().uuid() })
        .parse(req.query);
    const threads = await liveChat.listLiveChatThreads(auth.wid, deviceId);
    res.json({ threads });
}));
router.post("/threads", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = zod_1.z
        .object({
        deviceId: zod_1.z.string().uuid(),
        peerPhone: zod_1.z.string().min(3),
        peerLabel: zod_1.z.string().max(200).optional(),
    })
        .parse(req.body);
    const thread = await liveChat.createLiveChatThread(auth.wid, body);
    res.status(201).json({ thread });
}));
router.patch("/threads/:threadId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { threadId } = zod_1.z
        .object({ threadId: zod_1.z.string().uuid() })
        .parse(req.params);
    const body = zod_1.z
        .object({
        peerLabel: zod_1.z.string().max(200).optional(),
    })
        .refine((o) => Object.keys(o).length > 0, {
        message: "At least one field is required",
    })
        .parse(req.body);
    const thread = await liveChat.updateLiveChatThread(auth.wid, threadId, body);
    res.json({ thread });
}));
router.get("/threads/:threadId/messages", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { threadId } = zod_1.z
        .object({ threadId: zod_1.z.string().uuid() })
        .parse(req.params);
    const query = zod_1.z
        .object({
        cursor: zod_1.z.string().datetime().optional(),
        limit: zod_1.z.coerce.number().int().min(1).max(100).optional(),
    })
        .parse(req.query);
    const page = await liveChat.listLiveChatMessages(auth.wid, threadId, {
        cursor: query.cursor,
        limit: query.limit,
    });
    res.json(page);
}));
router.post("/threads/:threadId/messages", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { threadId } = zod_1.z
        .object({ threadId: zod_1.z.string().uuid() })
        .parse(req.params);
    const body = zod_1.z
        .object({
        bodyText: zod_1.z.string().max(4096).optional(),
        mediaAssetId: zod_1.z.string().uuid().optional(),
    })
        .refine((v) => Boolean(v.bodyText?.trim()) || Boolean(v.mediaAssetId), {
        message: "Message text or media is required",
    })
        .parse(req.body);
    const result = await liveChat.sendLiveChatMessage(auth.wid, threadId, { bodyText: body.bodyText, mediaAssetId: body.mediaAssetId });
    res.status(201).json(result);
}));

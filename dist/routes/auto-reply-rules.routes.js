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
exports.autoReplyRulesRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const autoReply = __importStar(require("../services/auto_reply_rules.service"));
const router = (0, express_1.Router)();
exports.autoReplyRulesRouter = router;
router.use(auth_1.requireAuth);
const triggerTypeSchema = zod_1.z.enum([
    "keyword",
    "exact",
    "contains",
    "starts_with",
    "ends_with",
    "regex",
]);
const messageModeSchema = zod_1.z.enum(["text", "template", "media"]);
const openAiSettingsSchema = zod_1.z
    .object({
    apiKey: zod_1.z.string().min(1),
    model: zod_1.z.string().optional(),
    baseUrl: zod_1.z.string().max(500).optional(),
    systemPrompt: zod_1.z.string().max(8000).optional(),
    temperature: zod_1.z.number().min(0).max(2).optional(),
    maxTokens: zod_1.z.number().int().positive().optional().nullable(),
    continuousChat: zod_1.z.boolean().optional(),
})
    .passthrough();
const createBody = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
    keyword: zod_1.z.string().min(1).max(8000),
    triggerType: triggerTypeSchema,
    caseSensitive: zod_1.z.boolean(),
    deviceId: zod_1.z.string().uuid(),
    priority: zod_1.z.number().int().min(0).max(1_000_000),
    cooldownMinutes: zod_1.z.number().int().min(0).max(10_080),
    messageMode: messageModeSchema,
    templateId: zod_1.z.string().uuid().optional().nullable(),
    mediaAssetId: zod_1.z.string().uuid().optional().nullable(),
    mediaCaption: zod_1.z.string().max(4096).optional().nullable(),
    response: zod_1.z.string().max(4096),
    openAiEnabled: zod_1.z.boolean(),
    openAiSettings: openAiSettingsSchema.optional().nullable(),
    active: zod_1.z.boolean(),
});
const patchBody = zod_1.z
    .object({
    name: zod_1.z.string().min(1).max(200).optional(),
    keyword: zod_1.z.string().min(1).max(8000).optional(),
    triggerType: triggerTypeSchema.optional(),
    caseSensitive: zod_1.z.boolean().optional(),
    deviceId: zod_1.z.string().uuid().optional(),
    priority: zod_1.z.number().int().min(0).max(1_000_000).optional(),
    cooldownMinutes: zod_1.z.number().int().min(0).max(10_080).optional(),
    messageMode: messageModeSchema.optional(),
    templateId: zod_1.z.string().uuid().optional().nullable(),
    mediaAssetId: zod_1.z.string().uuid().optional().nullable(),
    mediaCaption: zod_1.z.string().max(4096).optional().nullable(),
    response: zod_1.z.string().max(4096).optional(),
    openAiEnabled: zod_1.z.boolean().optional(),
    openAiSettings: openAiSettingsSchema.optional().nullable(),
    active: zod_1.z.boolean().optional(),
})
    .refine((o) => Object.keys(o).length > 0, {
    message: "At least one field is required",
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
    const rules = await autoReply.listAutoReplyRules(auth.wid);
    res.json({ rules });
}));
router.post("/", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = createBody.parse(req.body);
    const row = await autoReply.createAutoReplyRule(auth.wid, body);
    res.status(201).json({ rule: row });
}));
router.patch("/:ruleId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { ruleId } = zod_1.z.object({ ruleId: zod_1.z.string().uuid() }).parse(req.params);
    const body = patchBody.parse(req.body);
    const row = await autoReply.updateAutoReplyRule(auth.wid, ruleId, body);
    res.json({ rule: row });
}));
router.delete("/:ruleId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { ruleId } = zod_1.z.object({ ruleId: zod_1.z.string().uuid() }).parse(req.params);
    await autoReply.deleteAutoReplyRule(auth.wid, ruleId);
    res.status(204).send();
}));

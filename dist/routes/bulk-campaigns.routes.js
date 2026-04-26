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
exports.bulkCampaignsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const bulkCampaigns = __importStar(require("../services/bulk_campaigns.service"));
const uuidParam = zod_1.z.string().uuid();
const router = (0, express_1.Router)();
exports.bulkCampaignsRouter = router;
router.use(auth_1.requireAuth);
const createBody = zod_1.z
    .object({
    name: zod_1.z.string().min(1).max(200),
    deviceIds: zod_1.z.array(zod_1.z.string().uuid()).min(1).max(20),
    kind: zod_1.z.enum(["text", "template"]),
    bodyText: zod_1.z.string().max(4096).optional(),
    templateId: zod_1.z.string().uuid().optional(),
    selectionMode: zod_1.z.enum(["groups", "all_verified", "manual"]),
    groupIds: zod_1.z.array(zod_1.z.string().uuid()).max(100).optional(),
    manualPhones: zod_1.z.array(zod_1.z.string()).max(5000).optional(),
    attachmentType: zod_1.z
        .enum(["image", "video", "document", "audio"])
        .optional()
        .nullable(),
    attachmentAssetId: zod_1.z.string().uuid().optional().nullable(),
    scheduleType: zod_1.z.enum(["immediate", "scheduled"]),
    scheduledAt: zod_1.z.string().optional().nullable(),
    deviceMode: zod_1.z.enum(["single", "failover", "round_robin"]),
    delayMinSec: zod_1.z.number().int().min(0).max(3600),
    delayMaxSec: zod_1.z.number().int().min(0).max(3600),
    maxRetries: zod_1.z.number().int().min(0).max(10),
    antiBlock: zod_1.z
        .object({
        enabled: zod_1.z.boolean().optional(),
        spintax: zod_1.z.boolean().optional(),
        verifyNumbers: zod_1.z.boolean().optional(),
        repliedOnly: zod_1.z.boolean().optional(),
        recent24hOnly: zod_1.z.boolean().optional(),
        uniquenessMode: zod_1.z
            .enum(["none", "campaign", "workspace_window"])
            .optional(),
        batchPauseEvery: zod_1.z.number().int().min(1).max(5000).optional(),
        batchPauseSec: zod_1.z.number().int().min(1).max(3600).optional(),
        failLimitInRow: zod_1.z.number().int().min(1).max(1000).optional(),
        activeHoursStart: zod_1.z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .optional()
            .nullable(),
        activeHoursEnd: zod_1.z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .optional()
            .nullable(),
    })
        .optional(),
})
    .superRefine((data, ctx) => {
    if (data.kind === "text" && !(data.bodyText?.trim().length)) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "Message text is required",
            path: ["bodyText"],
        });
    }
    if (data.kind === "template" && !data.templateId) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "Template is required",
            path: ["templateId"],
        });
    }
    if (data.selectionMode === "groups" &&
        (!data.groupIds || data.groupIds.length === 0)) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "Select at least one group",
            path: ["groupIds"],
        });
    }
    if (data.selectionMode === "manual" &&
        (!data.manualPhones || data.manualPhones.length === 0)) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "Enter at least one phone number",
            path: ["manualPhones"],
        });
    }
    if (data.scheduleType === "scheduled" &&
        !(data.scheduledAt && data.scheduledAt.trim().length > 0)) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "Scheduled time is required",
            path: ["scheduledAt"],
        });
    }
    if (data.deviceMode === "single" && data.deviceIds.length !== 1) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "Select exactly one device for single-device mode",
            path: ["deviceIds"],
        });
    }
    if (data.antiBlock) {
        const hasStart = Boolean(data.antiBlock.activeHoursStart?.trim());
        const hasEnd = Boolean(data.antiBlock.activeHoursEnd?.trim());
        if (hasStart !== hasEnd) {
            ctx.addIssue({
                code: zod_1.z.ZodIssueCode.custom,
                message: "Both active-hours start and end are required",
                path: ["antiBlock", hasStart ? "activeHoursEnd" : "activeHoursStart"],
            });
        }
    }
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
    const list = await bulkCampaigns.listBulkCampaigns(auth.wid);
    res.json({ campaigns: list });
}));
router.get("/:id", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const parsed = uuidParam.safeParse(req.params.id);
    if (!parsed.success) {
        throw new errors_1.AppError(400, "Invalid campaign id", "VALIDATION");
    }
    const detail = await bulkCampaigns.getBulkCampaignDetail(auth.wid, parsed.data);
    res.json(detail);
}));
router.post("/", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = createBody.parse(req.body);
    const out = await bulkCampaigns.createBulkCampaign(auth.wid, {
        name: body.name,
        deviceIds: body.deviceIds,
        deviceMode: body.deviceMode,
        kind: body.kind,
        bodyText: body.bodyText,
        templateId: body.templateId,
        selectionMode: body.selectionMode,
        groupIds: body.groupIds,
        manualPhones: body.manualPhones,
        attachmentType: body.attachmentType,
        attachmentAssetId: body.attachmentAssetId,
        scheduleType: body.scheduleType,
        scheduledAt: body.scheduledAt,
        delayMinSec: body.delayMinSec,
        delayMaxSec: body.delayMaxSec,
        maxRetries: body.maxRetries,
        antiBlock: body.antiBlock,
    });
    res.status(201).json(out);
}));

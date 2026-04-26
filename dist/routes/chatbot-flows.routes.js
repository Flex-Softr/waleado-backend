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
exports.chatbotFlowsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const chatbotFlows = __importStar(require("../services/chatbot_flows.service"));
const router = (0, express_1.Router)();
exports.chatbotFlowsRouter = router;
router.use(auth_1.requireAuth);
const nodeKind = zod_1.z.enum(["message", "question", "action", "condition"]);
const nodeSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
    kind: nodeKind,
    sortOrder: zod_1.z.number().int().min(0),
    payload: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional().nullable(),
});
const createBody = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
    description: zod_1.z.string().max(2000).optional().default(""),
    deviceId: zod_1.z.string().uuid(),
    triggerKeywords: zod_1.z.string().min(1).max(1000),
    cooldownMinutes: zod_1.z.number().int().min(0).max(10080),
    active: zod_1.z.boolean(),
    nodes: zod_1.z.array(nodeSchema).max(100),
});
const patchBody = zod_1.z
    .object({
    name: zod_1.z.string().min(1).max(200).optional(),
    description: zod_1.z.string().max(2000).optional(),
    deviceId: zod_1.z.string().uuid().optional(),
    triggerKeywords: zod_1.z.string().min(1).max(1000).optional(),
    cooldownMinutes: zod_1.z.number().int().min(0).max(10080).optional(),
    active: zod_1.z.boolean().optional(),
    nodes: zod_1.z.array(nodeSchema).max(100).optional(),
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
    const flows = await chatbotFlows.listChatbotFlows(auth.wid);
    res.json({ flows });
}));
router.post("/", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = createBody.parse(req.body);
    const flow = await chatbotFlows.createChatbotFlow(auth.wid, body);
    res.status(201).json({ flow });
}));
router.patch("/:flowId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { flowId } = zod_1.z.object({ flowId: zod_1.z.string().uuid() }).parse(req.params);
    const body = patchBody.parse(req.body);
    const flow = await chatbotFlows.updateChatbotFlow(auth.wid, flowId, body);
    res.json({ flow });
}));
router.delete("/:flowId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { flowId } = zod_1.z.object({ flowId: zod_1.z.string().uuid() }).parse(req.params);
    await chatbotFlows.deleteChatbotFlow(auth.wid, flowId);
    res.status(204).send();
}));

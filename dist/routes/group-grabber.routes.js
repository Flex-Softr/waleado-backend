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
exports.groupGrabberRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const contacts = __importStar(require("../services/contacts.service"));
const grabber = __importStar(require("../services/group-grabber.service"));
const router = (0, express_1.Router)();
exports.groupGrabberRouter = router;
router.use(auth_1.requireAuth);
const scrapeBody = zod_1.z.object({
    groupJid: zod_1.z.string().min(5).max(120),
    /** When true, only non-admin participants are returned (for contact lists without admins). */
    excludeAdmins: zod_1.z.boolean().optional(),
});
const importBody = zod_1.z.object({
    targetContactGroupId: zod_1.z.string().uuid(),
    members: zod_1.z
        .array(zod_1.z.object({
        name: zod_1.z.string().max(200).optional(),
        phone: zod_1.z.string().min(3).max(32),
    }))
        .min(1)
        .max(2000),
});
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res)).catch(next);
    };
}
router.get("/devices/:deviceId/groups", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { deviceId } = zod_1.z.object({ deviceId: zod_1.z.string().uuid() }).parse(req.params);
    const out = await grabber.listWaGroupsForDevice(auth.wid, deviceId);
    res.json(out);
}));
router.post("/devices/:deviceId/scrape-members", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { deviceId } = zod_1.z.object({ deviceId: zod_1.z.string().uuid() }).parse(req.params);
    const body = scrapeBody.parse(req.body);
    const out = await grabber.scrapeGroupMembers(auth.wid, deviceId, body.groupJid, {
        excludeAdmins: body.excludeAdmins === true,
    });
    res.json(out);
}));
router.post("/import-members", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = importBody.parse(req.body);
    const out = await contacts.importMembersFromGrabber(auth.wid, body.targetContactGroupId, body.members.map((m) => ({
        name: m.name?.trim() || "Contact",
        phone: m.phone.trim(),
    })));
    res.status(201).json(out);
}));

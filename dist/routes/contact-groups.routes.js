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
exports.contactGroupsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const contacts = __importStar(require("../services/contacts.service"));
const router = (0, express_1.Router)();
exports.contactGroupsRouter = router;
router.use(auth_1.requireAuth);
const createGroupBody = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
});
const updateGroupBody = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
});
const createContactBody = zod_1.z.object({
    name: zod_1.z.string().max(200).optional(),
    phone: zod_1.z.string().min(3).max(32),
});
const bulkContactsBody = zod_1.z.object({
    lines: zod_1.z.array(zod_1.z.string().max(4096)).max(2000),
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
    const list = await contacts.listGroups(auth.wid);
    res.json({ groups: list });
}));
router.post("/", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = createGroupBody.parse(req.body);
    const g = await contacts.createGroup(auth.wid, body.name);
    res.status(201).json({ group: g });
}));
router.post("/actions/revalidate-phones", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const out = await contacts.revalidateAllContactsInWorkspace(auth.wid);
    res.json(out);
}));
router.get("/:groupId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = zod_1.z.object({ groupId: zod_1.z.string().uuid() }).parse(req.params);
    const detail = await contacts.getGroupDetail(auth.wid, groupId);
    res.json(detail);
}));
router.patch("/:groupId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = zod_1.z.object({ groupId: zod_1.z.string().uuid() }).parse(req.params);
    const body = updateGroupBody.parse(req.body);
    const g = await contacts.updateGroup(auth.wid, groupId, body.name);
    res.json({ group: g });
}));
router.delete("/:groupId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = zod_1.z.object({ groupId: zod_1.z.string().uuid() }).parse(req.params);
    await contacts.deleteGroup(auth.wid, groupId);
    res.status(204).send();
}));
router.post("/:groupId/contacts/bulk", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = zod_1.z.object({ groupId: zod_1.z.string().uuid() }).parse(req.params);
    const body = bulkContactsBody.parse(req.body);
    const out = await contacts.bulkCreateContacts(auth.wid, groupId, body.lines);
    res.status(201).json(out);
}));
router.post("/:groupId/contacts", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = zod_1.z.object({ groupId: zod_1.z.string().uuid() }).parse(req.params);
    const body = createContactBody.parse(req.body);
    const row = await contacts.createContact(auth.wid, groupId, {
        name: body.name ?? "Contact",
        phone: body.phone,
    });
    res.status(201).json({ contact: row });
}));
router.post("/:groupId/actions/remove-invalid", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = zod_1.z.object({ groupId: zod_1.z.string().uuid() }).parse(req.params);
    const out = await contacts.removeInvalidContactsInGroup(auth.wid, groupId);
    res.json(out);
}));
router.post("/:groupId/actions/revalidate-phones", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = zod_1.z.object({ groupId: zod_1.z.string().uuid() }).parse(req.params);
    const out = await contacts.revalidateContactsInGroup(auth.wid, groupId);
    res.json(out);
}));

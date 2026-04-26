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
exports.contactsRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const contacts = __importStar(require("../services/contacts.service"));
const router = (0, express_1.Router)();
exports.contactsRouter = router;
router.use(auth_1.requireAuth);
const updateContactBody = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200).optional(),
    phone: zod_1.z.string().min(3).max(32).optional(),
    status: zod_1.z.enum(["verified", "unverified", "invalid"]).optional(),
});
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res)).catch(next);
    };
}
router.patch("/:contactId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { contactId } = zod_1.z
        .object({ contactId: zod_1.z.string().uuid() })
        .parse(req.params);
    const body = updateContactBody.parse(req.body);
    const row = await contacts.updateContact(auth.wid, contactId, body);
    res.json({ contact: row });
}));
router.delete("/:contactId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { contactId } = zod_1.z
        .object({ contactId: zod_1.z.string().uuid() })
        .parse(req.params);
    await contacts.deleteContact(auth.wid, contactId);
    res.status(204).send();
}));

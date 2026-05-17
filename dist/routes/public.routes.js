"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicRouter = void 0;
const express_1 = require("express");
const pino_1 = __importDefault(require("pino"));
const zod_1 = require("zod");
const log = (0, pino_1.default)({ name: "public" });
const complaintBodySchema = zod_1.z.object({
    email: zod_1.z.string().email().max(320),
    name: zod_1.z
        .string()
        .max(120)
        .optional()
        .transform((s) => (s?.trim() ? s.trim() : undefined)),
    category: zod_1.z.enum(["billing", "technical", "account", "abuse", "other"]),
    subject: zod_1.z.string().trim().min(3).max(200),
    message: zod_1.z.string().trim().min(10).max(8000),
});
const router = (0, express_1.Router)();
exports.publicRouter = router;
router.post("/complaints", (req, res, next) => {
    try {
        const body = complaintBodySchema.parse(req.body);
        log.info({
            event: "public_complaint",
            email: body.email,
            name: body.name,
            category: body.category,
            subject: body.subject,
            messageLength: body.message.length,
            ip: req.ip,
        }, "Public complaint received");
        res.status(204).send();
    }
    catch (err) {
        next(err);
    }
});

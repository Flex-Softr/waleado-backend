"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRouter = void 0;
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const router = (0, express_1.Router)();
exports.healthRouter = router;
router.get("/health", (_req, res) => {
    res.json({ ok: true, service: "flexowhats-api" });
});
router.get("/ready", async (_req, res) => {
    try {
        await prisma_1.prisma.$queryRaw `SELECT 1`;
        res.json({ ok: true, db: true });
    }
    catch {
        res.status(503).json({ ok: false, db: false });
    }
});

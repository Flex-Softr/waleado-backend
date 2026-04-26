import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ ok: true, service: "flexowhats-api" });
});

router.get("/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: true });
  } catch {
    res.status(503).json({ ok: false, db: false });
  }
});

export { router as healthRouter };

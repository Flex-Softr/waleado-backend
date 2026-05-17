import { Router, type NextFunction, type Request, type Response } from "express";
import pino from "pino";
import { z } from "zod";

const log = pino({ name: "public" });

const complaintBodySchema = z.object({
  email: z.string().email().max(320),
  name: z
    .string()
    .max(120)
    .optional()
    .transform((s) => (s?.trim() ? s.trim() : undefined)),
  category: z.enum(["billing", "technical", "account", "abuse", "other"]),
  subject: z.string().trim().min(3).max(200),
  message: z.string().trim().min(10).max(8000),
});

const router = Router();

router.post("/complaints", (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = complaintBodySchema.parse(req.body);
    log.info(
      {
        event: "public_complaint",
        email: body.email,
        name: body.name,
        category: body.category,
        subject: body.subject,
        messageLength: body.message.length,
        ip: req.ip,
      },
      "Public complaint received"
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export { router as publicRouter };

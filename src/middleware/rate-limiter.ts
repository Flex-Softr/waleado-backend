import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import { env } from "../env";

/**
 * Global API rate limiter to protect against brute-force and DoS attacks.
 * Excludes health probes and external payment webhook callbacks.
 */
export const apiRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => {
    const path = req.originalUrl || req.url;
    // Exempt health probes and payment webhook callbacks from global rate limiting
    return (
      path === "/health" ||
      path === "/ready" ||
      path.startsWith("/v1/webhooks") ||
      path.startsWith("/v1/payments")
    );
  },
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests from this IP, please try again later.",
      },
    });
  },
});

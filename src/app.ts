import express from "express";
import cookieParser from "cookie-parser";
import { env } from "./env";
import {
  helmetMiddleware,
  corsMiddleware,
  hppMiddleware,
} from "./middleware/security";
import { apiRateLimiter } from "./middleware/rate-limiter";
import { morganLogger } from "./middleware/morgan";
import { healthRouter } from "./routes/health.routes";
import { webhookRouter } from "./routes/webhooks.routes";
import { apiRouter } from "./routes";
import { errorHandler } from "./middleware/error-handler";

const app = express();

// ==========================================
// 1. Server & Protocol Configuration
// ==========================================

// Hide Express banner for security obscurity
app.disable("x-powered-by");

/** Dynamic JSON API must not emit ETags: browsers send If-None-Match → 304, and fetch treats 304 as !ok so clients break. */
app.set("etag", false);

if (env.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

// ==========================================
// 2. Request Logging & Diagnostics
// ==========================================
app.use(morganLogger);

// ==========================================
// 3. Core Security Headers & Safeguards
// ==========================================
app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(hppMiddleware);

// ==========================================
// 4. Rate Limiting & Protection
// ==========================================
app.use(apiRateLimiter);

// ==========================================
// 5. Health & Readiness Probes (Root level)
// ==========================================
app.use(healthRouter);

// ==========================================
// 6. Webhooks & Payment Callbacks
// Must precede standard body parsers:
// - Stripe requires raw JSON buffer for signature verification
// - SSLCommerz requires urlencoded body parsing
// ==========================================
app.use("/v1", webhookRouter);

// ==========================================
// 7. Request Body Parsers & Cookies
// ==========================================
app.use(cookieParser());
app.use(express.json({ limit: env.HTTP_JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: env.HTTP_JSON_BODY_LIMIT }));

// ==========================================
// 8. API v1 Routes
// ==========================================
app.use("/v1", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, private");
  next();
});

app.use("/v1", apiRouter);

// ==========================================
// 9. 404 Catch-All Handler
// ==========================================
app.use((_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
});

// ==========================================
// 10. Global Error Handler
// ==========================================
app.use(errorHandler);

export { app };

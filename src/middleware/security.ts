import helmet from "helmet";
import cors from "cors";
import hpp from "hpp";
import { env } from "../env";

/**
 * Helmet enhances API security by setting HTTP response headers
 * (X-Content-Type-Options, Strict-Transport-Security, X-Frame-Options, etc.).
 */
export const helmetMiddleware = helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

/**
 * CORS configuration for allowed origins and headers.
 */
const origins = env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);
if (!origins.length && env.NODE_ENV === "production") {
  throw new Error("CORS_ORIGIN must be set to at least one origin in production");
}

export const corsMiddleware = cors({
  // Reflect-any with credentials is unsafe; only allow in non-production when unset.
  origin: origins.length ? origins : true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Client-Id",
    "X-Client-Secret",
  ],
});

/**
 * HPP (HTTP Parameter Pollution) middleware protects against parameter pollution attacks
 * where repeated query parameters can cause unintended server behaviors or bypass filters.
 */
export const hppMiddleware = hpp();

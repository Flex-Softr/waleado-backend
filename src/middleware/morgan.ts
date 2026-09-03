import morgan from "morgan";
import type { Request } from "express";
import { env } from "../env";

/**
 * Skip logging for health and readiness endpoints to keep application logs clean.
 */
const skipHealthChecks = (req: Request): boolean => {
  const path = req.originalUrl || req.url;
  return path === "/health" || path === "/ready";
};

/**
 * Morgan HTTP request logger configured for the active environment.
 * Uses 'dev' format for colored, concise output in local development,
 * and 'combined' (standard Apache combined log) in production.
 */
const logFormat =
  env.MORGAN_FORMAT || (env.NODE_ENV === "production" ? "combined" : "dev");

export const morganLogger = morgan(logFormat, {
  skip: skipHealthChecks,
});

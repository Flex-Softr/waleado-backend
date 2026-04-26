import type { NextFunction, Request, Response } from "express";
import {
  PrismaClientInitializationError,
  PrismaClientKnownRequestError,
} from "@prisma/client/runtime/library";
import { ZodError } from "zod";
import { AppError, isAppError } from "../lib/errors";

function isDatabaseUnreachable(err: unknown): boolean {
  if (err instanceof PrismaClientInitializationError) {
    return true;
  }
  if (err instanceof PrismaClientKnownRequestError) {
    return err.code === "P1001" || err.code === "P1017";
  }
  if (err instanceof Error) {
    const m = err.message;
    return (
      m.includes("Can't reach database server") ||
      m.includes("connect ECONNREFUSED") ||
      m.includes("Connection refused")
    );
  }
  return false;
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        details: err.flatten().fieldErrors,
      },
    });
    return;
  }

  if (isAppError(err)) {
    res.status(err.statusCode).json({
      error: {
        code: err.code ?? "ERROR",
        message: err.message,
      },
    });
    return;
  }

  if (isDatabaseUnreachable(err)) {
    res.status(503).json({
      error: {
        code: "DATABASE_UNAVAILABLE",
        message:
          "PostgreSQL is not reachable. Start a server on the host/port in DATABASE_URL (e.g. from the repo root: docker compose up -d), create the database if needed, run prisma migrate, and ensure DATABASE_URL in `.env` or `.env.local` matches (compose default: postgres/postgres@localhost:5432/flexowhats).",
      },
    });
    return;
  }

  console.error(err);
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
    },
  });
}

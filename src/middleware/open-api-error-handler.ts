import type { NextFunction, Request, Response } from "express";
import {
  PrismaClientInitializationError,
  PrismaClientKnownRequestError,
} from "@prisma/client/runtime/library";
import { ZodError } from "zod";
import { isAppError } from "../lib/errors";
import { openApiFail } from "../lib/open-api-response";

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

/** Error envelope for `/v1/open/*` — must be mounted on the open router. */
export function openApiErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    openApiFail(
      res,
      400,
      "Invalid request",
      "VALIDATION_ERROR",
      err.flatten().fieldErrors
    );
    return;
  }

  if (isAppError(err)) {
    openApiFail(
      res,
      err.statusCode,
      err.message,
      err.code ?? "ERROR"
    );
    return;
  }

  if (isDatabaseUnreachable(err)) {
    openApiFail(
      res,
      503,
      "Database is not reachable. Try again shortly.",
      "DATABASE_UNAVAILABLE"
    );
    return;
  }

  console.error(err);
  openApiFail(res, 500, "Something went wrong", "INTERNAL_ERROR");
}

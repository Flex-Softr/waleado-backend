"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
const library_1 = require("@prisma/client/runtime/library");
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
function isDatabaseUnreachable(err) {
    if (err instanceof library_1.PrismaClientInitializationError) {
        return true;
    }
    if (err instanceof library_1.PrismaClientKnownRequestError) {
        return err.code === "P1001" || err.code === "P1017";
    }
    if (err instanceof Error) {
        const m = err.message;
        return (m.includes("Can't reach database server") ||
            m.includes("connect ECONNREFUSED") ||
            m.includes("Connection refused"));
    }
    return false;
}
function errorHandler(err, _req, res, _next) {
    if (err instanceof zod_1.ZodError) {
        res.status(400).json({
            error: {
                code: "VALIDATION_ERROR",
                message: "Invalid request",
                details: err.flatten().fieldErrors,
            },
        });
        return;
    }
    if ((0, errors_1.isAppError)(err)) {
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
                message: "PostgreSQL is not reachable. Start a server on the host/port in DATABASE_URL (e.g. from the repo root: docker compose up -d), create the database if needed, run prisma migrate, and ensure DATABASE_URL in `.env` or `.env.local` matches (compose default: postgres/postgres@localhost:5432/flexowhats).",
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

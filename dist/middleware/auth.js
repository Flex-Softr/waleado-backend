"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const jwt_1 = require("../lib/jwt");
const errors_1 = require("../lib/errors");
function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        next(new errors_1.AppError(401, "Missing or invalid authorization header", "UNAUTHORIZED"));
        return;
    }
    const token = header.slice("Bearer ".length).trim();
    if (!token) {
        next(new errors_1.AppError(401, "Missing access token", "UNAUTHORIZED"));
        return;
    }
    try {
        req.auth = (0, jwt_1.verifyAccessToken)(token);
        next();
    }
    catch {
        next(new errors_1.AppError(401, "Invalid or expired access token", "TOKEN_INVALID"));
    }
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signAccessToken = signAccessToken;
exports.verifyAccessToken = verifyAccessToken;
const crypto_1 = require("crypto");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../env");
function signAccessToken(payload) {
    const jti = payload.jti ?? (0, crypto_1.randomUUID)();
    const body = {
        sub: payload.sub,
        email: payload.email,
        wid: payload.wid,
        role: payload.role,
        jti,
    };
    const options = {
        expiresIn: env_1.env.JWT_ACCESS_EXPIRES_IN,
        issuer: "flexowhats-api",
        audience: "flexowhats-app",
    };
    return jsonwebtoken_1.default.sign(body, env_1.env.JWT_ACCESS_SECRET, options);
}
function verifyAccessToken(token) {
    const decoded = jsonwebtoken_1.default.verify(token, env_1.env.JWT_ACCESS_SECRET, {
        issuer: "flexowhats-api",
        audience: "flexowhats-app",
    });
    if (typeof decoded === "string" || !decoded.sub) {
        throw new Error("Invalid token payload");
    }
    return decoded;
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateRefreshToken = generateRefreshToken;
exports.hashRefreshToken = hashRefreshToken;
const crypto_1 = require("crypto");
function generateRefreshToken() {
    return (0, crypto_1.randomBytes)(48).toString("base64url");
}
function hashRefreshToken(raw) {
    return (0, crypto_1.createHash)("sha256").update(raw).digest("hex");
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLiveChatMediaToken = createLiveChatMediaToken;
exports.verifyLiveChatMediaToken = verifyLiveChatMediaToken;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../env");
const SIGN_TTL_SEC = 15 * 60;
function signRaw(value) {
    return crypto_1.default
        .createHmac("sha256", env_1.env.JWT_ACCESS_SECRET)
        .update(value)
        .digest("hex");
}
function createLiveChatMediaToken(input) {
    const exp = Math.floor(Date.now() / 1000) + (input.ttlSec ?? SIGN_TTL_SEC);
    const payload = `${input.workspaceId}:${input.assetId}:${exp}`;
    return { exp: String(exp), sig: signRaw(payload) };
}
function verifyLiveChatMediaToken(input) {
    const expNum = Number(input.exp);
    if (!Number.isFinite(expNum) || expNum <= Math.floor(Date.now() / 1000)) {
        return false;
    }
    const payload = `${input.workspaceId}:${input.assetId}:${input.exp}`;
    const expected = signRaw(payload);
    return crypto_1.default.timingSafeEqual(Buffer.from(expected), Buffer.from(input.sig));
}

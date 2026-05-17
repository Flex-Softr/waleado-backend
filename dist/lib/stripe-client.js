"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStripe = getStripe;
const stripe_1 = __importDefault(require("stripe"));
const env_1 = require("../env");
function getStripe() {
    const key = env_1.env.STRIPE_SECRET_KEY?.trim();
    if (!key)
        return null;
    return new stripe_1.default(key);
}

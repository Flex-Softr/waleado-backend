"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStripe = getStripe;
const stripe_1 = __importDefault(require("stripe"));
const env_1 = require("../env");
function getStripe() {
    if (!env_1.env.STRIPE_SECRET_KEY)
        return null;
    return new stripe_1.default(env_1.env.STRIPE_SECRET_KEY);
}

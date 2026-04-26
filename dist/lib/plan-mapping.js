"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planToApi = planToApi;
exports.apiPaidPlanToDb = apiPaidPlanToDb;
exports.priceIdToPlan = priceIdToPlan;
const client_1 = require("@prisma/client");
const env_1 = require("../env");
function planToApi(p) {
    switch (p) {
        case client_1.Plan.FREE:
            return "free";
        case client_1.Plan.PRO:
            return "pro";
        case client_1.Plan.BUSINESS:
            return "business";
        default:
            return "free";
    }
}
function apiPaidPlanToDb(id) {
    if (id === "pro")
        return client_1.Plan.PRO;
    return client_1.Plan.BUSINESS;
}
function priceIdToPlan(priceId) {
    if (env_1.env.STRIPE_PRICE_PRO_MONTHLY && priceId === env_1.env.STRIPE_PRICE_PRO_MONTHLY) {
        return client_1.Plan.PRO;
    }
    if (env_1.env.STRIPE_PRICE_BUSINESS_MONTHLY &&
        priceId === env_1.env.STRIPE_PRICE_BUSINESS_MONTHLY) {
        return client_1.Plan.BUSINESS;
    }
    return null;
}

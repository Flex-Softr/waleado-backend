"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planToApi = planToApi;
exports.apiPaidPlanToDb = apiPaidPlanToDb;
const client_1 = require("@prisma/client");
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

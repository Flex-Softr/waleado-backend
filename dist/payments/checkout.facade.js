"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initiatePaidCheckout = initiatePaidCheckout;
const errors_1 = require("../lib/errors");
const stripe_client_1 = require("../lib/stripe-client");
const billing_service_1 = require("../services/billing.service");
const stripe_checkout_1 = require("./stripe/stripe-checkout");
const sslcommerz_checkout_1 = require("./sslcommerz/sslcommerz-checkout");
/**
 * Entry point for plan upgrades: picks the right provider (strategy) by gateway id.
 */
async function initiatePaidCheckout(gateway, input) {
    if (gateway === "sslcommerz") {
        if (!(0, sslcommerz_checkout_1.sslCommerzConfigured)()) {
            throw new errors_1.AppError(503, "SSLCommerz is not configured (set SSLCOMMERZ_STORE_ID and SSLCOMMERZ_STORE_PASSWORD)", "SSLCOMMERZ_NOT_CONFIGURED");
        }
        const { url } = await (0, sslcommerz_checkout_1.initiateSslCommerzCheckout)(input);
        return { kind: "redirect", url };
    }
    if (gateway === "stripe") {
        if (!(0, stripe_client_1.getStripe)()) {
            const planId = await (0, billing_service_1.applyDemoPlan)(input.workspaceId, input.planId);
            return { kind: "demo", planId: planId };
        }
        const { url } = await (0, stripe_checkout_1.createStripeCheckoutSession)({
            workspaceId: input.workspaceId,
            userEmail: input.userEmail,
            planId: input.planId,
        });
        return { kind: "redirect", url };
    }
    const _exhaustive = gateway;
    return _exhaustive;
}

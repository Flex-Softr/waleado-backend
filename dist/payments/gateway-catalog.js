"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPaymentGateways = listPaymentGateways;
const env_1 = require("../env");
const sslcommerz_checkout_1 = require("./sslcommerz/sslcommerz-checkout");
function stripeConfigured() {
    return Boolean(env_1.env.STRIPE_SECRET_KEY?.trim() &&
        env_1.env.STRIPE_PRICE_PRO_MONTHLY?.trim() &&
        env_1.env.STRIPE_PRICE_BUSINESS_MONTHLY?.trim());
}
/**
 * Gateways shown in the billing UI. Add new providers here as you implement them.
 */
function listPaymentGateways() {
    return [
        {
            id: "sslcommerz",
            displayName: "SSLCommerz",
            description: "Hosted checkout — cards, mobile & internet banking (popular in Bangladesh).",
            configured: (0, sslcommerz_checkout_1.sslCommerzConfigured)(),
        },
        {
            id: "stripe",
            displayName: "Stripe",
            description: "Subscription checkout with Stripe (cards).",
            configured: stripeConfigured(),
        },
    ];
}

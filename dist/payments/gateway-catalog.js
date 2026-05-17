"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPaymentGateways = listPaymentGateways;
const env_1 = require("../env");
const sslcommerz_checkout_1 = require("./sslcommerz/sslcommerz-checkout");
const stripe_price_ref_1 = require("./stripe/stripe-price-ref");
function stripeConfigured() {
    return Boolean(env_1.env.STRIPE_SECRET_KEY?.trim() &&
        (0, stripe_price_ref_1.isStripeLineItemEnvReference)(env_1.env.STRIPE_PRICE_PRO_MONTHLY) &&
        (0, stripe_price_ref_1.isStripeLineItemEnvReference)(env_1.env.STRIPE_PRICE_BUSINESS_MONTHLY));
}
function stripeGatewayDescription() {
    if (stripeConfigured()) {
        return "Subscription checkout with Stripe (cards).";
    }
    const secret = Boolean(env_1.env.STRIPE_SECRET_KEY?.trim());
    const proRaw = env_1.env.STRIPE_PRICE_PRO_MONTHLY?.trim();
    const bizRaw = env_1.env.STRIPE_PRICE_BUSINESS_MONTHLY?.trim();
    if (secret) {
        if (!proRaw || !bizRaw) {
            return "Stripe secret key is set; add STRIPE_PRICE_PRO_MONTHLY and STRIPE_PRICE_BUSINESS_MONTHLY (each a price_… id, prod_… with default price, or a positive decimal amount with STRIPE_CURRENCY).";
        }
        if (!(0, stripe_price_ref_1.isStripeLineItemEnvReference)(proRaw) ||
            !(0, stripe_price_ref_1.isStripeLineItemEnvReference)(bizRaw)) {
            return "STRIPE_PRICE_* must be a Stripe Price id (price_…), Product id (prod_…), or a positive decimal amount (major units).";
        }
    }
    return "Subscription checkout with Stripe (cards). Set STRIPE_SECRET_KEY plus both line items (price_…, prod_…, or decimal amount).";
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
            description: stripeGatewayDescription(),
            configured: stripeConfigured(),
        },
    ];
}

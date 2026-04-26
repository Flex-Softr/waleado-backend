"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripeCheckoutConfigured = stripeCheckoutConfigured;
exports.createStripeCheckoutSession = createStripeCheckoutSession;
const env_1 = require("../../env");
const stripe_client_1 = require("../../lib/stripe-client");
const errors_1 = require("../../lib/errors");
const client_1 = require("@prisma/client");
const plan_mapping_1 = require("../../lib/plan-mapping");
function appPublicBase() {
    return env_1.env.APP_PUBLIC_URL.replace(/\/$/, "");
}
function stripeCheckoutConfigured() {
    return Boolean((0, stripe_client_1.getStripe)() && env_1.env.STRIPE_PRICE_PRO_MONTHLY && env_1.env.STRIPE_PRICE_BUSINESS_MONTHLY);
}
async function createStripeCheckoutSession(input) {
    const stripe = (0, stripe_client_1.getStripe)();
    if (!stripe) {
        throw new errors_1.AppError(503, "Stripe is not configured", "STRIPE_NOT_CONFIGURED");
    }
    const plan = (0, plan_mapping_1.apiPaidPlanToDb)(input.planId);
    const priceEnv = plan === client_1.Plan.PRO
        ? env_1.env.STRIPE_PRICE_PRO_MONTHLY
        : env_1.env.STRIPE_PRICE_BUSINESS_MONTHLY;
    if (!priceEnv) {
        throw new errors_1.AppError(500, "Stripe is configured but the price ID env var for this plan is missing", "PRICE_NOT_CONFIGURED");
    }
    const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        customer_email: input.userEmail,
        line_items: [{ price: priceEnv, quantity: 1 }],
        success_url: `${appPublicBase()}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appPublicBase()}/billing?canceled=1`,
        client_reference_id: input.workspaceId,
        metadata: {
            workspaceId: input.workspaceId,
            planId: input.planId,
        },
        subscription_data: {
            metadata: {
                workspaceId: input.workspaceId,
                planId: input.planId,
            },
        },
        allow_promotion_codes: true,
    });
    if (!session.url) {
        throw new errors_1.AppError(500, "Checkout session missing URL", "STRIPE_ERROR");
    }
    return { url: session.url };
}

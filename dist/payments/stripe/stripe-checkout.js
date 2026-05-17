"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripeCheckoutConfigured = stripeCheckoutConfigured;
exports.createStripeCheckoutSession = createStripeCheckoutSession;
const stripe_1 = __importDefault(require("stripe"));
const client_1 = require("@prisma/client");
const env_1 = require("../../env");
const stripe_client_1 = require("../../lib/stripe-client");
const errors_1 = require("../../lib/errors");
const plan_mapping_1 = require("../../lib/plan-mapping");
const stripe_price_ref_1 = require("./stripe-price-ref");
function appPublicBase() {
    return env_1.env.APP_PUBLIC_URL.replace(/\/$/, "");
}
function stripeCheckoutConfigured() {
    return Boolean((0, stripe_client_1.getStripe)() &&
        (0, stripe_price_ref_1.isStripeLineItemEnvReference)(env_1.env.STRIPE_PRICE_PRO_MONTHLY) &&
        (0, stripe_price_ref_1.isStripeLineItemEnvReference)(env_1.env.STRIPE_PRICE_BUSINESS_MONTHLY));
}
async function createStripeCheckoutSession(input) {
    const stripe = (0, stripe_client_1.getStripe)();
    if (!stripe) {
        throw new errors_1.AppError(503, "Stripe is not configured", "STRIPE_NOT_CONFIGURED");
    }
    const plan = (0, plan_mapping_1.apiPaidPlanToDb)(input.planId);
    const raw = plan === client_1.Plan.PRO
        ? env_1.env.STRIPE_PRICE_PRO_MONTHLY?.trim()
        : env_1.env.STRIPE_PRICE_BUSINESS_MONTHLY?.trim();
    if (!raw) {
        throw new errors_1.AppError(500, "Stripe is configured but the price ID env var for this plan is missing", "PRICE_NOT_CONFIGURED");
    }
    const priceEnvName = plan === client_1.Plan.PRO
        ? "STRIPE_PRICE_PRO_MONTHLY"
        : "STRIPE_PRICE_BUSINESS_MONTHLY";
    const productName = plan === client_1.Plan.PRO ? "Pro (monthly)" : "Business (monthly)";
    const lineItem = await (0, stripe_price_ref_1.resolveStripeCheckoutLineItem)(stripe, raw, priceEnvName, productName, env_1.env.STRIPE_CURRENCY);
    try {
        const session = await stripe.checkout.sessions.create({
            mode: "subscription",
            payment_method_types: ["card"],
            customer_email: input.userEmail.trim(),
            line_items: [lineItem],
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
    catch (e) {
        if (e instanceof errors_1.AppError)
            throw e;
        if (e instanceof stripe_1.default.errors.StripeError) {
            const isClient = e instanceof stripe_1.default.errors.StripeInvalidRequestError ||
                e instanceof stripe_1.default.errors.StripeCardError;
            console.error("[stripe checkout]", e.type, e.code, e.message);
            const hint = e.code === "resource_missing" && e.message.includes("price")
                ? " Confirm STRIPE_SECRET_KEY is test-mode if your prices are in test mode (or live/live), and that the price id exists on the same Stripe account."
                : "";
            throw new errors_1.AppError(isClient ? 400 : 502, `${e.message}${hint}`, e.code ?? "STRIPE_ERROR");
        }
        throw e;
    }
}

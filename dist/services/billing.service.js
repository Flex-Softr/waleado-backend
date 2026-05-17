"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBillingForWorkspace = getBillingForWorkspace;
exports.createStripeCustomerPortalSession = createStripeCustomerPortalSession;
exports.applyDemoPlan = applyDemoPlan;
exports.resetWorkspaceToFree = resetWorkspaceToFree;
exports.confirmCheckoutSession = confirmCheckoutSession;
exports.syncWorkspaceFromSubscription = syncWorkspaceFromSubscription;
exports.handleSubscriptionDeleted = handleSubscriptionDeleted;
const stripe_1 = __importDefault(require("stripe"));
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const errors_1 = require("../lib/errors");
const env_1 = require("../env");
const stripe_client_1 = require("../lib/stripe-client");
const gateway_catalog_1 = require("../payments/gateway-catalog");
const plan_mapping_1 = require("../lib/plan-mapping");
const stripe_price_ref_1 = require("../payments/stripe/stripe-price-ref");
const ACTIVE = new Set(["active", "trialing", "past_due"]);
function appPublicBase() {
    return env_1.env.APP_PUBLIC_URL.replace(/\/$/, "");
}
async function getBillingForWorkspace(workspaceId) {
    const ws = await prisma_1.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
            plan: true,
            subscriptionStatus: true,
            currentPeriodEnd: true,
            stripeCustomerId: true,
            stripeSubscriptionId: true,
            lastPaymentGateway: true,
        },
    });
    if (!ws) {
        throw new errors_1.AppError(404, "Workspace not found", "NOT_FOUND");
    }
    const stripePortalEligible = Boolean(ws.stripeCustomerId &&
        ws.lastPaymentGateway === "stripe" &&
        ws.stripeSubscriptionId);
    return {
        planId: (0, plan_mapping_1.planToApi)(ws.plan),
        subscriptionStatus: ws.subscriptionStatus,
        currentPeriodEnd: ws.currentPeriodEnd?.toISOString() ?? null,
        stripeConfigured: Boolean(env_1.env.STRIPE_SECRET_KEY),
        stripePortalEligible,
        paymentGateways: (0, gateway_catalog_1.listPaymentGateways)(),
    };
}
/**
 * Opens Stripe Customer Portal (cancel, payment method, invoices) for workspaces
 * that subscribed through Stripe checkout.
 */
async function createStripeCustomerPortalSession(workspaceId) {
    const stripe = (0, stripe_client_1.getStripe)();
    if (!stripe) {
        throw new errors_1.AppError(503, "Stripe is not configured", "STRIPE_NOT_CONFIGURED");
    }
    const ws = await prisma_1.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
            stripeCustomerId: true,
            lastPaymentGateway: true,
            stripeSubscriptionId: true,
        },
    });
    if (!ws?.stripeCustomerId) {
        throw new errors_1.AppError(400, "No Stripe billing profile for this workspace. Complete a Stripe checkout first.", "STRIPE_NO_CUSTOMER");
    }
    if (ws.lastPaymentGateway !== "stripe" || !ws.stripeSubscriptionId) {
        throw new errors_1.AppError(400, "The customer portal is only available for active Stripe subscriptions.", "STRIPE_PORTAL_UNSUPPORTED");
    }
    try {
        const session = await stripe.billingPortal.sessions.create({
            customer: ws.stripeCustomerId,
            return_url: `${appPublicBase()}/billing`,
        });
        if (!session.url) {
            throw new errors_1.AppError(500, "Portal session missing URL", "STRIPE_ERROR");
        }
        return { url: session.url };
    }
    catch (e) {
        if (e instanceof errors_1.AppError)
            throw e;
        const msg = e instanceof stripe_1.default.errors.StripeError
            ? e.message
            : "Could not open Stripe billing portal";
        console.error("[billing] stripe portal session", e);
        throw new errors_1.AppError(502, `${msg} If this is a new account, enable the Customer Portal in the Stripe Dashboard (Settings → Billing → Customer portal).`, "STRIPE_PORTAL_FAILED");
    }
}
async function applyDemoPlan(workspaceId, planId) {
    const plan = (0, plan_mapping_1.apiPaidPlanToDb)(planId);
    await prisma_1.prisma.workspace.update({
        where: { id: workspaceId },
        data: {
            plan,
            subscriptionStatus: "demo",
            stripeSubscriptionId: null,
            currentPeriodEnd: null,
            lastPaymentGateway: null,
        },
    });
    return planId;
}
async function resetWorkspaceToFree(workspaceId) {
    const ws = await prisma_1.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
            stripeSubscriptionId: true,
            subscriptionStatus: true,
            lastPaymentGateway: true,
            plan: true,
            currentPeriodEnd: true,
        },
    });
    if (!ws) {
        throw new errors_1.AppError(404, "Workspace not found", "NOT_FOUND");
    }
    if (ws.stripeSubscriptionId &&
        ws.subscriptionStatus &&
        ACTIVE.has(ws.subscriptionStatus)) {
        throw new errors_1.AppError(400, "Cancel your subscription in Stripe before downgrading here, or use the customer portal.", "SUBSCRIPTION_ACTIVE");
    }
    const now = new Date();
    if (ws.lastPaymentGateway === "sslcommerz" &&
        ws.plan !== client_1.Plan.FREE &&
        ws.currentPeriodEnd &&
        ws.currentPeriodEnd > now &&
        ws.subscriptionStatus === "active") {
        throw new errors_1.AppError(400, "Your paid period through SSLCommerz is still active. Wait until it ends or contact support.", "PAID_PERIOD_ACTIVE");
    }
    await prisma_1.prisma.workspace.update({
        where: { id: workspaceId },
        data: {
            plan: client_1.Plan.FREE,
            subscriptionStatus: null,
            stripeSubscriptionId: null,
            currentPeriodEnd: null,
            lastPaymentGateway: null,
        },
    });
}
async function confirmCheckoutSession(input) {
    const stripe = (0, stripe_client_1.getStripe)();
    if (!stripe) {
        const b = await getBillingForWorkspace(input.workspaceId);
        return { planId: b.planId, demo: true };
    }
    const session = await stripe.checkout.sessions.retrieve(input.sessionId, {
        expand: ["subscription"],
    });
    if (session.client_reference_id !== input.workspaceId) {
        const metaWs = session.metadata?.workspaceId;
        if (metaWs !== input.workspaceId) {
            throw new errors_1.AppError(403, "Session does not belong to this workspace", "FORBIDDEN");
        }
    }
    if (session.status !== "complete") {
        throw new errors_1.AppError(400, "Checkout not complete", "CHECKOUT_INCOMPLETE");
    }
    const subRaw = session.subscription;
    const subscription = typeof subRaw === "string"
        ? await stripe.subscriptions.retrieve(subRaw)
        : subRaw;
    if (!subscription) {
        throw new errors_1.AppError(400, "No subscription on session", "NO_SUBSCRIPTION");
    }
    await syncWorkspaceFromSubscription(subscription);
    const ws = await prisma_1.prisma.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { plan: true },
    });
    return {
        planId: (ws ? (0, plan_mapping_1.planToApi)(ws.plan) : "free"),
        demo: false,
    };
}
async function syncWorkspaceFromSubscription(subscription) {
    const workspaceId = subscription.metadata?.workspaceId ??
        (await prisma_1.prisma.workspace.findFirst({
            where: { stripeSubscriptionId: subscription.id },
            select: { id: true },
        }))?.id;
    if (!workspaceId) {
        console.warn("[billing] subscription without workspace mapping", subscription.id);
        return;
    }
    const item = subscription.items.data[0];
    const priceId = item?.price?.id;
    const stripe = (0, stripe_client_1.getStripe)();
    const mappedPlan = priceId && stripe
        ? await (0, stripe_price_ref_1.matchSubscriptionPriceToPlan)(stripe, priceId)
        : null;
    const plan = mappedPlan ??
        (subscription.metadata?.planId === "business"
            ? client_1.Plan.BUSINESS
            : subscription.metadata?.planId === "pro"
                ? client_1.Plan.PRO
                : null);
    if (!plan) {
        console.warn("[billing] unknown price for subscription", subscription.id, priceId);
        return;
    }
    const customerId = typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id;
    await prisma_1.prisma.workspace.update({
        where: { id: workspaceId },
        data: {
            plan,
            stripeSubscriptionId: subscription.id,
            stripeCustomerId: customerId ?? undefined,
            subscriptionStatus: subscription.status,
            currentPeriodEnd: new Date(subscription.current_period_end * 1000),
            lastPaymentGateway: "stripe",
        },
    });
}
async function handleSubscriptionDeleted(subscription) {
    const workspaceId = subscription.metadata?.workspaceId ??
        (await prisma_1.prisma.workspace.findFirst({
            where: { stripeSubscriptionId: subscription.id },
            select: { id: true },
        }))?.id;
    if (!workspaceId)
        return;
    await prisma_1.prisma.workspace.update({
        where: { id: workspaceId },
        data: {
            plan: client_1.Plan.FREE,
            stripeSubscriptionId: null,
            subscriptionStatus: "canceled",
            currentPeriodEnd: null,
            lastPaymentGateway: null,
        },
    });
}

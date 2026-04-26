"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripeWebhookHandler = stripeWebhookHandler;
const client_1 = require("@prisma/client");
const env_1 = require("../env");
const prisma_1 = require("../lib/prisma");
const stripe_client_1 = require("../lib/stripe-client");
const billing_service_1 = require("../services/billing.service");
async function stripeWebhookHandler(req, res) {
    const stripe = (0, stripe_client_1.getStripe)();
    if (!stripe || !env_1.env.STRIPE_WEBHOOK_SECRET) {
        res
            .status(503)
            .json({ error: "Stripe webhooks are not configured on this server" });
        return;
    }
    const sig = req.headers["stripe-signature"];
    if (typeof sig !== "string") {
        res.status(400).json({ error: "Missing stripe-signature" });
        return;
    }
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
        res.status(400).json({ error: "Expected raw body" });
        return;
    }
    let event;
    try {
        event = stripe.webhooks.constructEvent(rawBody, sig, env_1.env.STRIPE_WEBHOOK_SECRET);
    }
    catch (err) {
        console.error("[stripe webhook] signature verification failed", err);
        res.status(400).json({ error: "Invalid signature" });
        return;
    }
    let inserted = false;
    try {
        await prisma_1.prisma.stripeEventLog.create({
            data: { stripeEventId: event.id, type: event.type },
        });
        inserted = true;
    }
    catch (e) {
        if (e instanceof client_1.Prisma.PrismaClientKnownRequestError &&
            e.code === "P2002") {
            res.json({ received: true, duplicate: true });
            return;
        }
        throw e;
    }
    try {
        switch (event.type) {
            case "checkout.session.completed": {
                const session = event.data.object;
                if (session.mode === "subscription" && session.subscription) {
                    const subId = typeof session.subscription === "string"
                        ? session.subscription
                        : session.subscription.id;
                    const sub = await stripe.subscriptions.retrieve(subId);
                    await (0, billing_service_1.syncWorkspaceFromSubscription)(sub);
                }
                break;
            }
            case "customer.subscription.created":
            case "customer.subscription.updated": {
                const sub = event.data.object;
                await (0, billing_service_1.syncWorkspaceFromSubscription)(sub);
                break;
            }
            case "customer.subscription.deleted": {
                const sub = event.data.object;
                await (0, billing_service_1.handleSubscriptionDeleted)(sub);
                break;
            }
            default:
                break;
        }
        res.json({ received: true });
    }
    catch (e) {
        if (inserted) {
            await prisma_1.prisma.stripeEventLog
                .deleteMany({ where: { stripeEventId: event.id } })
                .catch(() => {
                /* best effort */
            });
        }
        console.error("[stripe webhook] handler error", event.type, e);
        res.status(500).json({ error: "Webhook handler failed" });
    }
}

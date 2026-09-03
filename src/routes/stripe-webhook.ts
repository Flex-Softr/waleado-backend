import type { Request, Response } from "express";
import type Stripe from "stripe";
import { Prisma, NotificationAudience, NotificationType } from "@prisma/client";
import { env } from "../env";
import { prisma } from "../lib/prisma";
import { getStripe } from "../lib/stripe-client";
import {
  handleSubscriptionDeleted,
  syncWorkspaceFromSubscription,
} from "../services/billing.service";
import { createNotification } from "../services/notifications.service";

export async function stripeWebhookHandler(
  req: Request,
  res: Response
): Promise<void> {
  const stripe = getStripe();
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
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

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("[stripe webhook] signature verification failed", err);
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  let inserted = false;
  try {
    await prisma.stripeEventLog.create({
      data: { stripeEventId: event.id, type: event.type },
    });
    inserted = true;
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      res.json({ received: true, duplicate: true });
      return;
    }
    throw e;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "subscription" && session.subscription) {
          const subId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          await syncWorkspaceFromSubscription(sub);

          const total = session.amount_total != null ? (session.amount_total / 100).toFixed(2) : "";
          const curr = (session.currency ?? "usd").toUpperCase();
          const customerEmail = session.customer_details?.email ?? session.customer_email ?? "";

          void createNotification({
            audience: NotificationAudience.ADMIN,
            type: NotificationType.PAYMENT_RECEIVED,
            title: `Stripe Payment: ${curr} ${total}`,
            message: `New subscription payment confirmed${customerEmail ? ` from ${customerEmail}` : ""}.`,
            link: "/admin/billing",
            metadata: {
              sessionId: session.id,
              subscriptionId: subId,
              amount: total,
              currency: curr,
              gateway: "stripe",
            },
          });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        await syncWorkspaceFromSubscription(sub);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(sub);
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (e) {
    if (inserted) {
      await prisma.stripeEventLog
        .deleteMany({ where: { stripeEventId: event.id } })
        .catch(() => {
          /* best effort */
        });
    }
    console.error("[stripe webhook] handler error", event.type, e);
    res.status(500).json({ error: "Webhook handler failed" });
  }
}

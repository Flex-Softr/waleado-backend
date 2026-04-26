import type Stripe from "stripe";
import { Plan } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { env } from "../env";
import { getStripe } from "../lib/stripe-client";
import { listPaymentGateways } from "../payments/gateway-catalog";
import {
  apiPaidPlanToDb,
  planToApi,
  priceIdToPlan,
  type PlanIdApi,
} from "../lib/plan-mapping";

const ACTIVE = new Set(["active", "trialing", "past_due"]);

export async function getBillingForWorkspace(workspaceId: string) {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      plan: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
    },
  });
  if (!ws) {
    throw new AppError(404, "Workspace not found", "NOT_FOUND");
  }
  return {
    planId: planToApi(ws.plan) as PlanIdApi,
    subscriptionStatus: ws.subscriptionStatus,
    currentPeriodEnd: ws.currentPeriodEnd?.toISOString() ?? null,
    stripeConfigured: Boolean(env.STRIPE_SECRET_KEY),
    paymentGateways: listPaymentGateways(),
  };
}

export async function applyDemoPlan(
  workspaceId: string,
  planId: Exclude<PlanIdApi, "free">
): Promise<PlanIdApi> {
  const plan = apiPaidPlanToDb(planId);
  await prisma.workspace.update({
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

export async function resetWorkspaceToFree(workspaceId: string): Promise<void> {
  const ws = await prisma.workspace.findUnique({
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
    throw new AppError(404, "Workspace not found", "NOT_FOUND");
  }
  if (
    ws.stripeSubscriptionId &&
    ws.subscriptionStatus &&
    ACTIVE.has(ws.subscriptionStatus)
  ) {
    throw new AppError(
      400,
      "Cancel your subscription in Stripe before downgrading here, or use the customer portal.",
      "SUBSCRIPTION_ACTIVE"
    );
  }
  const now = new Date();
  if (
    ws.lastPaymentGateway === "sslcommerz" &&
    ws.plan !== Plan.FREE &&
    ws.currentPeriodEnd &&
    ws.currentPeriodEnd > now &&
    ws.subscriptionStatus === "active"
  ) {
    throw new AppError(
      400,
      "Your paid period through SSLCommerz is still active. Wait until it ends or contact support.",
      "PAID_PERIOD_ACTIVE"
    );
  }
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      plan: Plan.FREE,
      subscriptionStatus: null,
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      lastPaymentGateway: null,
    },
  });
}

export async function confirmCheckoutSession(input: {
  workspaceId: string;
  sessionId: string;
}): Promise<{ planId: PlanIdApi; demo: boolean }> {
  const stripe = getStripe();
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
      throw new AppError(403, "Session does not belong to this workspace", "FORBIDDEN");
    }
  }

  if (session.status !== "complete") {
    throw new AppError(400, "Checkout not complete", "CHECKOUT_INCOMPLETE");
  }

  const subRaw = session.subscription;
  const subscription =
    typeof subRaw === "string"
      ? await stripe.subscriptions.retrieve(subRaw)
      : (subRaw as Stripe.Subscription | null);

  if (!subscription) {
    throw new AppError(400, "No subscription on session", "NO_SUBSCRIPTION");
  }

  await syncWorkspaceFromSubscription(subscription);
  const ws = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { plan: true },
  });
  return {
    planId: (ws ? planToApi(ws.plan) : "free") as PlanIdApi,
    demo: false,
  };
}

export async function syncWorkspaceFromSubscription(
  subscription: Stripe.Subscription
): Promise<void> {
  const workspaceId =
    subscription.metadata?.workspaceId ??
    (
      await prisma.workspace.findFirst({
        where: { stripeSubscriptionId: subscription.id },
        select: { id: true },
      })
    )?.id;

  if (!workspaceId) {
    console.warn(
      "[billing] subscription without workspace mapping",
      subscription.id
    );
    return;
  }

  const item = subscription.items.data[0];
  const priceId = item?.price?.id;
  const mappedPlan = priceId ? priceIdToPlan(priceId) : null;
  const plan =
    mappedPlan ??
    (subscription.metadata?.planId === "business"
      ? Plan.BUSINESS
      : subscription.metadata?.planId === "pro"
        ? Plan.PRO
        : null);

  if (!plan) {
    console.warn("[billing] unknown price for subscription", subscription.id, priceId);
    return;
  }

  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;

  await prisma.workspace.update({
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

export async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription
): Promise<void> {
  const workspaceId =
    subscription.metadata?.workspaceId ??
    (
      await prisma.workspace.findFirst({
        where: { stripeSubscriptionId: subscription.id },
        select: { id: true },
      })
    )?.id;

  if (!workspaceId) return;

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      plan: Plan.FREE,
      stripeSubscriptionId: null,
      subscriptionStatus: "canceled",
      currentPeriodEnd: null,
      lastPaymentGateway: null,
    },
  });
}

import Stripe from "stripe";
import { Plan } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { env } from "../env";
import { getStripe, isStripeKeyConfigured } from "../lib/stripe-client";
import { listPaymentGateways } from "../payments/gateway-catalog";
import { planToApi, type PlanIdApi } from "../lib/plan-mapping";
import { matchSubscriptionPriceToPlan } from "../payments/stripe/stripe-price-ref";
import {
  getBillingSettings,
  getCatalogPlan,
  trialDurationMs,
} from "../billing/catalog.service";
import {
  getEntitlements,
  getMessageUsage,
  invalidateEntitlements,
} from "../billing/entitlements.service";
import { applyPaidInvoice } from "../billing/invoices.service";

const DAY_MS = 24 * 60 * 60 * 1000;
const STRIPE_ACTIVE = new Set(["active", "trialing", "past_due"]);

function appPublicBase(): string {
  return env.APP_PUBLIC_URL.replace(/\/$/, "");
}

/** Current reverse-trial length, as configured by an admin. */
export async function currentTrialDurationMs(): Promise<number> {
  return trialDurationMs(await getBillingSettings());
}

/**
 * Starts the one-time reverse trial for a workspace that never had one.
 * After the trial the workspace keeps working on the Free plan (no lockout).
 */
export async function ensureTrialStarted(
  userId?: string | null,
  workspaceId?: string | null
): Promise<void> {
  if (!workspaceId) return;
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true, trialUsed: true, trialStartedAt: true, lifetimeTier: true },
  });
  if (!ws || ws.trialUsed || ws.trialStartedAt) return;
  if (ws.plan !== Plan.FREE || ws.lifetimeTier) return;

  if (userId) {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, trialUsed: true },
    });
    // Platform admins have full access; a user gets only one trial across workspaces.
    if (u?.role === "ADMIN" || u?.trialUsed) {
      await prisma.workspace.update({ where: { id: workspaceId }, data: { trialUsed: true } });
      return;
    }
  }

  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + (await currentTrialDurationMs()));
  await prisma.$transaction(async (tx) => {
    await tx.workspace.update({
      where: { id: workspaceId },
      data: { trialUsed: true, trialStartedAt: now, trialEndsAt },
    });
    if (userId) {
      await tx.user.update({
        where: { id: userId },
        data: { trialUsed: true, trialStartedAt: now, trialEndsAt },
      });
    }
  });
  invalidateEntitlements(workspaceId);
}

function daysUntil(d: Date | null, now: Date): number | null {
  if (!d) return null;
  return Math.max(0, Math.ceil((d.getTime() - now.getTime()) / DAY_MS));
}

async function countUsage(workspaceId: string) {
  const [devices, contacts, templates, autoReplyRules, chatbotFlows, messages] =
    await Promise.all([
      prisma.device.count({ where: { workspaceId } }),
      prisma.contact.count({ where: { group: { workspaceId } } }),
      prisma.messageTemplate.count({ where: { workspaceId } }),
      prisma.autoReplyRule.count({ where: { workspaceId } }),
      prisma.chatbotFlow.count({ where: { workspaceId } }),
      getMessageUsage(workspaceId),
    ]);
  return {
    devices,
    contacts,
    templates,
    autoReplyRules,
    chatbotFlows,
    messagesToday: messages.today,
    messagesThisMonth: messages.thisMonth,
  };
}

/** Billing snapshot for the dashboard: current plan, where it comes from, limits and usage. */
export async function getBillingForWorkspace(workspaceId: string, userId?: string | null) {
  await ensureTrialStarted(userId, workspaceId);
  const now = new Date();
  const [ent, ws, usage] = await Promise.all([
    getEntitlements(workspaceId),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        plan: true,
        subscriptionStatus: true,
        billingMonths: true,
        lifetimeTier: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        lastPaymentGateway: true,
        trialUsed: true,
        trialStartedAt: true,
        trialEndsAt: true,
      },
    }),
    countUsage(workspaceId),
  ]);
  if (!ws) throw new AppError(404, "Workspace not found", "NOT_FOUND");

  const trialActive = ent.source === "trial";
  const lifetimePlan = ws.lifetimeTier ? await getCatalogPlan(ws.lifetimeTier) : undefined;
  const periodDays = daysUntil(ent.periodEnd, now);
  const isPaidSource = ent.source === "paid" || ent.source === "grace" || ent.source === "lifetime";

  return {
    planId: ent.planId,
    planName: ent.planName,
    /** admin | paid | grace | lifetime | trial | free */
    source: ent.source,
    isLifetime: Boolean(ws.lifetimeTier),
    lifetimePlanId: ws.lifetimeTier ? planToApi(ws.lifetimeTier) : null,
    lifetimePlanName: lifetimePlan?.name ?? null,
    billingMonths: ws.billingMonths,
    subscriptionStatus: ent.source === "grace" ? "grace" : ws.subscriptionStatus,
    currentPeriodEnd: ent.periodEnd?.toISOString() ?? null,
    graceEndsAt: ent.source === "grace" ? ent.graceEndsAt?.toISOString() ?? null : null,
    inGrace: ent.source === "grace",
    trial: {
      active: trialActive,
      endsAt: ws.trialEndsAt?.toISOString() ?? null,
      daysRemaining: trialActive ? daysUntil(ws.trialEndsAt, now) : 0,
    },
    limits: ent.limits,
    usage,

    // Fields kept for older clients.
    trialStartedAt: ws.trialStartedAt?.toISOString() ?? null,
    trialEndsAt: ws.trialEndsAt?.toISOString() ?? null,
    trialUsed: ws.trialUsed,
    isTrial: trialActive,
    isTrialExpired: false,
    hasActiveSubscription: true,
    daysRemaining: trialActive ? daysUntil(ws.trialEndsAt, now) : isPaidSource ? periodDays : null,
    stripeConfigured: isStripeKeyConfigured(),
    stripePortalEligible: Boolean(
      ws.stripeCustomerId && ws.lastPaymentGateway === "stripe" && ws.stripeSubscriptionId
    ),
    paymentGateways: listPaymentGateways(),
  };
}

/**
 * Opens Stripe Customer Portal for workspaces still on a legacy Stripe subscription.
 */
export async function createStripeCustomerPortalSession(
  workspaceId: string
): Promise<{ url: string }> {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError(503, "Stripe is not configured", "STRIPE_NOT_CONFIGURED");
  }

  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { stripeCustomerId: true, lastPaymentGateway: true, stripeSubscriptionId: true },
  });
  if (!ws?.stripeCustomerId) {
    throw new AppError(
      400,
      "No Stripe billing profile for this workspace. Complete a Stripe checkout first.",
      "STRIPE_NO_CUSTOMER"
    );
  }
  if (ws.lastPaymentGateway !== "stripe" || !ws.stripeSubscriptionId) {
    throw new AppError(
      400,
      "The customer portal is only available for active Stripe subscriptions.",
      "STRIPE_PORTAL_UNSUPPORTED"
    );
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: ws.stripeCustomerId,
      return_url: `${appPublicBase()}/billing`,
    });
    if (!session.url) {
      throw new AppError(500, "Portal session missing URL", "STRIPE_ERROR");
    }
    return { url: session.url };
  } catch (e) {
    if (e instanceof AppError) throw e;
    const msg =
      e instanceof Stripe.errors.StripeError ? e.message : "Could not open Stripe billing portal";
    console.error("[billing] stripe portal session", e);
    throw new AppError(
      502,
      `${msg} If this is a new account, enable the Customer Portal in the Stripe Dashboard (Settings → Billing → Customer portal).`,
      "STRIPE_PORTAL_FAILED"
    );
  }
}

/** Local development only: activates an invoice without a payment gateway. */
export async function applyDemoInvoice(invoiceId: string): Promise<void> {
  if (env.NODE_ENV === "production") {
    throw new AppError(503, "No payment gateway is configured", "GATEWAY_NOT_CONFIGURED");
  }
  await applyPaidInvoice(invoiceId, "demo");
}

/**
 * Drops a workspace back to Free. Refused while a paid period is still running.
 */
export async function resetWorkspaceToFree(workspaceId: string): Promise<void> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      stripeSubscriptionId: true,
      subscriptionStatus: true,
      plan: true,
      currentPeriodEnd: true,
      lifetimeTier: true,
    },
  });
  if (!ws) {
    throw new AppError(404, "Workspace not found", "NOT_FOUND");
  }
  if (ws.stripeSubscriptionId && ws.subscriptionStatus && STRIPE_ACTIVE.has(ws.subscriptionStatus)) {
    throw new AppError(
      400,
      "Cancel your subscription in Stripe before downgrading here, or use the customer portal.",
      "SUBSCRIPTION_ACTIVE"
    );
  }
  if (ws.lifetimeTier) {
    throw new AppError(400, "Lifetime plans cannot be reset.", "LIFETIME_PLAN");
  }
  if (ws.plan !== Plan.FREE && ws.currentPeriodEnd && ws.currentPeriodEnd > new Date()) {
    throw new AppError(
      400,
      "Your paid period is still active. It switches to Free automatically when it ends.",
      "PAID_PERIOD_ACTIVE"
    );
  }
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      plan: Plan.FREE,
      subscriptionStatus: "expired",
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      billingMonths: null,
      lastPaymentGateway: null,
      trialUsed: true,
      trialEndsAt: new Date(),
    },
  });
  invalidateEntitlements(workspaceId);
}

/**
 * Confirms a Stripe Checkout session after the browser returns.
 * One-time invoice payments activate the invoice; legacy subscription sessions sync the subscription.
 */
export async function confirmCheckoutSession(input: {
  workspaceId: string;
  sessionId: string;
}): Promise<{ planId: PlanIdApi; demo: boolean }> {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError(503, "Stripe is not configured", "STRIPE_NOT_CONFIGURED");
  }

  const session = await stripe.checkout.sessions.retrieve(input.sessionId, {
    expand: ["subscription"],
  });

  const sessionWs = session.client_reference_id ?? session.metadata?.workspaceId;
  if (sessionWs !== input.workspaceId) {
    throw new AppError(403, "Session does not belong to this workspace", "FORBIDDEN");
  }
  if (session.status !== "complete") {
    throw new AppError(400, "Checkout not complete", "CHECKOUT_INCOMPLETE");
  }

  if (session.mode === "payment") {
    await fulfillStripePaymentSession(session);
  } else {
    const subRaw = session.subscription;
    const subscription =
      typeof subRaw === "string"
        ? await stripe.subscriptions.retrieve(subRaw)
        : (subRaw as Stripe.Subscription | null);
    if (!subscription) {
      throw new AppError(400, "No subscription on session", "NO_SUBSCRIPTION");
    }
    await syncWorkspaceFromSubscription(subscription);
  }

  const ent = await getEntitlements(input.workspaceId);
  return { planId: ent.planId, demo: false };
}

/** Activates the invoice paid through a one-time Stripe Checkout session. */
export async function fulfillStripePaymentSession(session: Stripe.Checkout.Session): Promise<void> {
  const invoiceId = session.metadata?.invoiceId;
  if (!invoiceId) {
    throw new AppError(400, "Checkout session has no invoice", "NO_INVOICE");
  }
  if (session.payment_status !== "paid") {
    throw new AppError(400, "Payment not completed", "PAYMENT_INCOMPLETE");
  }
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.workspaceId !== (session.client_reference_id ?? session.metadata?.workspaceId)) {
    throw new AppError(404, "Invoice not found", "NOT_FOUND");
  }
  const expectedCents = Number(session.metadata?.expectedAmountCents ?? NaN);
  if (!Number.isFinite(expectedCents) || session.amount_total !== expectedCents) {
    throw new AppError(400, "Amount mismatch", "AMOUNT_MISMATCH");
  }
  await prisma.paymentTransaction.updateMany({
    where: { tranId: session.id, status: "pending" },
    data: { status: "paid" },
  });
  await applyPaidInvoice(invoice.id, "stripe");
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
    console.warn("[billing] subscription without workspace mapping", subscription.id);
    return;
  }

  const item = subscription.items.data[0];
  const priceId = item?.price?.id;
  const stripe = getStripe();
  const mappedPlan =
    priceId && stripe ? await matchSubscriptionPriceToPlan(stripe, priceId) : null;
  const metaPlan = subscription.metadata?.planId;
  const plan =
    mappedPlan ??
    (metaPlan === "business"
      ? Plan.BUSINESS
      : metaPlan === "pro"
        ? Plan.PRO
        : metaPlan === "starter"
          ? Plan.STARTER
          : null);

  if (!plan) {
    console.warn("[billing] unknown price for subscription", subscription.id, priceId);
    return;
  }

  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      plan,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: customerId ?? undefined,
      subscriptionStatus: subscription.status,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      billingMonths: 1,
      lastPaymentGateway: "stripe",
    },
  });
  invalidateEntitlements(workspaceId);
}

export async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription
): Promise<void> {
  const ws = await prisma.workspace.findFirst({
    where: {
      OR: [
        ...(subscription.metadata?.workspaceId ? [{ id: subscription.metadata.workspaceId }] : []),
        { stripeSubscriptionId: subscription.id },
      ],
    },
    select: { id: true, lifetimeTier: true },
  });
  if (!ws) return;

  await prisma.workspace.update({
    where: { id: ws.id },
    data: ws.lifetimeTier
      ? {
          plan: ws.lifetimeTier,
          stripeSubscriptionId: null,
          subscriptionStatus: "active",
          currentPeriodEnd: null,
          billingMonths: 0,
        }
      : {
          plan: Plan.FREE,
          stripeSubscriptionId: null,
          subscriptionStatus: "canceled",
          currentPeriodEnd: null,
          billingMonths: null,
          lastPaymentGateway: null,
        },
  });
  invalidateEntitlements(ws.id);
}

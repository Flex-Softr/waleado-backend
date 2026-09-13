import Stripe from "stripe";
import { Plan } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { env } from "../env";
import { getStripe } from "../lib/stripe-client";
import { listPaymentGateways } from "../payments/gateway-catalog";
import {
  apiPaidPlanToDb,
  planToApi,
  type PlanIdApi,
} from "../lib/plan-mapping";
import { matchSubscriptionPriceToPlan } from "../payments/stripe/stripe-price-ref";

const ACTIVE = new Set(["active", "trialing", "past_due"]);

function appPublicBase(): string {
  return env.APP_PUBLIC_URL.replace(/\/$/, "");
}

/**
 * SSLCommerz is one-time / period-based (no recurring webhook). Downgrade when
 * `currentPeriodEnd` has passed so paid features do not continue forever.
 */
export async function enforceSslCommerzPeriodExpiry(
  workspaceId: string
): Promise<boolean> {
  const now = new Date();
  const result = await prisma.workspace.updateMany({
    where: {
      id: workspaceId,
      lastPaymentGateway: "sslcommerz",
      plan: { not: Plan.FREE },
      currentPeriodEnd: { lt: now },
    },
    data: {
      plan: Plan.FREE,
      subscriptionStatus: "expired",
      currentPeriodEnd: null,
      lastPaymentGateway: null,
    },
  });
  return result.count > 0;
}

/** Global sweep for expired SSLCommerz periods (no per-workspace request needed). */
export async function expireAllDueSslCommerzWorkspaces(): Promise<number> {
  const now = new Date();
  const result = await prisma.workspace.updateMany({
    where: {
      lastPaymentGateway: "sslcommerz",
      plan: { not: Plan.FREE },
      currentPeriodEnd: { lt: now },
    },
    data: {
      plan: Plan.FREE,
      subscriptionStatus: "expired",
      currentPeriodEnd: null,
      lastPaymentGateway: null,
    },
  });
  return result.count;
}

export const TRIAL_DURATION_DAYS = 3;
export const TRIAL_DURATION_MS = TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Ensures an account starts its 3-day free trial on first sign-in/use.
 * Only once can an account receive the trial.
 */
export async function ensureTrialStarted(
  userId?: string | null,
  workspaceId?: string | null
): Promise<{
  isTrial: boolean;
  isExpired: boolean;
  daysRemaining: number;
}> {
  if (!workspaceId) {
    return { isTrial: false, isExpired: false, daysRemaining: 0 };
  }

  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      plan: true,
      subscriptionStatus: true,
      trialUsed: true,
      trialStartedAt: true,
      trialEndsAt: true,
    },
  });

  if (!ws) {
    return { isTrial: false, isExpired: false, daysRemaining: 0 };
  }

  // Platform admins never have a trial
  if (userId) {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (u?.role === "ADMIN") {
      return { isTrial: false, isExpired: false, daysRemaining: 0 };
    }
  }

  const adminMember = await prisma.membership.findFirst({
    where: {
      workspaceId,
      user: { role: "ADMIN" },
    },
  });
  if (adminMember) {
    return { isTrial: false, isExpired: false, daysRemaining: 0 };
  }

  // If already on a paid plan, trial is not active
  if (ws.plan !== Plan.FREE) {
    return { isTrial: false, isExpired: false, daysRemaining: 0 };
  }

  const now = new Date();

  // If user provided, check if user has already consumed a trial
  let userTrialUsed = false;
  if (userId) {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { trialUsed: true },
    });
    if (u?.trialUsed) {
      userTrialUsed = true;
    }
  }

  // Case 1: Account has never used trial -> Start 3-day trial now!
  if (!ws.trialUsed && !ws.trialStartedAt && !userTrialUsed) {
    const trialStartedAt = now;
    const trialEndsAt = new Date(now.getTime() + TRIAL_DURATION_MS);

    await prisma.$transaction(async (tx) => {
      await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          trialUsed: true,
          trialStartedAt,
          trialEndsAt,
          subscriptionStatus: "trialing",
        },
      });

      if (userId) {
        await tx.user.update({
          where: { id: userId },
          data: {
            trialUsed: true,
            trialStartedAt,
            trialEndsAt,
          },
        });
      }
    });

    return { isTrial: true, isExpired: false, daysRemaining: TRIAL_DURATION_DAYS };
  }

  // Case 2: Workspace has an existing trial
  if (ws.trialEndsAt) {
    if (now > ws.trialEndsAt) {
      if (ws.subscriptionStatus === "trialing") {
        await prisma.workspace.update({
          where: { id: workspaceId },
          data: { subscriptionStatus: "expired" },
        });
      }
      return { isTrial: true, isExpired: true, daysRemaining: 0 };
    } else {
      const remainingMs = ws.trialEndsAt.getTime() - now.getTime();
      const daysRemaining = Math.max(
        1,
        Math.ceil(remainingMs / (24 * 60 * 60 * 1000))
      );
      return { isTrial: true, isExpired: false, daysRemaining };
    }
  }

  // Case 3: trialUsed is true, but dates missing or expired
  return { isTrial: true, isExpired: true, daysRemaining: 0 };
}

/**
 * Checks whether a workspace currently has active access (either via active paid subscription
 * or via active 3-day trial). Platform admins always have access.
 */
export async function checkWorkspaceSubscriptionAccess(
  workspaceId: string,
  userId?: string | null
): Promise<{
  hasAccess: boolean;
  isTrial: boolean;
  isExpired: boolean;
  daysRemaining?: number;
  reason?: string;
}> {
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (user?.role === "ADMIN") {
      return { hasAccess: true, isTrial: false, isExpired: false };
    }
  }

  const adminMember = await prisma.membership.findFirst({
    where: {
      workspaceId,
      user: { role: "ADMIN" },
    },
  });
  if (adminMember) {
    return { hasAccess: true, isTrial: false, isExpired: false };
  }

  await enforceSslCommerzPeriodExpiry(workspaceId);

  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      plan: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      lastPaymentGateway: true,
      trialUsed: true,
      trialStartedAt: true,
      trialEndsAt: true,
    },
  });

  if (!ws) {
    return { hasAccess: false, isTrial: false, isExpired: false, reason: "NOT_FOUND" };
  }

  // Active paid subscription check
  if (ws.plan !== Plan.FREE) {
    const statusOk =
      ws.subscriptionStatus && ACTIVE.has(ws.subscriptionStatus);
    if (statusOk) {
      return { hasAccess: true, isTrial: false, isExpired: false };
    }
    if (ws.subscriptionStatus === "demo") {
      return { hasAccess: true, isTrial: false, isExpired: false };
    }
  }

  // Free plan -> must be on active 3-day trial
  const trial = await ensureTrialStarted(userId, workspaceId);
  if (trial.isTrial && !trial.isExpired) {
    return {
      hasAccess: true,
      isTrial: true,
      isExpired: false,
      daysRemaining: trial.daysRemaining,
    };
  }

  return {
    hasAccess: false,
    isTrial: true,
    isExpired: true,
    daysRemaining: 0,
    reason: "TRIAL_EXPIRED",
  };
}

export async function getBillingForWorkspace(
  workspaceId: string,
  userId?: string | null
) {
  let isAdmin = false;
  if (userId) {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (u?.role === "ADMIN") {
      isAdmin = true;
    }
  }
  if (!isAdmin) {
    const adminMember = await prisma.membership.findFirst({
      where: {
        workspaceId,
        user: { role: "ADMIN" },
      },
    });
    if (adminMember) {
      isAdmin = true;
    }
  }

  if (isAdmin) {
    // Clear any leftover trial or expired state on admin workspace
    await prisma.workspace.updateMany({
      where: {
        id: workspaceId,
        OR: [
          { trialUsed: true },
          { subscriptionStatus: { in: ["trialing", "expired"] } },
        ],
      },
      data: {
        trialUsed: false,
        trialStartedAt: null,
        trialEndsAt: null,
        subscriptionStatus: "active",
      },
    });

    const ws = await prisma.workspace.findUnique({
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
      throw new AppError(404, "Workspace not found", "NOT_FOUND");
    }

    return {
      planId: (ws.plan !== Plan.FREE ? planToApi(ws.plan) : "business") as PlanIdApi,
      subscriptionStatus: "active",
      currentPeriodEnd: ws.currentPeriodEnd?.toISOString() ?? null,
      trialStartedAt: null,
      trialEndsAt: null,
      trialUsed: false,
      isTrial: false,
      isTrialExpired: false,
      hasActiveSubscription: true,
      daysRemaining: null,
      stripeConfigured: Boolean(env.STRIPE_SECRET_KEY),
      stripePortalEligible: false,
      paymentGateways: listPaymentGateways(),
    };
  }

  await enforceSslCommerzPeriodExpiry(workspaceId);

  // Sync trial on billing fetch for regular users
  await ensureTrialStarted(userId, workspaceId);

  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      plan: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      lastPaymentGateway: true,
      trialUsed: true,
      trialStartedAt: true,
      trialEndsAt: true,
    },
  });
  if (!ws) {
    throw new AppError(404, "Workspace not found", "NOT_FOUND");
  }

  const now = new Date();
  const isPaid = ws.plan !== Plan.FREE;
  const isTrial = !isPaid;
  const isTrialExpired = Boolean(
    isTrial &&
      (ws.trialUsed || ws.trialEndsAt) &&
      (!ws.trialEndsAt || now > ws.trialEndsAt)
  );

  let hasActiveSubscription = false;
  if (isPaid) {
    hasActiveSubscription = Boolean(
      (ws.subscriptionStatus && ACTIVE.has(ws.subscriptionStatus)) ||
        ws.subscriptionStatus === "demo"
    );
  } else {
    hasActiveSubscription = Boolean(
      ws.trialEndsAt && now <= ws.trialEndsAt
    );
  }

  let daysRemaining: number | null = null;
  if (isTrial && ws.trialEndsAt && now <= ws.trialEndsAt) {
    daysRemaining = Math.max(
      1,
      Math.ceil((ws.trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
    );
  } else if (isPaid && ws.currentPeriodEnd && now <= ws.currentPeriodEnd) {
    daysRemaining = Math.max(
      0,
      Math.ceil((ws.currentPeriodEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
    );
  }

  const stripePortalEligible = Boolean(
    ws.stripeCustomerId &&
      ws.lastPaymentGateway === "stripe" &&
      ws.stripeSubscriptionId
  );

  return {
    planId: planToApi(ws.plan) as PlanIdApi,
    subscriptionStatus: ws.subscriptionStatus,
    currentPeriodEnd: ws.currentPeriodEnd?.toISOString() ?? null,
    trialStartedAt: ws.trialStartedAt?.toISOString() ?? null,
    trialEndsAt: ws.trialEndsAt?.toISOString() ?? null,
    trialUsed: ws.trialUsed,
    isTrial,
    isTrialExpired,
    hasActiveSubscription,
    daysRemaining,
    stripeConfigured: Boolean(env.STRIPE_SECRET_KEY),
    stripePortalEligible,
    paymentGateways: listPaymentGateways(),
  };
}

/**
 * Opens Stripe Customer Portal (cancel, payment method, invoices) for workspaces
 * that subscribed through Stripe checkout.
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
    select: {
      stripeCustomerId: true,
      lastPaymentGateway: true,
      stripeSubscriptionId: true,
    },
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
      e instanceof Stripe.errors.StripeError
        ? e.message
        : "Could not open Stripe billing portal";
    console.error("[billing] stripe portal session", e);
    throw new AppError(
      502,
      `${msg} If this is a new account, enable the Customer Portal in the Stripe Dashboard (Settings → Billing → Customer portal).`,
      "STRIPE_PORTAL_FAILED"
    );
  }
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
      subscriptionStatus: "expired",
      stripeSubscriptionId: null,
      currentPeriodEnd: null,
      lastPaymentGateway: null,
      trialUsed: true,
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
  const stripe = getStripe();
  const mappedPlan =
    priceId && stripe
      ? await matchSubscriptionPriceToPlan(stripe, priceId)
      : null;
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

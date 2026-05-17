import Stripe from "stripe";
import { Plan } from "@prisma/client";
import { env } from "../../env";
import { getStripe } from "../../lib/stripe-client";
import { AppError } from "../../lib/errors";
import {
  apiPaidPlanToDb,
  type PlanIdApi,
} from "../../lib/plan-mapping";
import {
  isStripeLineItemEnvReference,
  resolveStripeCheckoutLineItem,
} from "./stripe-price-ref";

function appPublicBase(): string {
  return env.APP_PUBLIC_URL.replace(/\/$/, "");
}

export function stripeCheckoutConfigured(): boolean {
  return Boolean(
    getStripe() &&
      isStripeLineItemEnvReference(env.STRIPE_PRICE_PRO_MONTHLY) &&
      isStripeLineItemEnvReference(env.STRIPE_PRICE_BUSINESS_MONTHLY)
  );
}

export async function createStripeCheckoutSession(input: {
  workspaceId: string;
  userEmail: string;
  planId: Exclude<PlanIdApi, "free">;
}): Promise<{ url: string }> {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError(503, "Stripe is not configured", "STRIPE_NOT_CONFIGURED");
  }
  const plan = apiPaidPlanToDb(input.planId);
  const raw =
    plan === Plan.PRO
      ? env.STRIPE_PRICE_PRO_MONTHLY?.trim()
      : env.STRIPE_PRICE_BUSINESS_MONTHLY?.trim();

  if (!raw) {
    throw new AppError(
      500,
      "Stripe is configured but the price ID env var for this plan is missing",
      "PRICE_NOT_CONFIGURED"
    );
  }

  const priceEnvName =
    plan === Plan.PRO
      ? "STRIPE_PRICE_PRO_MONTHLY"
      : "STRIPE_PRICE_BUSINESS_MONTHLY";

  const productName =
    plan === Plan.PRO ? "Pro (monthly)" : "Business (monthly)";
  const lineItem = await resolveStripeCheckoutLineItem(
    stripe,
    raw,
    priceEnvName,
    productName,
    env.STRIPE_CURRENCY
  );

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
      throw new AppError(500, "Checkout session missing URL", "STRIPE_ERROR");
    }
    return { url: session.url };
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof Stripe.errors.StripeError) {
      const isClient =
        e instanceof Stripe.errors.StripeInvalidRequestError ||
        e instanceof Stripe.errors.StripeCardError;
      console.error("[stripe checkout]", e.type, e.code, e.message);
      const hint =
        e.code === "resource_missing" && e.message.includes("price")
          ? " Confirm STRIPE_SECRET_KEY is test-mode if your prices are in test mode (or live/live), and that the price id exists on the same Stripe account."
          : "";
      throw new AppError(
        isClient ? 400 : 502,
        `${e.message}${hint}`,
        e.code ?? "STRIPE_ERROR"
      );
    }
    throw e;
  }
}

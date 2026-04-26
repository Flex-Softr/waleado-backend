import { env } from "../../env";
import { getStripe } from "../../lib/stripe-client";
import { AppError } from "../../lib/errors";
import { Plan } from "@prisma/client";
import {
  apiPaidPlanToDb,
  type PlanIdApi,
} from "../../lib/plan-mapping";

function appPublicBase(): string {
  return env.APP_PUBLIC_URL.replace(/\/$/, "");
}

export function stripeCheckoutConfigured(): boolean {
  return Boolean(getStripe() && env.STRIPE_PRICE_PRO_MONTHLY && env.STRIPE_PRICE_BUSINESS_MONTHLY);
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
  const priceEnv =
    plan === Plan.PRO
      ? env.STRIPE_PRICE_PRO_MONTHLY
      : env.STRIPE_PRICE_BUSINESS_MONTHLY;

  if (!priceEnv) {
    throw new AppError(
      500,
      "Stripe is configured but the price ID env var for this plan is missing",
      "PRICE_NOT_CONFIGURED"
    );
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
    throw new AppError(500, "Checkout session missing URL", "STRIPE_ERROR");
  }
  return { url: session.url };
}

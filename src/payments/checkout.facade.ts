import { AppError } from "../lib/errors";
import { env } from "../env";
import { getStripe } from "../lib/stripe-client";
import type { PlanIdApi } from "../lib/plan-mapping";
import { applyDemoPlan } from "../services/billing.service";
import type { InitiateCheckoutInput, InitiateCheckoutResult, PaymentGatewayId } from "./types";
import { createStripeCheckoutSession } from "./stripe/stripe-checkout";
import {
  initiateSslCommerzCheckout,
  sslCommerzConfigured,
} from "./sslcommerz/sslcommerz-checkout";

/**
 * Entry point for plan upgrades: picks the right provider (strategy) by gateway id.
 */
export async function initiatePaidCheckout(
  gateway: PaymentGatewayId,
  input: InitiateCheckoutInput
): Promise<InitiateCheckoutResult> {
  if (gateway === "sslcommerz") {
    if (!sslCommerzConfigured()) {
      throw new AppError(
        503,
        "SSLCommerz is not configured (set SSLCOMMERZ_STORE_ID and SSLCOMMERZ_STORE_PASSWORD)",
        "SSLCOMMERZ_NOT_CONFIGURED"
      );
    }
    const { url } = await initiateSslCommerzCheckout(input);
    return { kind: "redirect", url };
  }

  if (gateway === "stripe") {
    if (!getStripe()) {
      if (env.NODE_ENV === "production") {
        throw new AppError(
          503,
          "Stripe is not configured (set STRIPE_SECRET_KEY)",
          "STRIPE_NOT_CONFIGURED"
        );
      }
      const planId = await applyDemoPlan(input.workspaceId, input.planId);
      return { kind: "demo", planId: planId as PlanIdApi };
    }
    const { url } = await createStripeCheckoutSession({
      workspaceId: input.workspaceId,
      userEmail: input.userEmail,
      planId: input.planId,
    });
    return { kind: "redirect", url };
  }

  const _exhaustive: never = gateway;
  return _exhaustive;
}

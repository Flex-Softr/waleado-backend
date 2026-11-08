import { env } from "../env";
import { isStripeKeyConfigured } from "../lib/stripe-client";
import { sslCommerzConfigured } from "./sslcommerz/sslcommerz-checkout";
import type { PaymentGatewayMeta } from "./types";

function stripeConfigured(): boolean {
  return isStripeKeyConfigured();
}

function stripeGatewayDescription(): string {
  const rawKey = env.STRIPE_SECRET_KEY?.trim();
  if (rawKey && !isStripeKeyConfigured()) {
    return "Stripe is disabled: a test-mode key (sk_test_) cannot be used in production.";
  }
  return "International cards (USD). Available for prices that have a USD amount.";
}

/**
 * Gateways shown in the billing UI. Add new providers here as you implement them.
 */
export function listPaymentGateways(): PaymentGatewayMeta[] {
  return [
    {
      id: "sslcommerz",
      displayName: "SSLCommerz",
      description:
        "Hosted checkout — cards, mobile & internet banking (popular in Bangladesh).",
      configured: sslCommerzConfigured(),
    },
    {
      id: "stripe",
      displayName: "Stripe",
      description: stripeGatewayDescription(),
      configured: stripeConfigured(),
    },
  ];
}

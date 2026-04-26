import { env } from "../env";
import { sslCommerzConfigured } from "./sslcommerz/sslcommerz-checkout";
import type { PaymentGatewayMeta } from "./types";

function stripeConfigured(): boolean {
  return Boolean(
    env.STRIPE_SECRET_KEY?.trim() &&
      env.STRIPE_PRICE_PRO_MONTHLY?.trim() &&
      env.STRIPE_PRICE_BUSINESS_MONTHLY?.trim()
  );
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
      description: "Subscription checkout with Stripe (cards).",
      configured: stripeConfigured(),
    },
  ];
}

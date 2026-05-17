import { env } from "../env";
import { sslCommerzConfigured } from "./sslcommerz/sslcommerz-checkout";
import { isStripeLineItemEnvReference } from "./stripe/stripe-price-ref";
import type { PaymentGatewayMeta } from "./types";

function stripeConfigured(): boolean {
  return Boolean(
    env.STRIPE_SECRET_KEY?.trim() &&
      isStripeLineItemEnvReference(env.STRIPE_PRICE_PRO_MONTHLY) &&
      isStripeLineItemEnvReference(env.STRIPE_PRICE_BUSINESS_MONTHLY)
  );
}

function stripeGatewayDescription(): string {
  if (stripeConfigured()) {
    return "Subscription checkout with Stripe (cards).";
  }
  const secret = Boolean(env.STRIPE_SECRET_KEY?.trim());
  const proRaw = env.STRIPE_PRICE_PRO_MONTHLY?.trim();
  const bizRaw = env.STRIPE_PRICE_BUSINESS_MONTHLY?.trim();
  if (secret) {
    if (!proRaw || !bizRaw) {
      return "Stripe secret key is set; add STRIPE_PRICE_PRO_MONTHLY and STRIPE_PRICE_BUSINESS_MONTHLY (each a price_… id, prod_… with default price, or a positive decimal amount with STRIPE_CURRENCY).";
    }
    if (
      !isStripeLineItemEnvReference(proRaw) ||
      !isStripeLineItemEnvReference(bizRaw)
    ) {
      return "STRIPE_PRICE_* must be a Stripe Price id (price_…), Product id (prod_…), or a positive decimal amount (major units).";
    }
  }
  return "Subscription checkout with Stripe (cards). Set STRIPE_SECRET_KEY plus both line items (price_…, prod_…, or decimal amount).";
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

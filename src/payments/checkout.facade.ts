import { AppError } from "../lib/errors";
import { env } from "../env";
import { getStripe } from "../lib/stripe-client";
import { applyPaidInvoice } from "../billing/invoices.service";
import type { InitiateCheckoutInput, InitiateCheckoutResult, PaymentGatewayId } from "./types";
import { createStripeInvoiceCheckout } from "./stripe/stripe-checkout";
import {
  initiateSslCommerzCheckout,
  sslCommerzConfigured,
} from "./sslcommerz/sslcommerz-checkout";

/**
 * Sends an unpaid invoice to the chosen payment provider.
 * Zero-total invoices (fully covered by upgrade credit) are activated directly.
 */
export async function initiatePaidCheckout(
  gateway: PaymentGatewayId,
  input: InitiateCheckoutInput
): Promise<InitiateCheckoutResult> {
  if (input.amount <= 0) {
    await applyPaidInvoice(input.invoiceId, "credit");
    return { kind: "activated" };
  }

  if (gateway === "sslcommerz") {
    if (!sslCommerzConfigured()) {
      if (env.NODE_ENV !== "production") {
        await applyPaidInvoice(input.invoiceId, "demo");
        return { kind: "activated" };
      }
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
      throw new AppError(503, "Stripe is not configured", "STRIPE_NOT_CONFIGURED");
    }
    const { url } = await createStripeInvoiceCheckout(input);
    return { kind: "redirect", url };
  }

  const _exhaustive: never = gateway;
  return _exhaustive;
}

import Stripe from "stripe";
import { env } from "../../env";
import { getStripe } from "../../lib/stripe-client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import type { InitiateCheckoutInput } from "../types";

function appPublicBase(): string {
  return env.APP_PUBLIC_URL.replace(/\/$/, "");
}

export function stripeCheckoutConfigured(): boolean {
  return Boolean(getStripe());
}

/**
 * One-time Stripe Checkout for an invoice (same prepaid model as SSLCommerz).
 * Requires the price to have a USD amount set in the admin pricing editor.
 */
export async function createStripeInvoiceCheckout(
  input: InitiateCheckoutInput
): Promise<{ url: string }> {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError(503, "Stripe is not configured", "STRIPE_NOT_CONFIGURED");
  }
  if (input.amountUsd === null || input.amountUsd <= 0) {
    throw new AppError(
      400,
      "Card payment in USD is not available for this plan. Please pay with SSLCommerz.",
      "USD_PRICE_NOT_SET"
    );
  }
  const amountCents = Math.round(input.amountUsd * 100);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: input.userEmail.trim(),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: { name: input.description.slice(0, 250) },
          },
        },
      ],
      success_url:
        input.returnTo === "pay-link"
          ? `${appPublicBase()}/pay/status?result=success`
          : `${appPublicBase()}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:
        input.returnTo === "pay-link"
          ? `${appPublicBase()}/pay/status?result=cancelled`
          : `${appPublicBase()}/billing?canceled=1`,
      client_reference_id: input.workspaceId,
      metadata: {
        workspaceId: input.workspaceId,
        invoiceId: input.invoiceId,
        planId: input.planId,
        expectedAmountCents: String(amountCents),
      },
    });

    if (!session.url) {
      throw new AppError(500, "Checkout session missing URL", "STRIPE_ERROR");
    }

    await prisma.paymentTransaction.create({
      data: {
        gateway: "stripe",
        tranId: session.id,
        workspaceId: input.workspaceId,
        invoiceId: input.invoiceId,
        planId: input.planId,
        amount: input.amountUsd,
        currency: "USD",
        status: "pending",
      },
    });
    return { url: session.url };
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof Stripe.errors.StripeError) {
      const isClient =
        e instanceof Stripe.errors.StripeInvalidRequestError ||
        e instanceof Stripe.errors.StripeCardError;
      console.error("[stripe checkout]", e.type, e.code, e.message);
      throw new AppError(isClient ? 400 : 502, e.message, e.code ?? "STRIPE_ERROR");
    }
    throw e;
  }
}

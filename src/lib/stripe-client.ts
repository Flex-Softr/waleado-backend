import Stripe from "stripe";
import { env } from "../env";

/**
 * A Stripe test-mode key in production would let anyone "pay" with a test card
 * and receive a paid plan for free. Treat it as "Stripe not configured" there.
 */
function isTestKeyBlocked(key: string): boolean {
  return env.NODE_ENV === "production" && key.startsWith("sk_test_");
}

let warnedTestKey = false;

/** The Stripe secret key that may be used in this environment, or null. */
export function getStripeSecretKey(): string | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  if (isTestKeyBlocked(key)) {
    if (!warnedTestKey) {
      warnedTestKey = true;
      console.warn(
        "[stripe] STRIPE_SECRET_KEY is a test-mode key (sk_test_) in production — Stripe is disabled. Use a live key (sk_live_) to enable it."
      );
    }
    return null;
  }
  return key;
}

export function isStripeKeyConfigured(): boolean {
  return getStripeSecretKey() !== null;
}

export function getStripe(): Stripe | null {
  const key = getStripeSecretKey();
  if (!key) return null;
  return new Stripe(key);
}

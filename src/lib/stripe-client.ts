import Stripe from "stripe";
import { env } from "../env";

export function getStripe(): Stripe | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return new Stripe(key);
}

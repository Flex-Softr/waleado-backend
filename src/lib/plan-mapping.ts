import { Plan } from "@prisma/client";
import { env } from "../env";

export type PlanIdApi = "free" | "pro" | "business";

export function planToApi(p: Plan): PlanIdApi {
  switch (p) {
    case Plan.FREE:
      return "free";
    case Plan.PRO:
      return "pro";
    case Plan.BUSINESS:
      return "business";
    default:
      return "free";
  }
}

export function apiPaidPlanToDb(id: Exclude<PlanIdApi, "free">): Plan {
  if (id === "pro") return Plan.PRO;
  return Plan.BUSINESS;
}

export function priceIdToPlan(priceId: string): Plan | null {
  if (env.STRIPE_PRICE_PRO_MONTHLY && priceId === env.STRIPE_PRICE_PRO_MONTHLY) {
    return Plan.PRO;
  }
  if (
    env.STRIPE_PRICE_BUSINESS_MONTHLY &&
    priceId === env.STRIPE_PRICE_BUSINESS_MONTHLY
  ) {
    return Plan.BUSINESS;
  }
  return null;
}

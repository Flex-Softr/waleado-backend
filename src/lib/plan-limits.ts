import { Plan } from "@prisma/client";

/** Max custom + AI message contents allowed per bulk TEXT campaign. */
export function maxBulkMessageContentsForPlan(plan: Plan): number {
  switch (plan) {
    case Plan.FREE:
      // Allow 1 custom seed + 1 AI rewrite so AI variants are usable on free.
      return 2;
    case Plan.PRO:
      return 5;
    case Plan.BUSINESS:
      return 20;
    default:
      return 2;
  }
}

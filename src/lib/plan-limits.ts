import { Plan } from "@prisma/client";

/** Max custom + AI message contents allowed per bulk TEXT campaign. */
export function maxBulkMessageContentsForPlan(plan: Plan): number {
  switch (plan) {
    case Plan.FREE:
      return 1;
    case Plan.PRO:
      return 5;
    case Plan.BUSINESS:
      return 20;
    default:
      return 1;
  }
}

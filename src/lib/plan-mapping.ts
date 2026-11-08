import { Plan } from "@prisma/client";

export type PlanIdApi = "free" | "starter" | "pro" | "business";
export type PaidPlanIdApi = Exclude<PlanIdApi, "free">;

export const PLAN_ID_VALUES = ["free", "starter", "pro", "business"] as const;
export const PAID_PLAN_ID_VALUES = ["starter", "pro", "business"] as const;

export function planToApi(p: Plan): PlanIdApi {
  switch (p) {
    case Plan.STARTER:
      return "starter";
    case Plan.PRO:
      return "pro";
    case Plan.BUSINESS:
      return "business";
    default:
      return "free";
  }
}

export function apiPlanToDb(id: PlanIdApi): Plan {
  switch (id) {
    case "starter":
      return Plan.STARTER;
    case "pro":
      return Plan.PRO;
    case "business":
      return Plan.BUSINESS;
    default:
      return Plan.FREE;
  }
}

export function apiPaidPlanToDb(id: PaidPlanIdApi): Plan {
  return apiPlanToDb(id);
}

const RANK: Record<Plan, number> = {
  [Plan.FREE]: 0,
  [Plan.STARTER]: 1,
  [Plan.PRO]: 2,
  [Plan.BUSINESS]: 3,
};

/** Ordering of tiers from lowest (FREE) to highest (BUSINESS). */
export function tierRank(p: Plan): number {
  return RANK[p] ?? 0;
}

export function higherTier(a: Plan, b: Plan): Plan {
  return tierRank(a) >= tierRank(b) ? a : b;
}

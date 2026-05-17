import { Plan } from "@prisma/client";

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

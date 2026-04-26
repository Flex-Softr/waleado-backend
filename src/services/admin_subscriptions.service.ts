import { Plan } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { AdminResponseMeta } from "../lib/admin-response-meta";
import { adminResponseMeta } from "../lib/admin-response-meta";
import { isPlatformOperatorEmail } from "./admin_overview.service";

export type AdminSubscriptionWorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  updatedAt: string;
};

export type AdminSubscriptionsKpi = {
  label: string;
  value: string;
  hint?: string;
};

export type AdminSubscriptionsJson = {
  scope: "platform" | "workspace";
  generatedAt: string;
  meta: AdminResponseMeta;
  kpis: AdminSubscriptionsKpi[];
  workspaces: AdminSubscriptionWorkspaceRow[];
};

const rowSelect = {
  id: true,
  name: true,
  slug: true,
  plan: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  subscriptionStatus: true,
  currentPeriodEnd: true,
  updatedAt: true,
} as const;

function formatPlan(p: Plan): string {
  return p.charAt(0) + p.slice(1).toLowerCase();
}

export async function getAdminSubscriptions(
  operatorEmail: string,
  workspaceId: string
): Promise<AdminSubscriptionsJson> {
  const now = new Date();
  const platform = isPlatformOperatorEmail(operatorEmail);
  const scope = platform ? "platform" : "workspace";

  const where = platform ? {} : { id: workspaceId };

  const [
    total,
    withStripeSub,
    pastDue,
    paidPlanCount,
    freePlanCount,
    proCount,
    businessCount,
    rows,
  ] = await Promise.all([
    prisma.workspace.count({ where }),
    prisma.workspace.count({
      where: { ...where, stripeSubscriptionId: { not: null } },
    }),
    prisma.workspace.count({
      where: { ...where, subscriptionStatus: "past_due" },
    }),
    prisma.workspace.count({
      where: { ...where, plan: { in: [Plan.PRO, Plan.BUSINESS] } },
    }),
    prisma.workspace.count({ where: { ...where, plan: Plan.FREE } }),
    prisma.workspace.count({ where: { ...where, plan: Plan.PRO } }),
    prisma.workspace.count({ where: { ...where, plan: Plan.BUSINESS } }),
    prisma.workspace.findMany({
      where,
      select: rowSelect,
      orderBy: [{ updatedAt: "desc" }],
      take: platform ? 500 : 1,
    }),
  ]);

  const kpis: AdminSubscriptionsKpi[] =
    scope === "platform"
      ? [
          {
            label: "Workspaces",
            value: String(total),
            hint: "In directory",
          },
          {
            label: "Stripe subscriptions",
            value: String(withStripeSub),
            hint: "Linked sub ID",
          },
          {
            label: "Past due",
            value: String(pastDue),
            hint: subscriptionHint(pastDue),
          },
          {
            label: "PRO / Business (plan)",
            value: `${paidPlanCount} paid`,
            hint: `${proCount} PRO · ${businessCount} Business · ${freePlanCount} free`,
          },
        ]
      : [
          {
            label: "This workspace",
            value: rows[0]?.name ?? "—",
            hint: rows[0]?.slug,
          },
          {
            label: "Stripe subscription",
            value: rows[0]?.stripeSubscriptionId ? "Linked" : "None",
            hint: rows[0]?.stripeSubscriptionId
              ? truncateId(rows[0].stripeSubscriptionId)
              : undefined,
          },
          {
            label: "Status",
            value: rows[0]?.subscriptionStatus ?? "—",
            hint: rows[0] ? formatPlan(rows[0].plan as Plan) : undefined,
          },
          {
            label: "Past due",
            value: rows[0]?.subscriptionStatus === "past_due" ? "Yes" : "No",
            hint: "Stripe subscriptionStatus",
          },
        ];

  const workspaces: AdminSubscriptionWorkspaceRow[] = rows.map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    plan: formatPlan(w.plan),
    stripeCustomerId: w.stripeCustomerId,
    stripeSubscriptionId: w.stripeSubscriptionId,
    subscriptionStatus: w.subscriptionStatus,
    currentPeriodEnd: w.currentPeriodEnd?.toISOString() ?? null,
    updatedAt: w.updatedAt.toISOString(),
  }));

  return {
    scope,
    generatedAt: now.toISOString(),
    meta: adminResponseMeta(
      workspaces.length === 0,
      scope === "platform"
        ? "No workspaces in the database."
        : "No subscription row returned for this workspace."
    ),
    kpis,
    workspaces,
  };
}

function subscriptionHint(pastDue: number): string {
  if (pastDue === 0) return "All clear";
  return "Dunning / payment";
}

function truncateId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

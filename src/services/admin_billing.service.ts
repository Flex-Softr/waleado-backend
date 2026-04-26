import { Plan } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../env";
import type { AdminResponseMeta } from "../lib/admin-response-meta";
import { adminResponseMeta } from "../lib/admin-response-meta";
import { isPlatformOperatorEmail } from "./admin_overview.service";

export type AdminBillingWorkspaceRow = {
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

export type AdminBillingWebhookRow = {
  stripeEventId: string;
  type: string;
  processedAt: string;
};

export type AdminBillingKpi = {
  label: string;
  value: string;
  hint?: string;
};

export type AdminBillingJson = {
  scope: "platform" | "workspace";
  generatedAt: string;
  meta: AdminResponseMeta;
  stripeConfigured: boolean;
  kpis: AdminBillingKpi[];
  workspaces: AdminBillingWorkspaceRow[];
  recentWebhookEvents: AdminBillingWebhookRow[];
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

export async function getAdminBilling(
  operatorEmail: string,
  workspaceId: string
): Promise<AdminBillingJson> {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const platform = isPlatformOperatorEmail(operatorEmail);
  const scope = platform ? "platform" : "workspace";
  const where = platform ? {} : { id: workspaceId };
  const stripeConfigured = Boolean(env.STRIPE_SECRET_KEY?.trim());

  const [
    total,
    stripeCustomers,
    pastDue,
    paidPlanCount,
    demoBilling,
    rows,
    webhook24h,
    recentEvents,
  ] = await Promise.all([
    prisma.workspace.count({ where }),
    prisma.workspace.count({
      where: { ...where, stripeCustomerId: { not: null } },
    }),
    prisma.workspace.count({
      where: { ...where, subscriptionStatus: "past_due" },
    }),
    prisma.workspace.count({
      where: { ...where, plan: { in: [Plan.PRO, Plan.BUSINESS] } },
    }),
    prisma.workspace.count({
      where: { ...where, subscriptionStatus: "demo" },
    }),
    prisma.workspace.findMany({
      where,
      select: rowSelect,
      orderBy: [{ updatedAt: "desc" }],
      take: platform ? 500 : 1,
    }),
    platform
      ? prisma.stripeEventLog.count({
          where: { processedAt: { gte: dayAgo } },
        })
      : Promise.resolve(0),
    platform
      ? prisma.stripeEventLog.findMany({
          select: {
            stripeEventId: true,
            type: true,
            processedAt: true,
          },
          orderBy: { processedAt: "desc" },
          take: 40,
        })
      : Promise.resolve([]),
  ]);

  const kpis: AdminBillingKpi[] =
    scope === "platform"
      ? [
          {
            label: "Stripe API",
            value: stripeConfigured ? "Configured" : "Not configured",
            hint: stripeConfigured ? "Secret key set" : "Checkout uses demo mode",
          },
          {
            label: "Paid workspaces",
            value: String(paidPlanCount),
            hint: `${total} total · ${stripeCustomers} with customer ID`,
          },
          {
            label: "Past due",
            value: String(pastDue),
            hint: pastDue === 0 ? "No dunning queue" : "Stripe subscriptionStatus",
          },
          {
            label: "Demo billing",
            value: String(demoBilling),
            hint: "No Stripe sub (local dev)",
          },
          {
            label: "Webhooks (24h)",
            value: String(webhook24h),
            hint: "Stripe events processed",
          },
        ]
      : [
          {
            label: "Stripe API",
            value: stripeConfigured ? "Configured" : "Not configured",
            hint: undefined,
          },
          {
            label: "Workspace",
            value: rows[0]?.name ?? "—",
            hint: rows[0]?.slug,
          },
          {
            label: "Plan",
            value: rows[0] ? formatPlan(rows[0].plan) : "—",
            hint: rows[0]?.subscriptionStatus
              ? `Status: ${rows[0].subscriptionStatus}`
              : undefined,
          },
          {
            label: "Period end",
            value: rows[0]?.currentPeriodEnd
              ? rows[0].currentPeriodEnd.toISOString().slice(0, 10)
              : "—",
            hint: rows[0]?.stripeCustomerId
              ? `Cust. ${shortId(rows[0].stripeCustomerId)}`
              : undefined,
          },
          {
            label: "Past due",
            value:
              rows[0]?.subscriptionStatus === "past_due" ? "Yes" : "No",
            hint: undefined,
          },
        ];

  const workspaces: AdminBillingWorkspaceRow[] = rows.map((w) => ({
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

  const recentWebhookEvents: AdminBillingWebhookRow[] = recentEvents.map(
    (e) => ({
      stripeEventId: e.stripeEventId,
      type: e.type,
      processedAt: e.processedAt.toISOString(),
    })
  );

  return {
    scope,
    generatedAt: now.toISOString(),
    meta: adminResponseMeta(
      workspaces.length === 0,
      scope === "platform"
        ? "No workspaces to show."
        : "No billing row for this workspace."
    ),
    stripeConfigured,
    kpis,
    workspaces,
    recentWebhookEvents,
  };
}

function shortId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

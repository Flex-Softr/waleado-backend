import { DeviceStatus, Plan } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { AdminResponseMeta } from "../lib/admin-response-meta";
import { adminResponseMeta } from "../lib/admin-response-meta";
import { isPlatformOperatorEmail } from "./admin_overview.service";

export type AdminTenantRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  subscriptionStatus: string | null;
  memberCount: number;
  deviceCount: number;
  connectedDevices: number;
  createdAt: string;
  updatedAt: string;
};

export type AdminTenantsKpi = {
  label: string;
  value: string;
  hint?: string;
};

export type AdminTenantsJson = {
  scope: "platform" | "workspace";
  generatedAt: string;
  meta: AdminResponseMeta;
  kpis: AdminTenantsKpi[];
  tenants: AdminTenantRow[];
};

function formatPlan(p: Plan): string {
  return p.charAt(0) + p.slice(1).toLowerCase();
}

export async function getAdminTenants(
  operatorEmail: string,
  workspaceId: string
): Promise<AdminTenantsJson> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const platform = isPlatformOperatorEmail(operatorEmail);
  const scope = platform ? "platform" : "workspace";
  const where = platform ? {} : { id: workspaceId };

  const [
    total,
    paidPlanCount,
    freePlanCount,
    pastDue,
    totalMembers,
    totalDevices,
    newWorkspaces7d,
    rows,
  ] = await Promise.all([
    prisma.workspace.count({ where }),
    prisma.workspace.count({
      where: { ...where, plan: { in: [Plan.PRO, Plan.BUSINESS] } },
    }),
    prisma.workspace.count({ where: { ...where, plan: Plan.FREE } }),
    prisma.workspace.count({
      where: { ...where, subscriptionStatus: "past_due" },
    }),
    platform
      ? prisma.membership.count()
      : prisma.membership.count({ where: { workspaceId } }),
    platform
      ? prisma.device.count()
      : prisma.device.count({ where: { workspaceId } }),
    prisma.workspace.count({
      where: { ...where, createdAt: { gte: sevenDaysAgo } },
    }),
    prisma.workspace.findMany({
      where,
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        subscriptionStatus: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            memberships: true,
            devices: true,
          },
        },
      },
      orderBy: [{ updatedAt: "desc" }],
      take: platform ? 500 : 1,
    }),
  ]);

  const ids = rows.map((r) => r.id);
  const connectedByWs =
    ids.length === 0
      ? []
      : await prisma.device.groupBy({
          by: ["workspaceId"],
          where: {
            status: DeviceStatus.CONNECTED,
            workspaceId: { in: ids },
          },
          _count: { _all: true },
        });
  const connectedMap = new Map(
    connectedByWs.map((c) => [c.workspaceId, c._count._all])
  );

  const kpis: AdminTenantsKpi[] =
    scope === "platform"
      ? [
          {
            label: "Workspaces",
            value: String(total),
            hint: `${newWorkspaces7d} new (7d)`,
          },
          {
            label: "Paid / free",
            value: `${paidPlanCount} / ${freePlanCount}`,
            hint:
              pastDue > 0
                ? `${pastDue} past_due`
                : "By plan column",
          },
          {
            label: "Members",
            value: String(totalMembers),
            hint: "All memberships",
          },
          {
            label: "Devices",
            value: String(totalDevices),
            hint: "WhatsApp sessions registered",
          },
        ]
      : [
          {
            label: "Workspace",
            value: rows[0]?.name ?? "—",
            hint: rows[0]?.slug,
          },
          {
            label: "Plan",
            value: rows[0] ? formatPlan(rows[0].plan) : "—",
            hint: rows[0]?.subscriptionStatus ?? undefined,
          },
          {
            label: "Members",
            value: rows[0] ? String(rows[0]._count.memberships) : "—",
            hint: "Seats in this workspace",
          },
          {
            label: "Devices",
            value: rows[0] ? String(rows[0]._count.devices) : "—",
            hint: rows[0]
              ? `${connectedMap.get(rows[0].id) ?? 0} connected`
              : undefined,
          },
        ];

  const tenants: AdminTenantRow[] = rows.map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    plan: formatPlan(w.plan),
    subscriptionStatus: w.subscriptionStatus,
    memberCount: w._count.memberships,
    deviceCount: w._count.devices,
    connectedDevices: connectedMap.get(w.id) ?? 0,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  }));

  return {
    scope,
    generatedAt: now.toISOString(),
    meta: adminResponseMeta(
      tenants.length === 0,
      scope === "platform"
        ? "No workspaces in the database."
        : "Workspace row missing or inaccessible."
    ),
    kpis,
    tenants,
  };
}

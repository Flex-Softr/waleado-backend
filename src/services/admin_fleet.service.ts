import { DeviceStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { AdminResponseMeta } from "../lib/admin-response-meta";
import { adminResponseMeta } from "../lib/admin-response-meta";
import { isPlatformOperatorEmail } from "./admin_overview.service";

export type AdminFleetDeviceRow = {
  id: string;
  name: string;
  sessionId: string;
  status: string;
  phone: string | null;
  workspaceName: string;
  workspaceSlug: string;
  createdAt: string;
  updatedAt: string;
};

export type AdminFleetKpi = {
  label: string;
  value: string;
  hint?: string;
};

export type AdminFleetStatusBreakdown = {
  status: string;
  count: number;
};

export type AdminFleetJson = {
  scope: "platform" | "workspace";
  generatedAt: string;
  meta: AdminResponseMeta;
  kpis: AdminFleetKpi[];
  byStatus: AdminFleetStatusBreakdown[];
  devices: AdminFleetDeviceRow[];
};

const dw = (platform: boolean, workspaceId: string) =>
  platform ? {} : { workspaceId };

export async function getAdminFleet(
  operatorEmail: string,
  workspaceId: string
): Promise<AdminFleetJson> {
  const now = new Date();
  const platform = isPlatformOperatorEmail(operatorEmail);
  const scope = platform ? "platform" : "workspace";
  const where = dw(platform, workspaceId);

  const [
    total,
    connected,
    qrReady,
    workspacesWithAnyDevice,
    workspacesWithConnected,
    byStatusGroups,
    rows,
  ] = await Promise.all([
    prisma.device.count({ where }),
    prisma.device.count({
      where: { ...where, status: DeviceStatus.CONNECTED },
    }),
    prisma.device.count({
      where: { ...where, status: DeviceStatus.QR_READY },
    }),
    platform
      ? prisma.workspace.count({ where: { devices: { some: {} } } })
      : prisma.workspace.count({
          where: { id: workspaceId, devices: { some: {} } },
        }),
    platform
      ? prisma.workspace.count({
          where: { devices: { some: { status: DeviceStatus.CONNECTED } } },
        })
      : prisma.workspace.count({
          where: {
            id: workspaceId,
            devices: { some: { status: DeviceStatus.CONNECTED } },
          },
        }),
    prisma.device.groupBy({
      by: ["status"],
      where,
      _count: { _all: true },
    }),
    prisma.device.findMany({
      where,
      select: {
        id: true,
        name: true,
        sessionId: true,
        status: true,
        phone: true,
        createdAt: true,
        updatedAt: true,
        workspace: { select: { name: true, slug: true } },
      },
      orderBy: [{ updatedAt: "desc" }],
      take: platform ? 500 : 200,
    }),
  ]);

  const kpis: AdminFleetKpi[] =
    scope === "platform"
      ? [
          {
            label: "Devices",
            value: String(total),
            hint: `${connected} connected · ${qrReady} QR pending`,
          },
          {
            label: "Workspaces w/ device",
            value: String(workspacesWithAnyDevice),
            hint: `${workspacesWithConnected} with an online session`,
          },
          {
            label: "Online / total",
            value: `${connected} / ${total}`,
            hint:
              total > 0
                ? `${Math.round((connected / total) * 100)}% connected`
                : "No devices",
          },
        ]
      : [
          {
            label: "Sessions",
            value: String(total),
            hint: `${connected} connected`,
          },
          {
            label: "Awaiting QR",
            value: String(qrReady),
            hint: undefined,
          },
          {
            label: "Online / total",
            value: `${connected} / ${total}`,
            hint:
              total > 0
                ? `${Math.round((connected / total) * 100)}% connected`
                : undefined,
          },
        ];

  const byStatus: AdminFleetStatusBreakdown[] = byStatusGroups
    .map((g) => ({
      status: g.status,
      count: g._count._all,
    }))
    .sort((a, b) => b.count - a.count);

  const devices: AdminFleetDeviceRow[] = rows.map((d) => ({
    id: d.id,
    name: d.name,
    sessionId: d.sessionId,
    status: d.status,
    phone: d.phone,
    workspaceName: d.workspace.name,
    workspaceSlug: d.workspace.slug,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  }));

  return {
    scope,
    generatedAt: now.toISOString(),
    meta: adminResponseMeta(
      devices.length === 0,
      "No WhatsApp devices registered. Add a session from the Devices page."
    ),
    kpis,
    byStatus,
    devices,
  };
}

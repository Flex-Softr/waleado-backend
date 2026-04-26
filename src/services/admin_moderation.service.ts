import { BulkCampaignStatus, OutboundStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { AdminResponseMeta } from "../lib/admin-response-meta";
import { adminResponseMeta } from "../lib/admin-response-meta";
import { isPlatformOperatorEmail } from "./admin_overview.service";

export type AdminModerationKpi = {
  label: string;
  value: string;
  hint?: string;
};

export type AdminModerationFailureRow = {
  id: string;
  toPhone: string;
  kind: string;
  errorMessage: string | null;
  workspaceName: string;
  workspaceSlug: string;
  deviceName: string;
  bulkCampaignName: string | null;
  createdAt: string;
};

export type AdminModerationWorkspaceLeader = {
  name: string;
  slug: string;
  failed30d: number;
};

export type AdminModerationJson = {
  scope: "platform" | "workspace";
  generatedAt: string;
  meta: AdminResponseMeta;
  kpis: AdminModerationKpi[];
  recentFailures: AdminModerationFailureRow[];
  topFailedWorkspaces: AdminModerationWorkspaceLeader[];
};

const mw = (platform: boolean, workspaceId: string) =>
  platform ? {} : { workspaceId };

export async function getAdminModeration(
  operatorEmail: string,
  workspaceId: string
): Promise<AdminModerationJson> {
  const now = new Date();
  const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const platform = isPlatformOperatorEmail(operatorEmail);
  const scope = platform ? "platform" : "workspace";
  const where = mw(platform, workspaceId);

  const [
    failed24h,
    failed7d,
    failed30d,
    stuckQueued,
    simulated24h,
    bulkFailed,
    recentRows,
    topFailedGroups,
  ] = await Promise.all([
    prisma.outboundMessage.count({
      where: { ...where, status: OutboundStatus.FAILED, createdAt: { gte: h24 } },
    }),
    prisma.outboundMessage.count({
      where: { ...where, status: OutboundStatus.FAILED, createdAt: { gte: d7 } },
    }),
    prisma.outboundMessage.count({
      where: {
        ...where,
        status: OutboundStatus.FAILED,
        createdAt: { gte: d30 },
      },
    }),
    prisma.outboundMessage.count({
      where: {
        ...where,
        status: OutboundStatus.QUEUED,
        createdAt: { lt: hourAgo },
      },
    }),
    prisma.outboundMessage.count({
      where: {
        ...where,
        status: OutboundStatus.SIMULATED,
        createdAt: { gte: h24 },
      },
    }),
    prisma.bulkCampaign.count({
      where: { ...where, status: BulkCampaignStatus.FAILED },
    }),
    prisma.outboundMessage.findMany({
      where: { ...where, status: OutboundStatus.FAILED },
      select: {
        id: true,
        toPhone: true,
        kind: true,
        errorMessage: true,
        createdAt: true,
        workspace: { select: { name: true, slug: true } },
        device: { select: { name: true } },
        bulkCampaign: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: platform ? 150 : 200,
    }),
    platform
      ? prisma.outboundMessage.groupBy({
          by: ["workspaceId"],
          where: {
            status: OutboundStatus.FAILED,
            createdAt: { gte: d30 },
          },
          _count: { _all: true },
          orderBy: { _count: { id: "desc" } },
          take: 20,
        })
      : Promise.resolve(
          [] as { workspaceId: string; _count: { _all: number } }[]
        ),
  ]);

  const kpis: AdminModerationKpi[] =
    scope === "platform"
      ? [
          {
            label: "Failed sends (24h)",
            value: String(failed24h),
            hint: `${failed7d} (7d) · ${failed30d} (30d)`,
          },
          {
            label: "Stuck queued (>1h)",
            value: String(stuckQueued),
            hint: "Still QUEUED after 1 hour",
          },
          {
            label: "Bulk campaigns failed",
            value: String(bulkFailed),
            hint: "Lifetime in scope",
          },
          {
            label: "Simulated (24h)",
            value: String(simulated24h),
            hint: "Dev / no real send",
          },
        ]
      : [
          {
            label: "Failed sends (24h)",
            value: String(failed24h),
            hint: `${failed30d} (30d)`,
          },
          {
            label: "Stuck queued (>1h)",
            value: String(stuckQueued),
            hint: undefined,
          },
          {
            label: "Bulk campaigns failed",
            value: String(bulkFailed),
            hint: undefined,
          },
          {
            label: "Simulated (24h)",
            value: String(simulated24h),
            hint: undefined,
          },
        ];

  const recentFailures: AdminModerationFailureRow[] = recentRows.map((r) => ({
    id: r.id,
    toPhone: r.toPhone,
    kind: r.kind,
    errorMessage: r.errorMessage,
    workspaceName: r.workspace.name,
    workspaceSlug: r.workspace.slug,
    deviceName: r.device.name,
    bulkCampaignName: r.bulkCampaign?.name ?? null,
    createdAt: r.createdAt.toISOString(),
  }));

  let topFailedWorkspaces: AdminModerationWorkspaceLeader[] = [];
  if (topFailedGroups.length > 0) {
    const ids = topFailedGroups.map((g) => g.workspaceId);
    const wsRows = await prisma.workspace.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, slug: true },
    });
    const wsMap = new Map(wsRows.map((w) => [w.id, w]));
    topFailedWorkspaces = topFailedGroups.map((g) => {
      const w = wsMap.get(g.workspaceId);
      return {
        name: w?.name ?? g.workspaceId.slice(0, 8),
        slug: w?.slug ?? "—",
        failed30d: g._count._all,
      };
    });
  }

  return {
    scope,
    generatedAt: now.toISOString(),
    meta: adminResponseMeta(false),
    kpis,
    recentFailures,
    topFailedWorkspaces,
  };
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminModeration = getAdminModeration;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const admin_response_meta_1 = require("../lib/admin-response-meta");
const admin_overview_service_1 = require("./admin_overview.service");
const mw = (platform, workspaceId) => platform ? {} : { workspaceId };
async function getAdminModeration(operatorEmail, workspaceId) {
    const now = new Date();
    const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const platform = (0, admin_overview_service_1.isPlatformOperatorEmail)(operatorEmail);
    const scope = platform ? "platform" : "workspace";
    const where = mw(platform, workspaceId);
    const [failed24h, failed7d, failed30d, stuckQueued, simulated24h, bulkFailed, recentRows, topFailedGroups,] = await Promise.all([
        prisma_1.prisma.outboundMessage.count({
            where: { ...where, status: client_1.OutboundStatus.FAILED, createdAt: { gte: h24 } },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: { ...where, status: client_1.OutboundStatus.FAILED, createdAt: { gte: d7 } },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: {
                ...where,
                status: client_1.OutboundStatus.FAILED,
                createdAt: { gte: d30 },
            },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: {
                ...where,
                status: client_1.OutboundStatus.QUEUED,
                createdAt: { lt: hourAgo },
            },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: {
                ...where,
                status: client_1.OutboundStatus.SIMULATED,
                createdAt: { gte: h24 },
            },
        }),
        prisma_1.prisma.bulkCampaign.count({
            where: { ...where, status: client_1.BulkCampaignStatus.FAILED },
        }),
        prisma_1.prisma.outboundMessage.findMany({
            where: { ...where, status: client_1.OutboundStatus.FAILED },
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
            ? prisma_1.prisma.outboundMessage.groupBy({
                by: ["workspaceId"],
                where: {
                    status: client_1.OutboundStatus.FAILED,
                    createdAt: { gte: d30 },
                },
                _count: { _all: true },
                orderBy: { _count: { id: "desc" } },
                take: 20,
            })
            : Promise.resolve([]),
    ]);
    const kpis = scope === "platform"
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
    const recentFailures = recentRows.map((r) => ({
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
    let topFailedWorkspaces = [];
    if (topFailedGroups.length > 0) {
        const ids = topFailedGroups.map((g) => g.workspaceId);
        const wsRows = await prisma_1.prisma.workspace.findMany({
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
        meta: (0, admin_response_meta_1.adminResponseMeta)(false),
        kpis,
        recentFailures,
        topFailedWorkspaces,
    };
}

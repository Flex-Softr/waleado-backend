"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminUsage = getAdminUsage;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const admin_response_meta_1 = require("../lib/admin-response-meta");
const admin_overview_service_1 = require("./admin_overview.service");
function formatCompact(n) {
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000)
        return `${Math.round(n / 1000)}K`;
    if (n >= 1000)
        return `${(n / 1000).toFixed(1)}K`;
    return String(n);
}
function pctChange(current, previous) {
    if (previous === 0 && current === 0)
        return "0%";
    if (previous === 0)
        return "+100%";
    const raw = ((current - previous) / previous) * 100;
    const rounded = Math.round(raw * 10) / 10;
    const sign = rounded > 0 ? "+" : "";
    return `${sign}${rounded}%`;
}
const msgWhere = (platform, workspaceId) => platform ? {} : { workspaceId };
async function getAdminUsage(operatorEmail, workspaceId) {
    const now = new Date();
    const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const h48 = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const platform = (0, admin_overview_service_1.isPlatformOperatorEmail)(operatorEmail);
    const scope = platform ? "platform" : "workspace";
    const mw = msgWhere(platform, workspaceId);
    const [last24h, previous24h, last7d, last30d, failed24h, byStatus30d, byKind30d, templates, contacts, contactGroups, bulkCampaigns, autoReplyRules, chatbotFlows, liveChatThreads, topGroups,] = await Promise.all([
        prisma_1.prisma.outboundMessage.count({
            where: { ...mw, createdAt: { gte: h24 } },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: { ...mw, createdAt: { gte: h48, lt: h24 } },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: { ...mw, createdAt: { gte: d7 } },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: { ...mw, createdAt: { gte: d30 } },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: {
                ...mw,
                status: client_1.OutboundStatus.FAILED,
                createdAt: { gte: h24 },
            },
        }),
        prisma_1.prisma.outboundMessage.groupBy({
            by: ["status"],
            where: { ...mw, createdAt: { gte: d30 } },
            _count: { _all: true },
        }),
        prisma_1.prisma.outboundMessage.groupBy({
            by: ["kind"],
            where: { ...mw, createdAt: { gte: d30 } },
            _count: { _all: true },
        }),
        prisma_1.prisma.messageTemplate.count({
            where: platform ? {} : { workspaceId },
        }),
        prisma_1.prisma.contact.count({
            where: platform ? {} : { group: { workspaceId } },
        }),
        prisma_1.prisma.contactGroup.count({
            where: platform ? {} : { workspaceId },
        }),
        prisma_1.prisma.bulkCampaign.count({
            where: platform ? {} : { workspaceId },
        }),
        prisma_1.prisma.autoReplyRule.count({
            where: platform ? {} : { workspaceId },
        }),
        prisma_1.prisma.chatbotFlow.count({
            where: platform ? {} : { workspaceId },
        }),
        prisma_1.prisma.liveChatThread.count({
            where: platform ? {} : { workspaceId },
        }),
        platform
            ? prisma_1.prisma.outboundMessage.groupBy({
                by: ["workspaceId"],
                where: { createdAt: { gte: d30 } },
                _count: { _all: true },
                orderBy: { _count: { id: "desc" } },
                take: 25,
            })
            : Promise.resolve([]),
    ]);
    const trend = pctChange(last24h, previous24h);
    const kpis = scope === "platform"
        ? [
            {
                label: "Outbound (24h)",
                value: formatCompact(last24h),
                hint: `${trend} vs prior 24h`,
            },
            {
                label: "Outbound (7d)",
                value: formatCompact(last7d),
                hint: "All workspaces",
            },
            {
                label: "Outbound (30d)",
                value: formatCompact(last30d),
                hint: "Rolling month",
            },
            {
                label: "Failed (24h)",
                value: String(failed24h),
                hint: last24h > 0
                    ? `${((failed24h / last24h) * 100).toFixed(1)}% of sends`
                    : "No volume",
            },
        ]
        : [
            {
                label: "Outbound (24h)",
                value: formatCompact(last24h),
                hint: `${trend} vs prior 24h`,
            },
            {
                label: "Outbound (7d)",
                value: formatCompact(last7d),
                hint: "This workspace",
            },
            {
                label: "Outbound (30d)",
                value: formatCompact(last30d),
                hint: undefined,
            },
            {
                label: "Failed (24h)",
                value: String(failed24h),
                hint: last24h > 0
                    ? `${((failed24h / last24h) * 100).toFixed(1)}% of sends`
                    : undefined,
            },
        ];
    const statusBreakdown = byStatus30d
        .map((g) => ({
        key: g.status,
        count: g._count._all,
    }))
        .sort((a, b) => b.count - a.count);
    const kindBreakdown = byKind30d
        .map((g) => ({
        key: g.kind,
        count: g._count._all,
    }))
        .sort((a, b) => b.count - a.count);
    let topWorkspaces = [];
    if (topGroups.length > 0) {
        const wsIds = topGroups.map((t) => t.workspaceId);
        const wsRows = await prisma_1.prisma.workspace.findMany({
            where: { id: { in: wsIds } },
            select: { id: true, name: true, slug: true },
        });
        const wsMap = new Map(wsRows.map((w) => [w.id, w]));
        topWorkspaces = topGroups.map((g) => {
            const w = wsMap.get(g.workspaceId);
            return {
                name: w?.name ?? g.workspaceId.slice(0, 8),
                slug: w?.slug ?? "—",
                outbound30d: g._count._all,
            };
        });
    }
    const invSum = templates +
        contacts +
        contactGroups +
        bulkCampaigns +
        autoReplyRules +
        chatbotFlows +
        liveChatThreads;
    return {
        scope,
        generatedAt: now.toISOString(),
        meta: (0, admin_response_meta_1.adminResponseMeta)(last30d === 0 && invSum === 0, "No outbound or feature objects in scope yet."),
        kpis,
        outbound: {
            last24h,
            previous24h,
            last7d,
            last30d,
            failed24h,
        },
        byStatus30d: statusBreakdown,
        byKind30d: kindBreakdown,
        inventory: {
            templates,
            contacts,
            contactGroups,
            bulkCampaigns,
            autoReplyRules,
            chatbotFlows,
            liveChatThreads,
        },
        topWorkspaces,
    };
}

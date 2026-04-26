"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDashboardOverview = getDashboardOverview;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const env_1 = require("../env");
function startOfUtcDay(d) {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    return x;
}
function pctChangeLabel(current, previous) {
    if (previous === 0 && current === 0) {
        return { label: "—", trend: "neutral" };
    }
    if (previous === 0) {
        return { label: "+100%", trend: "positive" };
    }
    const raw = ((current - previous) / previous) * 100;
    const rounded = Math.round(raw * 10) / 10;
    const sign = rounded > 0 ? "+" : "";
    const trend = rounded > 0 ? "positive" : rounded < 0 ? "negative" : "neutral";
    return { label: `${sign}${rounded}%`, trend };
}
function formatCompact(n) {
    if (n >= 1_000_000)
        return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000)
        return `${Math.round(n / 1000)}K`;
    if (n >= 1000)
        return `${(n / 1000).toFixed(1)}K`;
    return String(n);
}
function formatPct(p) {
    if (!Number.isFinite(p))
        return "—";
    return `${Math.round(p * 10) / 10}%`;
}
async function getDashboardOverview(workspaceId) {
    const now = new Date();
    const todayStart = startOfUtcDay(now);
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const d60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 5);
    sixMonthsAgo.setUTCDate(1);
    sixMonthsAgo.setUTCHours(0, 0, 0, 0);
    const lineFrom = new Date(now);
    lineFrom.setUTCDate(lineFrom.getUTCDate() - 13);
    lineFrom.setUTCHours(0, 0, 0, 0);
    const [devicesTotal, devicesOnline, messagesToday, outboundLast30, outboundPrev30, outboundStatus30, liveThreadsTotal, liveThreads30, threadsNewLast30, threadsNewPrev30, contactsCount, bulkLast30, bulkPrev30, bulkTotals, autoReplyAgg, chatbotTotals, chatbotActiveCount, templateGroups,] = await Promise.all([
        prisma_1.prisma.device.count({ where: { workspaceId } }),
        prisma_1.prisma.device.count({
            where: { workspaceId, status: client_1.DeviceStatus.CONNECTED },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: { workspaceId, createdAt: { gte: todayStart } },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: { workspaceId, createdAt: { gte: d30 } },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: { workspaceId, createdAt: { gte: d60, lt: d30 } },
        }),
        prisma_1.prisma.outboundMessage.groupBy({
            by: ["status"],
            where: { workspaceId, createdAt: { gte: d30 } },
            _count: { _all: true },
        }),
        prisma_1.prisma.liveChatThread.count({ where: { workspaceId } }),
        prisma_1.prisma.liveChatThread.count({
            where: {
                workspaceId,
                OR: [{ lastMessageAt: { gte: d30 } }, { createdAt: { gte: d30 } }],
            },
        }),
        prisma_1.prisma.liveChatThread.count({
            where: { workspaceId, createdAt: { gte: d30 } },
        }),
        prisma_1.prisma.liveChatThread.count({
            where: { workspaceId, createdAt: { gte: d60, lt: d30 } },
        }),
        prisma_1.prisma.contact.count({
            where: { group: { workspaceId } },
        }),
        prisma_1.prisma.bulkCampaign.count({
            where: { workspaceId, createdAt: { gte: d30 } },
        }),
        prisma_1.prisma.bulkCampaign.count({
            where: { workspaceId, createdAt: { gte: d60, lt: d30 } },
        }),
        prisma_1.prisma.bulkCampaign.groupBy({
            by: ["status"],
            where: { workspaceId },
            _count: { _all: true },
        }),
        prisma_1.prisma.autoReplyRule.aggregate({
            where: { workspaceId },
            _count: { _all: true },
            _sum: { responseCount: true },
        }),
        prisma_1.prisma.chatbotFlow.aggregate({
            where: { workspaceId },
            _count: { _all: true },
            _sum: { conversationCount: true },
        }),
        prisma_1.prisma.chatbotFlow.count({
            where: { workspaceId, active: true },
        }),
        prisma_1.prisma.messageTemplate.groupBy({
            by: ["active"],
            where: { workspaceId },
            _count: { _all: true },
        }),
    ]);
    const dayStartUtc = startOfUtcDay(now);
    const [outboundForCharts, liveChatOutboundRows] = await Promise.all([
        prisma_1.prisma.outboundMessage.findMany({
            where: { workspaceId, createdAt: { gte: sixMonthsAgo } },
            select: {
                id: true,
                createdAt: true,
                kind: true,
                bulkCampaignId: true,
            },
        }),
        prisma_1.prisma.liveChatMessage.findMany({
            where: {
                direction: client_1.LiveChatMessageDirection.OUTBOUND,
                outboundMessageId: { not: null },
                thread: { workspaceId },
                outboundMessage: {
                    workspaceId,
                    createdAt: { gte: lineFrom },
                },
            },
            select: {
                outboundMessage: { select: { createdAt: true } },
            },
        }),
    ]);
    const activeAutoRules = await prisma_1.prisma.autoReplyRule.count({
        where: { workspaceId, active: true },
    });
    const totalAutoRules = autoReplyAgg._count._all;
    const totalResponses = autoReplyAgg._sum.responseCount ?? 0;
    const totalFlows = chatbotTotals._count._all;
    const flowConversations = chatbotTotals._sum.conversationCount ?? 0;
    const activeFlows = chatbotActiveCount;
    let templatesActive = 0;
    let templatesInactive = 0;
    for (const g of templateGroups) {
        if (g.active)
            templatesActive = g._count._all;
        else
            templatesInactive = g._count._all;
    }
    const templatesTotal = templatesActive + templatesInactive;
    let bulkScheduled = 0;
    let bulkCompleted = 0;
    let bulkFailed = 0;
    for (const g of bulkTotals) {
        if (g.status === "SCHEDULED")
            bulkScheduled = g._count._all;
        if (g.status === "COMPLETED")
            bulkCompleted = g._count._all;
        if (g.status === "FAILED")
            bulkFailed = g._count._all;
    }
    const bulkCampaignsTotal = bulkScheduled + bulkCompleted + bulkFailed;
    let sentOk = 0;
    let sentFail = 0;
    for (const g of outboundStatus30) {
        if (g.status === client_1.OutboundStatus.SENT || g.status === client_1.OutboundStatus.SIMULATED) {
            sentOk += g._count._all;
        }
        if (g.status === client_1.OutboundStatus.FAILED) {
            sentFail += g._count._all;
        }
    }
    const settled = sentOk + sentFail;
    const deliveryRate = settled > 0 ? (sentOk / settled) * 100 : 100;
    const msgTrend = pctChangeLabel(outboundLast30, outboundPrev30);
    const bulkTrend = pctChangeLabel(bulkLast30, bulkPrev30);
    const threadsTrend = pctChangeLabel(threadsNewLast30, threadsNewPrev30);
    const bridge = env_1.env.WHATSAPP_BRIDGE_ENABLED;
    let systemStatus;
    if (!bridge) {
        systemStatus = "offline";
    }
    else if (devicesOnline === 0) {
        systemStatus = "degraded";
    }
    else {
        systemStatus = "online";
    }
    const lastUpdatedLabel = now.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
    const kpis = [
        {
            id: "devices",
            label: "Connected devices",
            value: devicesTotal === 0
                ? "0"
                : `${devicesOnline} / ${devicesTotal}`,
            period: "Of registered devices",
            changeLabel: "—",
            trend: "neutral",
            iconKey: "sessions",
        },
        {
            id: "messages",
            label: "Outbound messages",
            value: formatCompact(outboundLast30),
            period: "Last 30 days",
            changeLabel: msgTrend.label,
            trend: msgTrend.trend,
            iconKey: "messages",
        },
        {
            id: "delivery",
            label: "Send success rate",
            value: formatPct(deliveryRate),
            period: "Last 30 days (sent vs failed)",
            changeLabel: settled === 0
                ? "No settled sends"
                : sentFail === 0
                    ? "No failures"
                    : `${formatCompact(sentFail)} failed`,
            trend: settled === 0 || sentFail === 0 ? "positive" : "negative",
            iconKey: "delivery",
        },
        {
            id: "threads",
            label: "Live chat threads",
            value: formatCompact(liveThreadsTotal),
            period: `${formatCompact(liveThreads30)} with activity (30d)`,
            changeLabel: threadsTrend.label,
            trend: threadsTrend.trend,
            iconKey: "users",
        },
        {
            id: "contacts",
            label: "Contacts",
            value: formatCompact(contactsCount),
            period: "Across all groups",
            changeLabel: "—",
            trend: "neutral",
            iconKey: "response",
        },
        {
            id: "campaigns",
            label: "Bulk campaigns",
            value: formatCompact(bulkLast30),
            period: "Created last 30 days",
            changeLabel: bulkTrend.label,
            trend: bulkTrend.trend,
            iconKey: "revenue",
        },
    ];
    const barByYm = new Map();
    for (const o of outboundForCharts) {
        const y = o.createdAt.getUTCFullYear();
        const m = o.createdAt.getUTCMonth() + 1;
        const k = `${y}-${m}`;
        barByYm.set(k, (barByYm.get(k) ?? 0) + 1);
    }
    const barSeries = [];
    for (let i = 5; i >= 0; i -= 1) {
        const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
        const y = t.getUTCFullYear();
        const m = t.getUTCMonth() + 1;
        const label = t.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
        barSeries.push({
            label,
            value: barByYm.get(`${y}-${m}`) ?? 0,
        });
    }
    function utcDayKey(d) {
        const y = d.getUTCFullYear();
        const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
        const da = String(d.getUTCDate()).padStart(2, "0");
        return `${y}-${mo}-${da}`;
    }
    const lineByDay = new Map();
    function bumpDay(d) {
        const k = utcDayKey(d);
        let b = lineByDay.get(k);
        if (!b) {
            b = { s1: 0, s2: 0, s3: 0, s4: 0 };
            lineByDay.set(k, b);
        }
        return b;
    }
    for (const o of outboundForCharts) {
        if (o.createdAt < lineFrom)
            continue;
        const b = bumpDay(o.createdAt);
        if (o.bulkCampaignId) {
            b.s1 += 1;
        }
        else if (o.kind === client_1.OutboundKind.TEXT) {
            b.s2 += 1;
        }
        else if (o.kind === client_1.OutboundKind.TEMPLATE) {
            b.s3 += 1;
        }
    }
    for (const row of liveChatOutboundRows) {
        const ca = row.outboundMessage?.createdAt;
        if (!ca || ca < lineFrom)
            continue;
        bumpDay(ca).s4 += 1;
    }
    const lineSeries = [];
    for (let t = new Date(lineFrom); t.getTime() <= dayStartUtc.getTime(); t.setUTCDate(t.getUTCDate() + 1)) {
        const k = utcDayKey(t);
        const b = lineByDay.get(k) ?? { s1: 0, s2: 0, s3: 0, s4: 0 };
        lineSeries.push({
            x: `${t.getUTCMonth() + 1}/${t.getUTCDate()}`,
            s1: b.s1,
            s2: b.s2,
            s3: b.s3,
            s4: b.s4,
        });
    }
    const autoProgress = totalAutoRules > 0
        ? Math.round((activeAutoRules / totalAutoRules) * 100)
        : 0;
    const bulkProgress = bulkCampaignsTotal > 0
        ? Math.round((bulkCompleted / bulkCampaignsTotal) * 100)
        : 0;
    const botProgress = totalFlows > 0 ? Math.round((activeFlows / totalFlows) * 100) : 0;
    const tplProgress = templatesTotal > 0
        ? Math.round((templatesActive / templatesTotal) * 100)
        : 0;
    const summaries = [
        {
            id: "auto-reply",
            title: "Auto reply",
            rows: [
                { label: "Active rules", value: activeAutoRules },
                { label: "Total responses", value: totalResponses },
            ],
            progress: autoProgress,
            icon: "reply",
        },
        {
            id: "bulk",
            title: "Bulk sends",
            rows: [
                { label: "Campaigns", value: bulkCampaignsTotal },
                { label: "Scheduled", value: bulkScheduled },
            ],
            progress: bulkProgress,
            icon: "bulk",
        },
        {
            id: "chatbot",
            title: "Chatbot",
            rows: [
                { label: "Active flows", value: activeFlows },
                { label: "Flow conversations", value: flowConversations },
            ],
            progress: botProgress,
            icon: "bot",
        },
        {
            id: "templates",
            title: "Templates",
            rows: [
                { label: "Active", value: templatesActive },
                { label: "Inactive", value: templatesInactive },
            ],
            progress: tplProgress,
            icon: "template",
        },
    ];
    return {
        generatedAt: now.toISOString(),
        systemStatus,
        lastUpdatedLabel,
        devicesOnline,
        devicesTotal,
        messagesToday,
        kpis,
        barSeries,
        lineSeries,
        summaries,
    };
}

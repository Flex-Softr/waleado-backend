"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPlatformOperatorEmail = isPlatformOperatorEmail;
exports.getAdminOverview = getAdminOverview;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const env_1 = require("../env");
const admin_response_meta_1 = require("../lib/admin-response-meta");
function isPlatformOperatorEmail(email) {
    const raw = env_1.env.PLATFORM_OPERATOR_EMAILS;
    if (!raw?.trim())
        return false;
    const set = new Set(raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean));
    return set.has(email.trim().toLowerCase());
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
function pctChangeLabel(current, previous) {
    if (previous === 0 && current === 0) {
        return { label: "0%", positive: true };
    }
    if (previous === 0) {
        return { label: "+100%", positive: true };
    }
    const raw = ((current - previous) / previous) * 100;
    const rounded = Math.round(raw * 10) / 10;
    const sign = rounded > 0 ? "+" : "";
    return {
        label: `${sign}${rounded}%`,
        positive: rounded >= 0,
    };
}
async function aggregateForWorkspace(workspaceId, now) {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const [workspaceRow, memberCount, devicesTotal, devicesConnected, msg24, msgPrev24, failed24, templates, contacts, bulkCampaigns, messages30d, liveThreads,] = await Promise.all([
        prisma_1.prisma.workspace.findUnique({
            where: { id: workspaceId },
            select: {
                plan: true,
                subscriptionStatus: true,
                stripeSubscriptionId: true,
            },
        }),
        prisma_1.prisma.membership.count({ where: { workspaceId } }),
        prisma_1.prisma.device.count({ where: { workspaceId } }),
        prisma_1.prisma.device.count({
            where: { workspaceId, status: client_1.DeviceStatus.CONNECTED },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: { workspaceId, createdAt: { gte: dayAgo } },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: {
                workspaceId,
                createdAt: { gte: twoDaysAgo, lt: dayAgo },
            },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: {
                workspaceId,
                status: client_1.OutboundStatus.FAILED,
                createdAt: { gte: dayAgo },
            },
        }),
        prisma_1.prisma.messageTemplate.count({ where: { workspaceId } }),
        prisma_1.prisma.contact.count({ where: { group: { workspaceId } } }),
        prisma_1.prisma.bulkCampaign.count({ where: { workspaceId } }),
        prisma_1.prisma.outboundMessage.count({
            where: {
                workspaceId,
                createdAt: {
                    gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
                },
            },
        }),
        prisma_1.prisma.liveChatThread.count({ where: { workspaceId } }),
    ]);
    const paid = workspaceRow?.plan === client_1.Plan.PRO ||
        workspaceRow?.plan === client_1.Plan.BUSINESS ||
        !!workspaceRow?.stripeSubscriptionId;
    const pastDue = workspaceRow?.subscriptionStatus === "past_due" ? 1 : 0;
    return {
        workspaces: 1,
        users: memberCount,
        devicesTotal,
        devicesConnected,
        msg24,
        msgPrev24,
        failed24,
        paidWorkspaces: paid ? 1 : 0,
        freeWorkspaces: paid ? 0 : 1,
        pastDue,
        stripeSubs: workspaceRow?.stripeSubscriptionId ? 1 : 0,
        templates,
        contacts,
        bulkCampaigns,
        messages30d,
        liveThreads,
    };
}
async function aggregatePlatform(now) {
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const [workspaces, users, devicesTotal, devicesConnected, msg24, msgPrev24, failed24, pastDue, paidPlans, stripeSubs, templates, contacts, bulkCampaigns, messages30d, liveThreads,] = await Promise.all([
        prisma_1.prisma.workspace.count(),
        prisma_1.prisma.user.count(),
        prisma_1.prisma.device.count(),
        prisma_1.prisma.device.count({ where: { status: client_1.DeviceStatus.CONNECTED } }),
        prisma_1.prisma.outboundMessage.count({ where: { createdAt: { gte: dayAgo } } }),
        prisma_1.prisma.outboundMessage.count({
            where: { createdAt: { gte: twoDaysAgo, lt: dayAgo } },
        }),
        prisma_1.prisma.outboundMessage.count({
            where: {
                status: client_1.OutboundStatus.FAILED,
                createdAt: { gte: dayAgo },
            },
        }),
        prisma_1.prisma.workspace.count({
            where: { subscriptionStatus: "past_due" },
        }),
        prisma_1.prisma.workspace.count({
            where: { plan: { in: [client_1.Plan.PRO, client_1.Plan.BUSINESS] } },
        }),
        prisma_1.prisma.workspace.count({
            where: { stripeSubscriptionId: { not: null } },
        }),
        prisma_1.prisma.messageTemplate.count(),
        prisma_1.prisma.contact.count(),
        prisma_1.prisma.bulkCampaign.count(),
        prisma_1.prisma.outboundMessage.count({
            where: {
                createdAt: { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
            },
        }),
        prisma_1.prisma.liveChatThread.count(),
    ]);
    return {
        workspaces,
        users,
        devicesTotal,
        devicesConnected,
        msg24,
        msgPrev24,
        failed24,
        pastDue,
        paidWorkspaces: paidPlans,
        freeWorkspaces: workspaces - paidPlans,
        stripeSubs,
        templates,
        contacts,
        bulkCampaigns,
        messages30d,
        liveThreads,
    };
}
function buildModuleStats(a, scope) {
    const hint = scope === "workspace" ? "This workspace" : "All tenants";
    return [
        {
            moduleId: "tenants",
            label: hint,
            value: `${formatCompact(a.workspaces)} workspace${a.workspaces === 1 ? "" : "s"}`,
        },
        {
            moduleId: "users",
            label: hint,
            value: `${formatCompact(a.users)} user${a.users === 1 ? "" : "s"}`,
        },
        {
            moduleId: "subscriptions",
            label: "Stripe-linked",
            value: `${formatCompact(a.stripeSubs)} active cust.`,
        },
        {
            moduleId: "billing",
            label: "PRO + Business",
            value: `${formatCompact(a.paidWorkspaces)} paid`,
        },
        {
            moduleId: "usage",
            label: "30d outbound",
            value: formatCompact(a.messages30d),
        },
        {
            moduleId: "fleet",
            label: "Connected / total",
            value: `${formatCompact(a.devicesConnected)} / ${formatCompact(a.devicesTotal)}`,
        },
        {
            moduleId: "compliance",
            label: "Templates",
            value: formatCompact(a.templates),
        },
        {
            moduleId: "moderation",
            label: "—",
            value: "Queue not wired",
        },
        {
            moduleId: "feature-flags",
            label: "—",
            value: "Configure flags",
        },
        {
            moduleId: "integrations",
            label: "Stripe",
            value: env_1.env.STRIPE_SECRET_KEY ? "Configured" : "Not set",
        },
        {
            moduleId: "system",
            label: "WhatsApp bridge",
            value: env_1.env.WHATSAPP_BRIDGE_ENABLED ? "Enabled" : "Off",
        },
        {
            moduleId: "audit",
            label: "—",
            value: "No events yet",
        },
        {
            moduleId: "support",
            label: "Live chat threads",
            value: formatCompact(a.liveThreads),
        },
        {
            moduleId: "announcements",
            label: "—",
            value: "—",
        },
        {
            moduleId: "reports",
            label: "Contacts",
            value: formatCompact(a.contacts),
        },
        {
            moduleId: "settings",
            label: "Campaigns",
            value: formatCompact(a.bulkCampaigns),
        },
    ];
}
async function getAdminOverview(operatorEmail, workspaceId) {
    const now = new Date();
    const platform = isPlatformOperatorEmail(operatorEmail);
    const scope = platform ? "platform" : "workspace";
    const a = platform
        ? await aggregatePlatform(now)
        : await aggregateForWorkspace(workspaceId, now);
    const msgTrend = pctChangeLabel(a.msg24, a.msgPrev24);
    const kpis = [
        {
            id: "paid",
            label: scope === "platform" ? "Paid workspaces" : "Plan & billing",
            value: scope === "platform"
                ? formatCompact(a.paidWorkspaces)
                : a.paidWorkspaces > 0
                    ? "Paid / Stripe"
                    : "Free",
            delta: scope === "platform"
                ? `${formatCompact(a.freeWorkspaces)} free`
                : a.stripeSubs > 0
                    ? "Subscribed"
                    : "No sub",
            positive: a.paidWorkspaces > 0 || a.stripeSubs > 0,
            hint: scope === "platform"
                ? "PRO + Business plans"
                : "Workspace subscription fields",
        },
        {
            id: "workspaces",
            label: scope === "platform" ? "Workspaces" : "Team members",
            value: scope === "platform"
                ? formatCompact(a.workspaces)
                : formatCompact(a.users),
            delta: scope === "platform" ? `${formatCompact(a.users)} users` : "Seats",
            positive: true,
            hint: scope === "platform"
                ? "Organizations on the platform"
                : "Owner, admin & member roles",
        },
        {
            id: "messages",
            label: "Outbound (24h)",
            value: formatCompact(a.msg24),
            delta: msgTrend.label,
            positive: msgTrend.positive,
            hint: "Across all devices",
        },
        {
            id: "sessions",
            label: "Devices online",
            value: formatCompact(a.devicesConnected),
            delta: `${formatCompact(a.devicesTotal)} registered`,
            positive: a.devicesConnected > 0,
            hint: "WhatsApp sessions connected",
        },
        {
            id: "past_due",
            label: "Past-due subs",
            value: String(a.pastDue),
            delta: a.pastDue ? "Needs attention" : "Clear",
            positive: a.pastDue === 0,
            hint: "Stripe subscriptionStatus",
        },
        {
            id: "failures",
            label: "Failed sends (24h)",
            value: String(a.failed24),
            delta: a.failed24 === 0 ? "None" : "Review queue",
            positive: a.failed24 === 0,
            hint: "OutboundMessage FAILED",
        },
    ];
    const emptyPlatform = platform && a.workspaces === 0;
    return {
        scope,
        generatedAt: now.toISOString(),
        meta: (0, admin_response_meta_1.adminResponseMeta)(emptyPlatform, "No workspaces exist yet. Seed the database or complete signup to see platform KPIs."),
        kpis,
        moduleStats: buildModuleStats(a, scope),
    };
}

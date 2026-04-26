"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminBilling = getAdminBilling;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const env_1 = require("../env");
const admin_response_meta_1 = require("../lib/admin-response-meta");
const admin_overview_service_1 = require("./admin_overview.service");
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
};
function formatPlan(p) {
    return p.charAt(0) + p.slice(1).toLowerCase();
}
async function getAdminBilling(operatorEmail, workspaceId) {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const platform = (0, admin_overview_service_1.isPlatformOperatorEmail)(operatorEmail);
    const scope = platform ? "platform" : "workspace";
    const where = platform ? {} : { id: workspaceId };
    const stripeConfigured = Boolean(env_1.env.STRIPE_SECRET_KEY?.trim());
    const [total, stripeCustomers, pastDue, paidPlanCount, demoBilling, rows, webhook24h, recentEvents,] = await Promise.all([
        prisma_1.prisma.workspace.count({ where }),
        prisma_1.prisma.workspace.count({
            where: { ...where, stripeCustomerId: { not: null } },
        }),
        prisma_1.prisma.workspace.count({
            where: { ...where, subscriptionStatus: "past_due" },
        }),
        prisma_1.prisma.workspace.count({
            where: { ...where, plan: { in: [client_1.Plan.PRO, client_1.Plan.BUSINESS] } },
        }),
        prisma_1.prisma.workspace.count({
            where: { ...where, subscriptionStatus: "demo" },
        }),
        prisma_1.prisma.workspace.findMany({
            where,
            select: rowSelect,
            orderBy: [{ updatedAt: "desc" }],
            take: platform ? 500 : 1,
        }),
        platform
            ? prisma_1.prisma.stripeEventLog.count({
                where: { processedAt: { gte: dayAgo } },
            })
            : Promise.resolve(0),
        platform
            ? prisma_1.prisma.stripeEventLog.findMany({
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
    const kpis = scope === "platform"
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
                value: rows[0]?.subscriptionStatus === "past_due" ? "Yes" : "No",
                hint: undefined,
            },
        ];
    const workspaces = rows.map((w) => ({
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
    const recentWebhookEvents = recentEvents.map((e) => ({
        stripeEventId: e.stripeEventId,
        type: e.type,
        processedAt: e.processedAt.toISOString(),
    }));
    return {
        scope,
        generatedAt: now.toISOString(),
        meta: (0, admin_response_meta_1.adminResponseMeta)(workspaces.length === 0, scope === "platform"
            ? "No workspaces to show."
            : "No billing row for this workspace."),
        stripeConfigured,
        kpis,
        workspaces,
        recentWebhookEvents,
    };
}
function shortId(id) {
    if (id.length <= 14)
        return id;
    return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminSubscriptions = getAdminSubscriptions;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
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
async function getAdminSubscriptions(operatorEmail, workspaceId) {
    const now = new Date();
    const platform = (0, admin_overview_service_1.isPlatformOperatorEmail)(operatorEmail);
    const scope = platform ? "platform" : "workspace";
    const where = platform ? {} : { id: workspaceId };
    const [total, withStripeSub, pastDue, paidPlanCount, freePlanCount, proCount, businessCount, rows,] = await Promise.all([
        prisma_1.prisma.workspace.count({ where }),
        prisma_1.prisma.workspace.count({
            where: { ...where, stripeSubscriptionId: { not: null } },
        }),
        prisma_1.prisma.workspace.count({
            where: { ...where, subscriptionStatus: "past_due" },
        }),
        prisma_1.prisma.workspace.count({
            where: { ...where, plan: { in: [client_1.Plan.PRO, client_1.Plan.BUSINESS] } },
        }),
        prisma_1.prisma.workspace.count({ where: { ...where, plan: client_1.Plan.FREE } }),
        prisma_1.prisma.workspace.count({ where: { ...where, plan: client_1.Plan.PRO } }),
        prisma_1.prisma.workspace.count({ where: { ...where, plan: client_1.Plan.BUSINESS } }),
        prisma_1.prisma.workspace.findMany({
            where,
            select: rowSelect,
            orderBy: [{ updatedAt: "desc" }],
            take: platform ? 500 : 1,
        }),
    ]);
    const kpis = scope === "platform"
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
                hint: rows[0] ? formatPlan(rows[0].plan) : undefined,
            },
            {
                label: "Past due",
                value: rows[0]?.subscriptionStatus === "past_due" ? "Yes" : "No",
                hint: "Stripe subscriptionStatus",
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
    return {
        scope,
        generatedAt: now.toISOString(),
        meta: (0, admin_response_meta_1.adminResponseMeta)(workspaces.length === 0, scope === "platform"
            ? "No workspaces in the database."
            : "No subscription row returned for this workspace."),
        kpis,
        workspaces,
    };
}
function subscriptionHint(pastDue) {
    if (pastDue === 0)
        return "All clear";
    return "Dunning / payment";
}
function truncateId(id) {
    if (id.length <= 14)
        return id;
    return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

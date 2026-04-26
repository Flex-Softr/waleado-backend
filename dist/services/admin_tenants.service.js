"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminTenants = getAdminTenants;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const admin_response_meta_1 = require("../lib/admin-response-meta");
const admin_overview_service_1 = require("./admin_overview.service");
function formatPlan(p) {
    return p.charAt(0) + p.slice(1).toLowerCase();
}
async function getAdminTenants(operatorEmail, workspaceId) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const platform = (0, admin_overview_service_1.isPlatformOperatorEmail)(operatorEmail);
    const scope = platform ? "platform" : "workspace";
    const where = platform ? {} : { id: workspaceId };
    const [total, paidPlanCount, freePlanCount, pastDue, totalMembers, totalDevices, newWorkspaces7d, rows,] = await Promise.all([
        prisma_1.prisma.workspace.count({ where }),
        prisma_1.prisma.workspace.count({
            where: { ...where, plan: { in: [client_1.Plan.PRO, client_1.Plan.BUSINESS] } },
        }),
        prisma_1.prisma.workspace.count({ where: { ...where, plan: client_1.Plan.FREE } }),
        prisma_1.prisma.workspace.count({
            where: { ...where, subscriptionStatus: "past_due" },
        }),
        platform
            ? prisma_1.prisma.membership.count()
            : prisma_1.prisma.membership.count({ where: { workspaceId } }),
        platform
            ? prisma_1.prisma.device.count()
            : prisma_1.prisma.device.count({ where: { workspaceId } }),
        prisma_1.prisma.workspace.count({
            where: { ...where, createdAt: { gte: sevenDaysAgo } },
        }),
        prisma_1.prisma.workspace.findMany({
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
    const connectedByWs = ids.length === 0
        ? []
        : await prisma_1.prisma.device.groupBy({
            by: ["workspaceId"],
            where: {
                status: client_1.DeviceStatus.CONNECTED,
                workspaceId: { in: ids },
            },
            _count: { _all: true },
        });
    const connectedMap = new Map(connectedByWs.map((c) => [c.workspaceId, c._count._all]));
    const kpis = scope === "platform"
        ? [
            {
                label: "Workspaces",
                value: String(total),
                hint: `${newWorkspaces7d} new (7d)`,
            },
            {
                label: "Paid / free",
                value: `${paidPlanCount} / ${freePlanCount}`,
                hint: pastDue > 0
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
    const tenants = rows.map((w) => ({
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
        meta: (0, admin_response_meta_1.adminResponseMeta)(tenants.length === 0, scope === "platform"
            ? "No workspaces in the database."
            : "Workspace row missing or inaccessible."),
        kpis,
        tenants,
    };
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminFleet = getAdminFleet;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const admin_response_meta_1 = require("../lib/admin-response-meta");
const admin_overview_service_1 = require("./admin_overview.service");
const dw = (platform, workspaceId) => platform ? {} : { workspaceId };
async function getAdminFleet(operatorEmail, workspaceId) {
    const now = new Date();
    const platform = (0, admin_overview_service_1.isPlatformOperatorEmail)(operatorEmail);
    const scope = platform ? "platform" : "workspace";
    const where = dw(platform, workspaceId);
    const [total, connected, qrReady, workspacesWithAnyDevice, workspacesWithConnected, byStatusGroups, rows,] = await Promise.all([
        prisma_1.prisma.device.count({ where }),
        prisma_1.prisma.device.count({
            where: { ...where, status: client_1.DeviceStatus.CONNECTED },
        }),
        prisma_1.prisma.device.count({
            where: { ...where, status: client_1.DeviceStatus.QR_READY },
        }),
        platform
            ? prisma_1.prisma.workspace.count({ where: { devices: { some: {} } } })
            : prisma_1.prisma.workspace.count({
                where: { id: workspaceId, devices: { some: {} } },
            }),
        platform
            ? prisma_1.prisma.workspace.count({
                where: { devices: { some: { status: client_1.DeviceStatus.CONNECTED } } },
            })
            : prisma_1.prisma.workspace.count({
                where: {
                    id: workspaceId,
                    devices: { some: { status: client_1.DeviceStatus.CONNECTED } },
                },
            }),
        prisma_1.prisma.device.groupBy({
            by: ["status"],
            where,
            _count: { _all: true },
        }),
        prisma_1.prisma.device.findMany({
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
    const kpis = scope === "platform"
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
                hint: total > 0
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
                hint: total > 0
                    ? `${Math.round((connected / total) * 100)}% connected`
                    : undefined,
            },
        ];
    const byStatus = byStatusGroups
        .map((g) => ({
        status: g.status,
        count: g._count._all,
    }))
        .sort((a, b) => b.count - a.count);
    const devices = rows.map((d) => ({
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
        meta: (0, admin_response_meta_1.adminResponseMeta)(devices.length === 0, "No WhatsApp devices registered. Add a session from the Devices page."),
        kpis,
        byStatus,
        devices,
    };
}

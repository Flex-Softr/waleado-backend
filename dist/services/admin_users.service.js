"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminUsers = getAdminUsers;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const admin_response_meta_1 = require("../lib/admin-response-meta");
const admin_overview_service_1 = require("./admin_overview.service");
const mWhere = (platform, workspaceId) => platform ? {} : { workspaceId };
async function getAdminUsers(operatorEmail, workspaceId) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const platform = (0, admin_overview_service_1.isPlatformOperatorEmail)(operatorEmail);
    const scope = platform ? "platform" : "workspace";
    const mw = mWhere(platform, workspaceId);
    const userFilter = platform
        ? undefined
        : { memberships: { some: { workspaceId } } };
    const [totalUsers, totalMemberships, ownerSeats, adminSeats, memberSeats, newUsers7d, memberships,] = await Promise.all([
        prisma_1.prisma.user.count({ where: userFilter }),
        prisma_1.prisma.membership.count({ where: mw }),
        prisma_1.prisma.membership.count({ where: { ...mw, role: client_1.MembershipRole.OWNER } }),
        prisma_1.prisma.membership.count({ where: { ...mw, role: client_1.MembershipRole.ADMIN } }),
        prisma_1.prisma.membership.count({ where: { ...mw, role: client_1.MembershipRole.MEMBER } }),
        prisma_1.prisma.user.count({
            where: {
                ...(userFilter ?? {}),
                createdAt: { gte: sevenDaysAgo },
            },
        }),
        prisma_1.prisma.membership.findMany({
            where: mw,
            select: {
                role: true,
                createdAt: true,
                user: {
                    select: {
                        id: true,
                        email: true,
                        name: true,
                        createdAt: true,
                        updatedAt: true,
                    },
                },
                workspace: {
                    select: {
                        id: true,
                        name: true,
                        slug: true,
                    },
                },
            },
            orderBy: [{ createdAt: "desc" }],
            take: 500,
        }),
    ]);
    const kpis = scope === "platform"
        ? [
            {
                label: "Users",
                value: String(totalUsers),
                hint: `${newUsers7d} new (7d)`,
            },
            {
                label: "Memberships",
                value: String(totalMemberships),
                hint: "User ↔ workspace links",
            },
            {
                label: "Owners / admins / members",
                value: `${ownerSeats} / ${adminSeats} / ${memberSeats}`,
                hint: "Seat roles",
            },
        ]
        : [
            {
                label: "Team size",
                value: String(totalMemberships),
                hint: "This workspace",
            },
            {
                label: "Owners",
                value: String(ownerSeats),
                hint: undefined,
            },
            {
                label: "Admins",
                value: String(adminSeats),
                hint: undefined,
            },
            {
                label: "Members",
                value: String(memberSeats),
                hint: undefined,
            },
        ];
    const rows = memberships.map((m) => ({
        userId: m.user.id,
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        workspaceId: m.workspace.id,
        workspaceName: m.workspace.name,
        workspaceSlug: m.workspace.slug,
        joinedAt: m.createdAt.toISOString(),
        userCreatedAt: m.user.createdAt.toISOString(),
        userUpdatedAt: m.user.updatedAt.toISOString(),
    }));
    return {
        scope,
        generatedAt: now.toISOString(),
        meta: (0, admin_response_meta_1.adminResponseMeta)(rows.length === 0, "No memberships in scope — invite users or switch workspace."),
        kpis,
        rows,
    };
}

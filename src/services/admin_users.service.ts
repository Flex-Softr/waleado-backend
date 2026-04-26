import { MembershipRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import type { AdminResponseMeta } from "../lib/admin-response-meta";
import { adminResponseMeta } from "../lib/admin-response-meta";
import { isPlatformOperatorEmail } from "./admin_overview.service";

export type AdminUserRow = {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  joinedAt: string;
  userCreatedAt: string;
  userUpdatedAt: string;
};

export type AdminUsersKpi = {
  label: string;
  value: string;
  hint?: string;
};

export type AdminUsersJson = {
  scope: "platform" | "workspace";
  generatedAt: string;
  meta: AdminResponseMeta;
  kpis: AdminUsersKpi[];
  rows: AdminUserRow[];
};

const mWhere = (platform: boolean, workspaceId: string) =>
  platform ? {} : { workspaceId };

export async function getAdminUsers(
  operatorEmail: string,
  workspaceId: string
): Promise<AdminUsersJson> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const platform = isPlatformOperatorEmail(operatorEmail);
  const scope = platform ? "platform" : "workspace";
  const mw = mWhere(platform, workspaceId);

  const userFilter = platform
    ? undefined
    : { memberships: { some: { workspaceId } } };

  const [
    totalUsers,
    totalMemberships,
    ownerSeats,
    adminSeats,
    memberSeats,
    newUsers7d,
    memberships,
  ] = await Promise.all([
    prisma.user.count({ where: userFilter }),
    prisma.membership.count({ where: mw }),
    prisma.membership.count({ where: { ...mw, role: MembershipRole.OWNER } }),
    prisma.membership.count({ where: { ...mw, role: MembershipRole.ADMIN } }),
    prisma.membership.count({ where: { ...mw, role: MembershipRole.MEMBER } }),
    prisma.user.count({
      where: {
        ...(userFilter ?? {}),
        createdAt: { gte: sevenDaysAgo },
      },
    }),
    prisma.membership.findMany({
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

  const kpis: AdminUsersKpi[] =
    scope === "platform"
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

  const rows: AdminUserRow[] = memberships.map((m) => ({
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
    meta: adminResponseMeta(
      rows.length === 0,
      "No memberships in scope — invite users or switch workspace."
    ),
    kpis,
    rows,
  };
}

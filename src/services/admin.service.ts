import { Plan, type Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { hashPassword } from "../lib/password";
import { planToApi, apiPaidPlanToDb, type PlanIdApi } from "../lib/plan-mapping";
import { fulfillSslCommerzByValId } from "../payments/fulfill-sslcommerz";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;

function clampPage(page: number): number {
  return Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
}

function clampPageSize(size: number): number {
  if (!Number.isFinite(size) || size < 1) return PAGE_SIZE_DEFAULT;
  return Math.min(PAGE_SIZE_MAX, Math.floor(size));
}

export async function getAdminOverview() {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    blockedUsers,
    customerUsers,
    adminUsers,
    totalWorkspaces,
    paidWorkspaces,
    pendingPayments,
    paidPayments,
    recentUsers,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { blockedAt: { not: null } } }),
    prisma.user.count({ where: { role: "CUSTOMER" } }),
    prisma.user.count({ where: { role: "ADMIN" } }),
    prisma.workspace.count(),
    prisma.workspace.count({ where: { plan: { not: Plan.FREE } } }),
    prisma.paymentTransaction.count({ where: { status: "pending" } }),
    prisma.paymentTransaction.count({ where: { status: "paid" } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
  ]);

  return {
    users: {
      total: totalUsers,
      customers: customerUsers,
      admins: adminUsers,
      blocked: blockedUsers,
      newLast7Days: recentUsers,
    },
    workspaces: {
      total: totalWorkspaces,
      paid: paidWorkspaces,
      free: totalWorkspaces - paidWorkspaces,
    },
    payments: {
      pending: pendingPayments,
      paid: paidPayments,
    },
  };
}

export async function listAdminUsers(input: {
  page?: number;
  pageSize?: number;
  q?: string;
}) {
  const page = clampPage(input.page ?? 1);
  const pageSize = clampPageSize(input.pageSize ?? PAGE_SIZE_DEFAULT);
  const q = input.q?.trim();

  const where: Prisma.UserWhereInput = q
    ? {
        OR: [
          { email: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        blockedAt: true,
        createdAt: true,
        memberships: {
          select: {
            role: true,
            workspace: {
              select: {
                id: true,
                name: true,
                slug: true,
                plan: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
          take: 5,
        },
      },
    }),
  ]);

  return {
    page,
    pageSize,
    total,
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      blockedAt: u.blockedAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      workspaces: u.memberships.map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        slug: m.workspace.slug,
        plan: planToApi(m.workspace.plan),
        membershipRole: m.role,
      })),
    })),
  };
}

export async function setUserBlocked(input: {
  actorUserId: string;
  targetUserId: string;
  blocked: boolean;
}) {
  if (input.actorUserId === input.targetUserId) {
    throw new AppError(400, "You cannot block your own account", "CANNOT_BLOCK_SELF");
  }

  const target = await prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { id: true, role: true, email: true, blockedAt: true },
  });
  if (!target) {
    throw new AppError(404, "User not found", "NOT_FOUND");
  }
  if (target.role === "ADMIN") {
    throw new AppError(400, "Cannot block platform admin accounts", "CANNOT_BLOCK_ADMIN");
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: { blockedAt: input.blocked ? new Date() : null },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      blockedAt: true,
      createdAt: true,
    },
  });

  if (input.blocked) {
    await prisma.refreshToken.updateMany({
      where: { userId: target.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  return {
    id: updated.id,
    email: updated.email,
    name: updated.name,
    role: updated.role,
    blockedAt: updated.blockedAt?.toISOString() ?? null,
    createdAt: updated.createdAt.toISOString(),
  };
}

function mapUserRow(u: {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "CUSTOMER";
  blockedAt: Date | null;
  createdAt: Date;
  memberships?: Array<{
    role: "OWNER" | "ADMIN" | "MEMBER";
    workspace: {
      id: string;
      name: string;
      slug: string;
      plan: Plan;
    };
  }>;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    blockedAt: u.blockedAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    workspaces: (u.memberships ?? []).map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      slug: m.workspace.slug,
      plan: planToApi(m.workspace.plan),
      membershipRole: m.role,
    })),
  };
}

export async function createAdminUser(input: {
  email: string;
  password: string;
  name?: string;
  role: "ADMIN" | "CUSTOMER";
}) {
  const email = input.email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, "Email already registered", "EMAIL_TAKEN");
  }

  const passwordHash = await hashPassword(input.password);
  const slug = `ws-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const workspaceName = input.name?.trim()
    ? `${input.name.trim()}'s workspace`
    : "My workspace";

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email,
        passwordHash,
        name: input.name?.trim() || null,
        role: input.role,
      },
    });
    const ws = await tx.workspace.create({
      data: {
        name: workspaceName,
        slug,
      },
    });
    await tx.membership.create({
      data: {
        userId: u.id,
        workspaceId: ws.id,
        role: "OWNER",
      },
    });
    return u;
  });

  const full = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      blockedAt: true,
      createdAt: true,
      memberships: {
        select: {
          role: true,
          workspace: {
            select: { id: true, name: true, slug: true, plan: true },
          },
        },
        orderBy: { createdAt: "asc" },
        take: 5,
      },
    },
  });

  return mapUserRow(full);
}

export async function setUserPlatformRole(input: {
  actorUserId: string;
  targetUserId: string;
  role: "ADMIN" | "CUSTOMER";
}) {
  if (input.actorUserId === input.targetUserId) {
    throw new AppError(
      400,
      "You cannot change your own platform role",
      "CANNOT_CHANGE_OWN_ROLE"
    );
  }

  const target = await prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { id: true, role: true, email: true },
  });
  if (!target) {
    throw new AppError(404, "User not found", "NOT_FOUND");
  }
  if (target.role === input.role) {
    const full = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        blockedAt: true,
        createdAt: true,
        memberships: {
          select: {
            role: true,
            workspace: {
              select: { id: true, name: true, slug: true, plan: true },
            },
          },
          orderBy: { createdAt: "asc" },
          take: 5,
        },
      },
    });
    return mapUserRow(full);
  }

  if (target.role === "ADMIN" && input.role === "CUSTOMER") {
    const otherAdmins = await prisma.user.count({
      where: { role: "ADMIN", id: { not: target.id } },
    });
    if (otherAdmins === 0) {
      throw new AppError(
        400,
        "Cannot remove the last platform admin",
        "LAST_ADMIN"
      );
    }
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: { role: input.role },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      blockedAt: true,
      createdAt: true,
      memberships: {
        select: {
          role: true,
          workspace: {
            select: { id: true, name: true, slug: true, plan: true },
          },
        },
        orderBy: { createdAt: "asc" },
        take: 5,
      },
    },
  });

  await prisma.refreshToken.updateMany({
    where: { userId: target.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  return mapUserRow(updated);
}

export async function deleteAdminUser(input: {
  actorUserId: string;
  targetUserId: string;
}) {
  if (input.actorUserId === input.targetUserId) {
    throw new AppError(400, "You cannot delete your own account", "CANNOT_DELETE_SELF");
  }

  const target = await prisma.user.findUnique({
    where: { id: input.targetUserId },
    select: { id: true, role: true, email: true },
  });
  if (!target) {
    throw new AppError(404, "User not found", "NOT_FOUND");
  }

  if (target.role === "ADMIN") {
    const otherAdmins = await prisma.user.count({
      where: { role: "ADMIN", id: { not: target.id } },
    });
    if (otherAdmins === 0) {
      throw new AppError(
        400,
        "Cannot delete the last platform admin",
        "LAST_ADMIN"
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    const memberships = await tx.membership.findMany({
      where: { userId: target.id },
      select: { workspaceId: true },
    });
    for (const m of memberships) {
      const others = await tx.membership.count({
        where: {
          workspaceId: m.workspaceId,
          userId: { not: target.id },
        },
      });
      if (others === 0) {
        await tx.workspace.delete({ where: { id: m.workspaceId } });
      }
    }
    await tx.user.delete({ where: { id: target.id } });
  });

  return { id: target.id, email: target.email };
}

export async function listAdminSubscriptions(input: {
  page?: number;
  pageSize?: number;
  q?: string;
  plan?: PlanIdApi;
}) {
  const page = clampPage(input.page ?? 1);
  const pageSize = clampPageSize(input.pageSize ?? PAGE_SIZE_DEFAULT);
  const q = input.q?.trim();

  const where: Prisma.WorkspaceWhereInput = {};
  if (input.plan) {
    where.plan =
      input.plan === "free"
        ? Plan.FREE
        : input.plan === "pro"
          ? Plan.PRO
          : Plan.BUSINESS;
  }
  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { slug: { contains: q, mode: "insensitive" } },
      {
        memberships: {
          some: {
            user: {
              OR: [
                { email: { contains: q, mode: "insensitive" } },
                { name: { contains: q, mode: "insensitive" } },
              ],
            },
          },
        },
      },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.workspace.count({ where }),
    prisma.workspace.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        subscriptionStatus: true,
        currentPeriodEnd: true,
        lastPaymentGateway: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        createdAt: true,
        updatedAt: true,
        memberships: {
          where: { role: "OWNER" },
          take: 1,
          select: {
            user: {
              select: { id: true, email: true, name: true },
            },
          },
        },
      },
    }),
  ]);

  return {
    page,
    pageSize,
    total,
    subscriptions: rows.map((ws) => {
      const owner = ws.memberships[0]?.user ?? null;
      return {
        workspaceId: ws.id,
        name: ws.name,
        slug: ws.slug,
        plan: planToApi(ws.plan),
        subscriptionStatus: ws.subscriptionStatus,
        currentPeriodEnd: ws.currentPeriodEnd?.toISOString() ?? null,
        lastPaymentGateway: ws.lastPaymentGateway,
        stripeCustomerId: ws.stripeCustomerId,
        stripeSubscriptionId: ws.stripeSubscriptionId,
        createdAt: ws.createdAt.toISOString(),
        updatedAt: ws.updatedAt.toISOString(),
        owner: owner
          ? { id: owner.id, email: owner.email, name: owner.name }
          : null,
      };
    }),
  };
}

export async function updateAdminSubscription(input: {
  workspaceId: string;
  plan: PlanIdApi;
  subscriptionStatus?: string | null;
  currentPeriodEnd?: string | null;
}) {
  const ws = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { id: true },
  });
  if (!ws) {
    throw new AppError(404, "Workspace not found", "NOT_FOUND");
  }

  let periodEnd: Date | null | undefined = undefined;
  if (input.currentPeriodEnd === null) {
    periodEnd = null;
  } else if (typeof input.currentPeriodEnd === "string") {
    const d = new Date(input.currentPeriodEnd);
    if (Number.isNaN(d.getTime())) {
      throw new AppError(400, "Invalid currentPeriodEnd", "INVALID_DATE");
    }
    periodEnd = d;
  }

  const plan =
    input.plan === "free"
      ? Plan.FREE
      : apiPaidPlanToDb(input.plan);

  const data: Prisma.WorkspaceUpdateInput = {
    plan,
  };

  if (input.subscriptionStatus !== undefined) {
    data.subscriptionStatus = input.subscriptionStatus;
  } else if (input.plan === "free") {
    data.subscriptionStatus = null;
  } else {
    data.subscriptionStatus = "active";
  }

  if (periodEnd !== undefined) {
    data.currentPeriodEnd = periodEnd;
  } else if (input.plan === "free") {
    data.currentPeriodEnd = null;
  } else {
    const end = new Date();
    end.setDate(end.getDate() + 30);
    data.currentPeriodEnd = end;
  }

  if (input.plan === "free") {
    data.lastPaymentGateway = null;
    data.stripeSubscriptionId = null;
  }

  const updated = await prisma.workspace.update({
    where: { id: ws.id },
    data,
    select: {
      id: true,
      name: true,
      slug: true,
      plan: true,
      subscriptionStatus: true,
      currentPeriodEnd: true,
      lastPaymentGateway: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      createdAt: true,
      updatedAt: true,
      memberships: {
        where: { role: "OWNER" },
        take: 1,
        select: {
          user: { select: { id: true, email: true, name: true } },
        },
      },
    },
  });

  const owner = updated.memberships[0]?.user ?? null;
  return {
    workspaceId: updated.id,
    name: updated.name,
    slug: updated.slug,
    plan: planToApi(updated.plan),
    subscriptionStatus: updated.subscriptionStatus,
    currentPeriodEnd: updated.currentPeriodEnd?.toISOString() ?? null,
    lastPaymentGateway: updated.lastPaymentGateway,
    stripeCustomerId: updated.stripeCustomerId,
    stripeSubscriptionId: updated.stripeSubscriptionId,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
    owner: owner
      ? { id: owner.id, email: owner.email, name: owner.name }
      : null,
  };
}

export async function listAdminPayments(input: {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: string;
}) {
  const page = clampPage(input.page ?? 1);
  const pageSize = clampPageSize(input.pageSize ?? PAGE_SIZE_DEFAULT);
  const q = input.q?.trim();
  const status = input.status?.trim().toLowerCase();

  const where: Prisma.PaymentTransactionWhereInput = {};
  if (status) {
    where.status = status;
  }
  if (q) {
    where.OR = [
      { tranId: { contains: q, mode: "insensitive" } },
      { valId: { contains: q, mode: "insensitive" } },
      {
        workspace: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { slug: { contains: q, mode: "insensitive" } },
          ],
        },
      },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.paymentTransaction.count({ where }),
    prisma.paymentTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        gateway: true,
        tranId: true,
        planId: true,
        amount: true,
        currency: true,
        status: true,
        sessionKey: true,
        valId: true,
        createdAt: true,
        updatedAt: true,
        workspace: {
          select: {
            id: true,
            name: true,
            slug: true,
            plan: true,
          },
        },
      },
    }),
  ]);

  return {
    page,
    pageSize,
    total,
    payments: rows.map((p) => ({
      id: p.id,
      gateway: p.gateway,
      tranId: p.tranId,
      planId: p.planId,
      amount: Number(p.amount),
      currency: p.currency,
      status: p.status,
      sessionKey: p.sessionKey,
      valId: p.valId,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      workspace: {
        id: p.workspace.id,
        name: p.workspace.name,
        slug: p.workspace.slug,
        plan: planToApi(p.workspace.plan),
      },
    })),
  };
}

/**
 * Verify a payment: prefer SSLCommerz validation when valId exists;
 * otherwise admin-force mark as paid and upgrade the workspace.
 */
export async function verifyAdminPayment(input: {
  paymentId: string;
  force?: boolean;
}) {
  const row = await prisma.paymentTransaction.findUnique({
    where: { id: input.paymentId },
  });
  if (!row) {
    throw new AppError(404, "Payment not found", "NOT_FOUND");
  }
  if (row.status === "paid") {
    return { id: row.id, status: "paid" as const, alreadyPaid: true };
  }
  if (row.status !== "pending" && !input.force) {
    throw new AppError(
      400,
      `Cannot verify payment in status “${row.status}”`,
      "INVALID_STATUS"
    );
  }

  if (row.gateway === "sslcommerz" && row.valId && !input.force) {
    await fulfillSslCommerzByValId({
      tranId: row.tranId,
      valId: row.valId,
    });
    return { id: row.id, status: "paid" as const, alreadyPaid: false };
  }

  const plan = apiPaidPlanToDb(row.planId as Exclude<PlanIdApi, "free">);
  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + 30);

  await prisma.$transaction([
    prisma.workspace.update({
      where: { id: row.workspaceId },
      data: {
        plan,
        lastPaymentGateway: row.gateway,
        subscriptionStatus: "active",
        currentPeriodEnd: periodEnd,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      },
    }),
    prisma.paymentTransaction.update({
      where: { id: row.id },
      data: { status: "paid" },
    }),
  ]);

  return { id: row.id, status: "paid" as const, alreadyPaid: false };
}

export async function rejectAdminPayment(paymentId: string) {
  const row = await prisma.paymentTransaction.findUnique({
    where: { id: paymentId },
  });
  if (!row) {
    throw new AppError(404, "Payment not found", "NOT_FOUND");
  }
  if (row.status === "paid") {
    throw new AppError(400, "Paid transactions cannot be rejected", "ALREADY_PAID");
  }
  if (row.status === "failed" || row.status === "cancelled") {
    return { id: row.id, status: row.status };
  }

  const updated = await prisma.paymentTransaction.update({
    where: { id: row.id },
    data: { status: "failed" },
    select: { id: true, status: true },
  });
  return updated;
}

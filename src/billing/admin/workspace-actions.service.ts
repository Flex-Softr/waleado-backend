import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { invalidateEntitlements } from "../entitlements.service";
import { changeWalletBalance, listWalletTransactions } from "../wallet/wallet.service";
import { DAY_MS } from "../period";
import { logBillingAction } from "../audit";

/** Adds (or removes, with negative days) time on the running paid period. */
export async function extendPaidPeriod(input: {
  workspaceId: string;
  days: number;
  reason: string;
  actorUserId: string;
}) {
  const ws = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { plan: true, currentPeriodEnd: true },
  });
  if (!ws) throw new AppError(404, "Workspace not found", "NOT_FOUND");
  if (!ws.currentPeriodEnd) {
    throw new AppError(400, "This workspace has no timed paid period to extend.", "NO_PERIOD");
  }
  const base = Math.max(ws.currentPeriodEnd.getTime(), input.days > 0 ? Date.now() : 0);
  const newEnd = new Date(base + input.days * DAY_MS);
  await prisma.workspace.update({
    where: { id: input.workspaceId },
    data: { currentPeriodEnd: newEnd, subscriptionStatus: "active" },
  });
  invalidateEntitlements(input.workspaceId);
  await logBillingAction({
    action: "workspace.extend_period",
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    detail: { days: input.days, reason: input.reason, from: ws.currentPeriodEnd, to: newEnd },
  });
  return { currentPeriodEnd: newEnd.toISOString() };
}

/** Manual wallet credit or debit (e.g. cash received, compensation, correction). */
export async function adjustWallet(input: {
  workspaceId: string;
  amount: number;
  note: string;
  actorUserId: string;
}) {
  if (input.amount === 0) throw new AppError(400, "Amount must not be zero", "VALIDATION");
  const balance = await prisma.$transaction((tx) =>
    changeWalletBalance(tx, {
      workspaceId: input.workspaceId,
      amount: input.amount,
      type: "adjustment",
      note: input.note,
      actorUserId: input.actorUserId,
    })
  );
  await logBillingAction({
    action: "wallet.adjust",
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    detail: { amount: input.amount, note: input.note, balance },
  });
  return { balance };
}

/** Billing overview of one workspace for the admin side panel. */
export async function getWorkspaceBillingDetail(workspaceId: string) {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      walletBalance: true,
      autoRenew: true,
      recurringCoupon: { select: { code: true } },
    },
  });
  if (!ws) throw new AppError(404, "Workspace not found", "NOT_FOUND");
  const [transactions, audit] = await Promise.all([
    listWalletTransactions(workspaceId, 20),
    prisma.billingAuditLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  return {
    walletBalance: Number(ws.walletBalance),
    autoRenew: ws.autoRenew,
    lockedCoupon: ws.recurringCoupon?.code ?? null,
    walletTransactions: transactions,
    audit: audit.map((a) => ({
      id: a.id,
      action: a.action,
      detail: a.detail,
      actorUserId: a.actorUserId,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

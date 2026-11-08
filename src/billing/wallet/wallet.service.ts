import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { round2 } from "../period";

export type WalletTxType = "topup" | "invoice_payment" | "invoice_refund" | "adjustment";

type Tx = Prisma.TransactionClient;

/**
 * Applies a signed change to a workspace wallet and records it in the ledger, inside the
 * caller's transaction. Debits fail when the balance is too low unless `allowNegative`.
 */
export async function changeWalletBalance(
  tx: Tx,
  input: {
    workspaceId: string;
    amount: number;
    type: WalletTxType;
    invoiceId?: string | null;
    note?: string | null;
    actorUserId?: string | null;
    allowNegative?: boolean;
  }
): Promise<number> {
  const amount = round2(input.amount);
  if (amount === 0) {
    const ws = await tx.workspace.findUniqueOrThrow({
      where: { id: input.workspaceId },
      select: { walletBalance: true },
    });
    return Number(ws.walletBalance);
  }

  // Conditional update keeps concurrent debits from overdrawing the wallet.
  const updated = await tx.workspace.updateMany({
    where: {
      id: input.workspaceId,
      ...(amount < 0 && !input.allowNegative ? { walletBalance: { gte: -amount } } : {}),
    },
    data: { walletBalance: { increment: amount } },
  });
  if (updated.count === 0) {
    throw new AppError(409, "Not enough wallet balance.", "WALLET_INSUFFICIENT");
  }

  const { walletBalance } = await tx.workspace.findUniqueOrThrow({
    where: { id: input.workspaceId },
    select: { walletBalance: true },
  });
  await tx.walletTransaction.create({
    data: {
      workspaceId: input.workspaceId,
      amount,
      balanceAfter: walletBalance,
      type: input.type,
      invoiceId: input.invoiceId ?? null,
      note: input.note ?? null,
      actorUserId: input.actorUserId ?? null,
    },
  });
  return Number(walletBalance);
}

export async function getWalletBalance(workspaceId: string): Promise<number> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { walletBalance: true },
  });
  return ws ? Number(ws.walletBalance) : 0;
}

export async function listWalletTransactions(workspaceId: string, take = 50) {
  const rows = await prisma.walletTransaction.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take,
    include: { invoice: { select: { number: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    amount: Number(r.amount),
    balanceAfter: Number(r.balanceAfter),
    type: r.type as WalletTxType,
    invoiceNumber: r.invoice?.number ?? null,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function setAutoRenew(workspaceId: string, enabled: boolean): Promise<void> {
  await prisma.workspace.update({ where: { id: workspaceId }, data: { autoRenew: enabled } });
}

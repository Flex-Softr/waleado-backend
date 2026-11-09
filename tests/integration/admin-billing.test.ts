import { Plan } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { quotePurchase } from "../../src/billing/checkout/quote.service";
import { createInvoice } from "../../src/billing/invoices/invoice.service";
import {
  cancelInvoiceByAdmin,
  createManualInvoice,
  markInvoicePaidManually,
} from "../../src/billing/admin/invoices.service";
import { adjustWallet, extendPaidPeriod } from "../../src/billing/admin/workspace-actions.service";
import { runAutoRenew } from "../../src/billing/jobs/auto-renew.job";
import { prisma, resetDb } from "../helpers/db";
import { buyPlan, createWorkspace, DAY, PRICE, walletBalance } from "../helpers/factories";

beforeEach(resetDb);

async function adminId(): Promise<string> {
  const admin = await prisma.user.create({ data: { email: `admin-${Date.now()}@test.local`, role: "ADMIN" } });
  return admin.id;
}

async function auditActions(workspaceId: string): Promise<string[]> {
  const rows = await prisma.billingAuditLog.findMany({ where: { workspaceId } });
  return rows.map((r) => r.action);
}

describe("admin invoice actions", () => {
  it("marks an invoice paid with its bKash reference, once", async () => {
    const actor = await adminId();
    const ws = await createWorkspace();
    const invoice = await createInvoice(ws.id, await quotePurchase(ws.id, Plan.PRO, 1));

    const paid = await markInvoicePaidManually({ invoiceId: invoice.id, paymentRef: "BK123", actorUserId: actor });
    expect(paid).toMatchObject({ status: "paid", gateway: "manual", paymentRef: "BK123" });
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).plan).toBe(Plan.PRO);

    await expect(
      markInvoicePaidManually({ invoiceId: invoice.id, paymentRef: "BK123", actorUserId: actor })
    ).rejects.toMatchObject({ code: "ALREADY_PAID" });
    expect(await auditActions(ws.id)).toEqual(["invoice.mark_paid"]);
  });

  it("creates a paid manual top-up", async () => {
    const actor = await adminId();
    const ws = await createWorkspace();
    await createManualInvoice({
      workspaceId: ws.id,
      kind: "topup",
      amount: 750,
      markPaid: { paymentRef: "CASH" },
      actorUserId: actor,
    });
    expect(await walletBalance(ws.id)).toBe(750);
  });

  it("cancels an unpaid invoice and refunds its wallet share", async () => {
    const actor = await adminId();
    const ws = await createWorkspace({ walletBalance: 300 });
    const invoice = await createInvoice(ws.id, await quotePurchase(ws.id, Plan.PRO, 1, { useWallet: true }));
    await cancelInvoiceByAdmin(invoice.id, actor);
    expect(await walletBalance(ws.id)).toBe(300);
    await expect(cancelInvoiceByAdmin(invoice.id, actor)).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });
});

describe("admin workspace actions", () => {
  it("extends and shortens the running period", async () => {
    const actor = await adminId();
    const ws = await createWorkspace();
    await buyPlan(ws.id, Plan.PRO, 1);
    const before = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).currentPeriodEnd as Date;

    await extendPaidPeriod({ workspaceId: ws.id, days: 7, reason: "outage", actorUserId: actor });
    await extendPaidPeriod({ workspaceId: ws.id, days: -2, reason: "correction", actorUserId: actor });
    const after = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).currentPeriodEnd as Date;

    expect(after.getTime() - before.getTime()).toBe(5 * DAY);
    expect(await auditActions(ws.id)).toEqual(["workspace.extend_period", "workspace.extend_period"]);
  });

  it("refuses to extend a workspace with no timed period", async () => {
    const ws = await createWorkspace();
    await expect(
      extendPaidPeriod({ workspaceId: ws.id, days: 7, reason: "x", actorUserId: await adminId() })
    ).rejects.toMatchObject({ code: "NO_PERIOD" });
  });

  it("adjusts the wallet but never below zero", async () => {
    const actor = await adminId();
    const ws = await createWorkspace();
    await adjustWallet({ workspaceId: ws.id, amount: 200, note: "goodwill", actorUserId: actor });
    await expect(
      adjustWallet({ workspaceId: ws.id, amount: -500, note: "too much", actorUserId: actor })
    ).rejects.toMatchObject({ code: "WALLET_INSUFFICIENT" });
    expect(await walletBalance(ws.id)).toBe(200);
  });
});

describe("auto-renew", () => {
  async function endingSoon(walletBalanceBdt: number) {
    const ws = await createWorkspace({ walletBalance: walletBalanceBdt, autoRenew: true });
    const invoice = await buyPlan(ws.id, Plan.PRO, 1);
    const end = new Date(Date.now() + DAY / 2);
    await prisma.invoice.update({ where: { id: invoice.id }, data: { periodEnd: end } });
    await prisma.workspace.update({ where: { id: ws.id }, data: { currentPeriodEnd: end } });
    return { ws, end };
  }

  it("renews from the wallet when the balance covers it", async () => {
    const { ws, end } = await endingSoon(PRICE.PRO_1 + 100);
    await runAutoRenew();

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } });
    expect(Number(after.walletBalance)).toBe(100);
    expect((after.currentPeriodEnd as Date).getTime()).toBeGreaterThan(end.getTime() + 27 * DAY);
  });

  it("leaves the plan and wallet alone when the balance is short", async () => {
    const { ws, end } = await endingSoon(100);
    await runAutoRenew();

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } });
    expect(Number(after.walletBalance)).toBe(100);
    expect(after.currentPeriodEnd).toEqual(end);
    expect(await prisma.invoice.count({ where: { workspaceId: ws.id, status: "unpaid" } })).toBe(0);
  });

  it("does not renew twice when the job runs again", async () => {
    const { ws } = await endingSoon(PRICE.PRO_1 * 3);
    await runAutoRenew();
    await runAutoRenew();
    expect(await walletBalance(ws.id)).toBe(PRICE.PRO_1 * 2);
  });
});

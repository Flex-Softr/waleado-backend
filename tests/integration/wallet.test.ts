import { Plan } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { quotePurchase, quoteTopup } from "../../src/billing/checkout/quote.service";
import {
  applyPaidInvoice,
  cancelInvoice,
  createInvoice,
} from "../../src/billing/invoices/invoice.service";
import { changeWalletBalance } from "../../src/billing/wallet/wallet.service";
import { prisma, resetDb } from "../helpers/db";
import { createWorkspace, PRICE, walletBalance } from "../helpers/factories";

beforeEach(resetDb);

async function ledgerSum(workspaceId: string): Promise<number> {
  const rows = await prisma.walletTransaction.findMany({ where: { workspaceId } });
  return rows.reduce((sum, r) => sum + Number(r.amount), 0);
}

describe("wallet", () => {
  it("credits a paid top-up once, however often the payment is confirmed", async () => {
    const ws = await createWorkspace();
    const invoice = await createInvoice(ws.id, await quoteTopup(1000));
    await applyPaidInvoice(invoice.id, "test", { notify: false });
    const again = await applyPaidInvoice(invoice.id, "test", { notify: false });

    expect(again.applied).toBe(false);
    expect(await walletBalance(ws.id)).toBe(1000);
    expect(await ledgerSum(ws.id)).toBe(1000);
  });

  it("reserves the wallet share when the invoice is created and returns it on cancel", async () => {
    const ws = await createWorkspace({ walletBalance: 1000 });
    const quote = await quotePurchase(ws.id, Plan.PRO, 1, { useWallet: true });
    expect(quote.walletAmount).toBe(1000);
    expect(quote.total).toBe(PRICE.PRO_1 - 1000);

    const invoice = await createInvoice(ws.id, quote);
    expect(await walletBalance(ws.id)).toBe(0);

    await cancelInvoice(invoice.id);
    expect(await walletBalance(ws.id)).toBe(1000);
  });

  it("refunds the older invoice's reservation when a new invoice replaces it", async () => {
    const ws = await createWorkspace({ walletBalance: 500 });
    const first = await createInvoice(ws.id, await quotePurchase(ws.id, Plan.PRO, 1, { useWallet: true }));
    await createInvoice(ws.id, await quotePurchase(ws.id, Plan.STARTER, 1, { useWallet: false }));

    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("cancelled");
    expect(await walletBalance(ws.id)).toBe(500);
  });

  it("takes the wallet share again when a cancelled invoice is paid late", async () => {
    const ws = await createWorkspace({ walletBalance: 500 });
    const invoice = await createInvoice(ws.id, await quotePurchase(ws.id, Plan.PRO, 1, { useWallet: true }));
    await cancelInvoice(invoice.id);
    await applyPaidInvoice(invoice.id, "test", { notify: false });

    expect(await walletBalance(ws.id)).toBe(0);
    // Reserve −500, refund on cancel +500, late payment −500.
    expect(await ledgerSum(ws.id)).toBe(-500);
  });

  it("activates a plan fully covered by the wallet", async () => {
    const ws = await createWorkspace({ walletBalance: 5000 });
    const quote = await quotePurchase(ws.id, Plan.PRO, 1, { useWallet: true });
    expect(quote.total).toBe(0);
    const invoice = await createInvoice(ws.id, quote);
    await applyPaidInvoice(invoice.id, "wallet", { notify: false });

    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } });
    expect(after.plan).toBe(Plan.PRO);
    expect(Number(after.walletBalance)).toBe(5000 - PRICE.PRO_1);
  });

  it("never overdraws, even with concurrent debits", async () => {
    const ws = await createWorkspace({ walletBalance: 100 });
    const debit = () =>
      prisma.$transaction((tx) =>
        changeWalletBalance(tx, { workspaceId: ws.id, amount: -80, type: "adjustment" })
      );
    const results = await Promise.allSettled([debit(), debit(), debit()]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await walletBalance(ws.id)).toBe(20);
  });
});

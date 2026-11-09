import { Plan } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as sslApi from "../../src/payments/sslcommerz/sslcommerz-api";
import { fulfillSslCommerzByValId } from "../../src/payments/fulfill-sslcommerz";
import { payInvoice, startPlanCheckout } from "../../src/billing/checkout/checkout.service";
import { quotePurchase } from "../../src/billing/checkout/quote.service";
import { applyPaidInvoice, createInvoice } from "../../src/billing/invoices/invoice.service";
import { prisma, resetDb } from "../helpers/db";
import { createWorkspace, PRICE } from "../helpers/factories";

vi.mock("../../src/payments/sslcommerz/sslcommerz-api", async (importOriginal) => ({
  ...(await importOriginal<typeof sslApi>()),
  validateTransaction: vi.fn(),
}));
const validateTransaction = vi.mocked(sslApi.validateTransaction);

const payer = { email: "buyer@test.local", name: "Buyer", phone: "01700000000" };

beforeEach(async () => {
  await resetDb();
  validateTransaction.mockReset();
});

/** An unpaid Pro invoice with a pending SSLCommerz transaction, as checkout leaves it. */
async function pendingSslPayment() {
  const ws = await createWorkspace();
  const invoice = await createInvoice(ws.id, await quotePurchase(ws.id, Plan.PRO, 1));
  const tranId = `T-${invoice.id.slice(0, 8)}`;
  await prisma.paymentTransaction.create({
    data: {
      gateway: "sslcommerz",
      tranId,
      workspaceId: ws.id,
      planId: "pro",
      amount: PRICE.PRO_1,
      currency: "BDT",
      status: "pending",
      invoiceId: invoice.id,
    },
  });
  return { ws, invoice, tranId };
}

const validResponse = (tranId: string, amount: number): sslApi.SslCommerzValidationResponse => ({
  status: "VALID",
  tran_id: tranId,
  amount: String(amount),
  currency_type: "BDT",
});

describe("applyPaidInvoice", () => {
  it("activates the plan exactly once", async () => {
    const ws = await createWorkspace();
    const invoice = await createInvoice(ws.id, await quotePurchase(ws.id, Plan.PRO, 1));
    const first = await applyPaidInvoice(invoice.id, "test", { notify: false });
    const firstEnd = (await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).currentPeriodEnd;
    const second = await applyPaidInvoice(invoice.id, "test", { notify: false });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } });
    expect(after.plan).toBe(Plan.PRO);
    expect(after.currentPeriodEnd).toEqual(firstEnd);
  });

  it("applies once when two confirmations race", async () => {
    const ws = await createWorkspace();
    const invoice = await createInvoice(ws.id, await quotePurchase(ws.id, Plan.PRO, 1));
    const results = await Promise.allSettled([
      applyPaidInvoice(invoice.id, "test", { notify: false }),
      applyPaidInvoice(invoice.id, "test", { notify: false }),
    ]);
    const applied = results.filter((r) => r.status === "fulfilled" && r.value.applied);
    expect(applied).toHaveLength(1);
  });
});

describe("SSLCommerz confirmation", () => {
  it("applies a validated payment and marks the transaction paid", async () => {
    const { ws, invoice, tranId } = await pendingSslPayment();
    validateTransaction.mockResolvedValue(validResponse(tranId, PRICE.PRO_1));

    await expect(fulfillSslCommerzByValId({ tranId, valId: "V1" })).resolves.toEqual({ planId: "pro" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("paid");
    expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { tranId } })).status).toBe("paid");
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ws.id } })).plan).toBe(Plan.PRO);
  });

  it("does not validate again once the transaction is paid (IPN after redirect)", async () => {
    const { tranId } = await pendingSslPayment();
    validateTransaction.mockResolvedValue(validResponse(tranId, PRICE.PRO_1));
    await fulfillSslCommerzByValId({ tranId, valId: "V1" });
    await fulfillSslCommerzByValId({ tranId, valId: "V1" });
    expect(validateTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unpaid status", { status: "FAILED" }, "PAYMENT_INVALID"],
    ["a different transaction", { tran_id: "OTHER" }, "TRANSACTION_MISMATCH"],
    ["a smaller amount", { amount: "10" }, "AMOUNT_MISMATCH"],
    ["another currency", { currency_type: "USD" }, "CURRENCY_MISMATCH"],
  ])("rejects %s and leaves the invoice unpaid", async (_label, patch, code) => {
    const { invoice, tranId } = await pendingSslPayment();
    validateTransaction.mockResolvedValue({ ...validResponse(tranId, PRICE.PRO_1), ...patch });

    await expect(fulfillSslCommerzByValId({ tranId, valId: "V1" })).rejects.toMatchObject({ code });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("unpaid");
  });

  it("rejects unknown transactions", async () => {
    await expect(fulfillSslCommerzByValId({ tranId: "missing", valId: "V1" })).rejects.toMatchObject({
      code: "TRANSACTION_NOT_FOUND",
    });
  });
});

describe("checkout", () => {
  it("refuses to pay an invoice that is no longer unpaid", async () => {
    const ws = await createWorkspace();
    const invoice = await createInvoice(ws.id, await quotePurchase(ws.id, Plan.PRO, 1));
    const { invoice: paid } = await applyPaidInvoice(invoice.id, "test", { notify: false });
    await expect(payInvoice(paid, "sslcommerz", payer)).rejects.toMatchObject({ code: "INVALID_STATUS" });
  });

  it("activates straight away when wallet covers the whole price", async () => {
    const ws = await createWorkspace({ walletBalance: PRICE.PRO_1 });
    const result = await startPlanCheckout(ws.id, payer, {
      planId: "pro",
      months: 1,
      useWallet: true,
      gateway: "sslcommerz",
    });
    expect(result).toMatchObject({ activated: true, invoice: { status: "paid", walletAmount: PRICE.PRO_1 } });
  });
});

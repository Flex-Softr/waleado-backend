import { Plan } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { quotePurchase } from "../../src/billing/checkout/quote.service";
import { prisma, resetDb } from "../helpers/db";
import { ageInvoice, buyPlan, createWorkspace, PRICE } from "../helpers/factories";

beforeEach(resetDb);

describe("upgrade credit", () => {
  it("credits the unused share of the running plan", async () => {
    const ws = await createWorkspace();
    const pro = await buyPlan(ws.id, Plan.PRO, 1);
    const span = (pro.periodEnd as Date).getTime() - (pro.periodStart as Date).getTime();
    await ageInvoice(pro, span / 2 / (24 * 60 * 60 * 1000));

    const quote = await quotePurchase(ws.id, Plan.BUSINESS, 1);
    expect(quote.kind).toBe("upgrade");
    expect(quote.credit).toBeCloseTo(PRICE.PRO_1 / 2, 0);
    expect(quote.total).toBeCloseTo(PRICE.BUSINESS_1 - PRICE.PRO_1 / 2, 0);
  });

  it("counts every stacked renewal of the running plan", async () => {
    const ws = await createWorkspace();
    await buyPlan(ws.id, Plan.PRO, 1);
    await buyPlan(ws.id, Plan.PRO, 1);
    const quote = await quotePurchase(ws.id, Plan.BUSINESS, 1);
    expect(quote.credit).toBeCloseTo(2 * PRICE.PRO_1, 0);
  });

  it("credits what was paid after a coupon, not the list price", async () => {
    const ws = await createWorkspace();
    await prisma.coupon.create({ data: { code: "HALF", discountType: "PERCENT", discountValue: 50 } });
    await buyPlan(ws.id, Plan.PRO, 1, { couponCode: "HALF" });
    const quote = await quotePurchase(ws.id, Plan.BUSINESS, 1);
    expect(quote.credit).toBeCloseTo(PRICE.PRO_1 / 2, 0);
  });

  it("never credits the same period twice (upgrade, lapse back, upgrade again)", async () => {
    const ws = await createWorkspace();
    await buyPlan(ws.id, Plan.PRO, 1);
    const business = await buyPlan(ws.id, Plan.BUSINESS, 1);

    // The Business month runs out entirely; the workspace buys Pro again.
    const span = (business.periodEnd as Date).getTime() - Date.now();
    await ageInvoice(business, span / (24 * 60 * 60 * 1000) + 10);
    await buyPlan(ws.id, Plan.PRO, 1);

    // Only the new Pro month is unused credit; the first one was converted when Business was bought.
    const quote = await quotePurchase(ws.id, Plan.BUSINESS, 1);
    expect(quote.credit).toBeCloseTo(PRICE.PRO_1, 0);
  });

  it("turns credit above the new price into extra days", async () => {
    const ws = await createWorkspace();
    await buyPlan(ws.id, Plan.PRO, 12);
    const quote = await quotePurchase(ws.id, Plan.BUSINESS, 1);
    expect(quote.credit).toBeCloseTo(PRICE.PRO_12, 0);
    expect(quote.total).toBe(0);
    expect(quote.bonusDays).toBeGreaterThan(60);
  });

  it("caps credit at the price for lifetime purchases", async () => {
    const ws = await createWorkspace();
    for (let i = 0; i < 3; i++) await buyPlan(ws.id, Plan.PRO, 12);
    const quote = await quotePurchase(ws.id, Plan.PRO, 0);
    expect(quote.credit).toBe(PRICE.PRO_LIFETIME);
    expect(quote.total).toBe(0);
    expect(quote.periodEnd).toBeNull();
  });

  it("marks the old tier's periods as used once the upgrade is paid", async () => {
    const ws = await createWorkspace();
    const pro = await buyPlan(ws.id, Plan.PRO, 1);
    await buyPlan(ws.id, Plan.BUSINESS, 1);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: pro.id } });
    expect(after.supersededAt).not.toBeNull();
  });
});

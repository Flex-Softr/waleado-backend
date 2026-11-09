import { Plan } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { quotePurchase, quoteTopup } from "../../src/billing/checkout/quote.service";
import { resetDb } from "../helpers/db";
import { buyPlan, createWorkspace, DAY, PRICE } from "../helpers/factories";

beforeEach(resetDb);

describe("quotePurchase", () => {
  it("prices a first purchase at list price", async () => {
    const ws = await createWorkspace();
    const quote = await quotePurchase(ws.id, Plan.PRO, 1);
    expect(quote).toMatchObject({ kind: "new", subtotal: PRICE.PRO_1, credit: 0, total: PRICE.PRO_1 });
    expect(quote.periodEnd).not.toBeNull();
  });

  it("starts a renewal when the running period ends", async () => {
    const ws = await createWorkspace();
    const first = await buyPlan(ws.id, Plan.PRO, 1);
    const renewal = await quotePurchase(ws.id, Plan.PRO, 1);
    expect(renewal.kind).toBe("renewal");
    expect(renewal.credit).toBe(0);
    expect(renewal.periodStart).toBe(first.periodEnd?.toISOString());
  });

  it("rejects a downgrade while a higher plan runs", async () => {
    const ws = await createWorkspace();
    await buyPlan(ws.id, Plan.BUSINESS, 1);
    await expect(quotePurchase(ws.id, Plan.PRO, 1)).rejects.toMatchObject({ code: "DOWNGRADE_NOT_ALLOWED" });
  });

  it("allows any plan once the old one has fully lapsed", async () => {
    const ws = await createWorkspace({
      plan: Plan.BUSINESS,
      currentPeriodEnd: new Date(Date.now() - 30 * DAY),
      billingMonths: 1,
    });
    expect((await quotePurchase(ws.id, Plan.STARTER, 1)).kind).toBe("new");
  });

  it("refuses plans a lifetime purchase already covers", async () => {
    const ws = await createWorkspace();
    await buyPlan(ws.id, Plan.PRO, 0);
    await expect(quotePurchase(ws.id, Plan.STARTER, 1)).rejects.toMatchObject({ code: "ALREADY_OWNED" });
    await expect(quotePurchase(ws.id, Plan.PRO, 0)).rejects.toMatchObject({ code: "ALREADY_OWNED" });
  });

  it("credits the old lifetime price toward a higher lifetime", async () => {
    const ws = await createWorkspace();
    const starter = await buyPlan(ws.id, Plan.STARTER, 0);
    const quote = await quotePurchase(ws.id, Plan.PRO, 0);
    expect(quote.kind).toBe("upgrade");
    expect(quote.credit).toBe(Number(starter.subtotal));
    expect(quote.total).toBe(PRICE.PRO_LIFETIME - Number(starter.subtotal));
  });

  it("rejects inactive cycles and the Free plan", async () => {
    const ws = await createWorkspace();
    await expect(quotePurchase(ws.id, Plan.PRO, 3)).rejects.toMatchObject({ code: "PRICE_NOT_FOUND" });
    await expect(quotePurchase(ws.id, Plan.FREE, 1)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses to bill platform admin workspaces", async () => {
    const ws = await createWorkspace({ ownerRole: "ADMIN" });
    await expect(quotePurchase(ws.id, Plan.PRO, 1)).rejects.toMatchObject({ code: "ADMIN_WORKSPACE" });
  });
});

describe("quoteTopup", () => {
  it("enforces the configured bounds", async () => {
    await expect(quoteTopup(50)).rejects.toMatchObject({ code: "TOPUP_AMOUNT_INVALID" });
    await expect(quoteTopup(100_001)).rejects.toMatchObject({ code: "TOPUP_AMOUNT_INVALID" });
    expect(await quoteTopup(500)).toMatchObject({ kind: "topup", total: 500, tier: null });
  });
});

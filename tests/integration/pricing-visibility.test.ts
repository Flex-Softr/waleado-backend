import { beforeEach, describe, expect, it } from "vitest";
import { adminBillingUpdateSchema, getAdminBillingConfig, updateAdminBillingConfig } from "../../src/billing/admin/pricing.service";
import { getPublicPricing } from "../../src/billing/catalog.service";
import { resetDb } from "../helpers/db";

beforeEach(resetDb);

describe("price visibility", () => {
  it("hides cycles an admin switched off", async () => {
    const cfg = await getAdminBillingConfig();
    const prices = cfg.plans
      .filter((p) => p.id !== "free")
      .flatMap((p) =>
        p.prices.map((x) => ({
          planId: p.id,
          months: x.months,
          amountBdt: x.amountBdt,
          isActive: [1, 12, 0].includes(x.months),
        }))
      );
    await updateAdminBillingConfig(adminBillingUpdateSchema.parse({ prices }));
    const pub = await getPublicPricing();
    for (const p of pub.plans) for (const x of p.prices) expect([1, 12, 0]).toContain(x.months);
  });
});

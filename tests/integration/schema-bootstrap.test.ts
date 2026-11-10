import { describe, expect, it } from "vitest";
import { ensureBillingSchema } from "../../src/billing/ensure-billing-schema";
import { prisma } from "../helpers/db";

describe("startup schema bootstrap", () => {
  // Runs on every boot, on databases built from migrations (staging, CI) as well as older ones.
  it("succeeds on a migrated database, and again on the next boot", async () => {
    await expect(ensureBillingSchema()).resolves.toBeUndefined();
    await expect(ensureBillingSchema()).resolves.toBeUndefined();
  });

  it("never overwrites a price an admin has changed", async () => {
    const id = "price-pro-1";
    const original = await prisma.planPrice.findUniqueOrThrow({ where: { id } });
    await prisma.planPrice.update({ where: { id }, data: { amountBdt: 299 } });
    try {
      await ensureBillingSchema();
      const after = await prisma.planPrice.findUniqueOrThrow({ where: { id } });
      expect(Number(after.amountBdt)).toBe(299);
    } finally {
      await prisma.planPrice.update({ where: { id }, data: { amountBdt: original.amountBdt } });
    }
  });
});

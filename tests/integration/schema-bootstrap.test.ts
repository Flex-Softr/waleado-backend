import { describe, expect, it } from "vitest";
import { ensureBillingSchema } from "../../src/billing/ensure-billing-schema";

describe("startup schema bootstrap", () => {
  // Runs on every boot, on databases built from migrations (staging, CI) as well as older ones.
  it("succeeds on a migrated database, and again on the next boot", async () => {
    await expect(ensureBillingSchema()).resolves.toBeUndefined();
    await expect(ensureBillingSchema()).resolves.toBeUndefined();
  });
});

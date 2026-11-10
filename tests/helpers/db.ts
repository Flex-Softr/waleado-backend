import { prisma } from "../../src/lib/prisma";
import { invalidateCatalogCache } from "../../src/billing/catalog.service";
import { invalidateEntitlements } from "../../src/billing/entitlements.service";

/** Guards against ever wiping a real database: the test URL must name a test database. */
function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) {
    throw new Error(`Refusing to reset a non-test database: ${url.replace(/\/\/[^@]*@/, "//***@")}`);
  }
}

/** Removes everything tests create. Plans, prices and billing settings (seeded by migrations) stay. */
export async function resetDb(): Promise<void> {
  assertTestDatabase();
  // Fire-and-forget work from the previous test (e.g. paid-invoice notifications) can still be
  // writing; TRUNCATE then deadlocks with it, so retry briefly instead of failing the next test.
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe(
        `TRUNCATE "Workspace", "User", "Coupon", "BillingAuditLog" RESTART IDENTITY CASCADE`
      );
      break;
    } catch (err) {
      const deadlock = JSON.stringify((err as { meta?: unknown }).meta ?? "").includes("40P01");
      if (!deadlock || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 100 * attempt));
    }
  }
  invalidateCatalogCache();
  invalidateEntitlements();
}

export { prisma };

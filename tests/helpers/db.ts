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
  await prisma.$executeRawUnsafe(
    `TRUNCATE "Workspace", "User", "Coupon", "BillingAuditLog" RESTART IDENTITY CASCADE`
  );
  invalidateCatalogCache();
  invalidateEntitlements();
}

export { prisma };

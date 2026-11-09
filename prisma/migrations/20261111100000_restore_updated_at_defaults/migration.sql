-- 20261111090000_schema_sync dropped these defaults, but the startup billing bootstrap inserts the
-- default BillingSettings/plan rows without "updatedAt" (ON CONFLICT DO NOTHING still checks NOT NULL),
-- so it failed on databases built from migrations. schema.prisma now declares @default(now()) too.
ALTER TABLE "BillingPlan" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "BillingSettings" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Coupon" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Invoice" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "NotificationTemplate" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "PlanPrice" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "SystemSettings" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

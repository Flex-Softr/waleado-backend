-- Billing phase 2: coupons, wallet, reminders, phone verification, audit log.
-- Idempotent and "-- >>>"-separated so the API can apply it at startup
-- (see src/billing/ensure-billing-schema.ts).

-- >>>
DO $$ BEGIN
  CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENT', 'FIXED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
DO $$ BEGIN
  CREATE TYPE "CouponDuration" AS ENUM ('ONCE', 'FOREVER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
CREATE TABLE IF NOT EXISTS "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "discountType" "CouponDiscountType" NOT NULL,
    "discountValue" DECIMAL(12,2) NOT NULL,
    "duration" "CouponDuration" NOT NULL DEFAULT 'ONCE',
    "tiers" "Plan"[] NOT NULL DEFAULT ARRAY[]::"Plan"[],
    "cycles" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "maxRedemptions" INTEGER,
    "perWorkspaceLimit" INTEGER NOT NULL DEFAULT 1,
    "startsAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- >>>
CREATE UNIQUE INDEX IF NOT EXISTS "Coupon_code_key" ON "Coupon"("code");

-- >>>
ALTER TABLE "Workspace"
ADD COLUMN IF NOT EXISTS "walletBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "autoRenew" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "recurringCouponId" TEXT;

-- >>>
DO $$ BEGIN
  ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_recurringCouponId_fkey" FOREIGN KEY ("recurringCouponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "verifiedPhone" TEXT,
ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMP(3);

-- >>>
CREATE UNIQUE INDEX IF NOT EXISTS "User_verifiedPhone_key" ON "User"("verifiedPhone");

-- >>>
ALTER TABLE "Invoice" ALTER COLUMN "tier" DROP NOT NULL;

-- >>>
ALTER TABLE "Invoice"
ADD COLUMN IF NOT EXISTS "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "couponId" TEXT,
ADD COLUMN IF NOT EXISTS "walletAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "paymentRef" TEXT,
ADD COLUMN IF NOT EXISTS "note" TEXT;

-- >>>
DO $$ BEGIN
  ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
ALTER TABLE "BillingSettings"
ADD COLUMN IF NOT EXISTS "renewalInvoiceDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN IF NOT EXISTS "reminderDays" INTEGER[] NOT NULL DEFAULT ARRAY[7, 3, 1, 0],
ADD COLUMN IF NOT EXISTS "usageAlertPercents" INTEGER[] NOT NULL DEFAULT ARRAY[80, 100],
ADD COLUMN IF NOT EXISTS "walletMinTopup" DECIMAL(12,2) NOT NULL DEFAULT 100,
ADD COLUMN IF NOT EXISTS "walletMaxTopup" DECIMAL(12,2) NOT NULL DEFAULT 100000;

-- >>>
CREATE TABLE IF NOT EXISTS "CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

-- >>>
CREATE UNIQUE INDEX IF NOT EXISTS "CouponRedemption_invoiceId_key" ON "CouponRedemption"("invoiceId");

-- >>>
CREATE INDEX IF NOT EXISTS "CouponRedemption_couponId_idx" ON "CouponRedemption"("couponId");

-- >>>
CREATE INDEX IF NOT EXISTS "CouponRedemption_workspaceId_idx" ON "CouponRedemption"("workspaceId");

-- >>>
DO $$ BEGIN
  ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
DO $$ BEGIN
  ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
DO $$ BEGIN
  ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
CREATE TABLE IF NOT EXISTS "WalletTransaction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balanceAfter" DECIMAL(12,2) NOT NULL,
    "type" TEXT NOT NULL,
    "invoiceId" TEXT,
    "note" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- >>>
CREATE INDEX IF NOT EXISTS "WalletTransaction_workspaceId_createdAt_idx" ON "WalletTransaction"("workspaceId", "createdAt");

-- >>>
DO $$ BEGIN
  ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
DO $$ BEGIN
  ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
CREATE TABLE IF NOT EXISTS "SystemSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "senderDeviceId" TEXT,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true,
    "requirePhoneVerification" BOOLEAN NOT NULL DEFAULT true,
    "idleFreeDeviceDays" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SystemSettings_pkey" PRIMARY KEY ("id")
);

-- >>>
-- Create the settings row once and, in the same statement, mark every existing user as
-- verified so phone verification only applies to accounts created from now on.
WITH created AS (
  INSERT INTO "SystemSettings" ("id") VALUES ('default')
  ON CONFLICT ("id") DO NOTHING
  RETURNING "id"
)
UPDATE "User" SET "phoneVerifiedAt" = "createdAt"
WHERE "phoneVerifiedAt" IS NULL AND EXISTS (SELECT 1 FROM created);

-- >>>
CREATE TABLE IF NOT EXISTS "NotificationTemplate" (
    "key" TEXT NOT NULL,
    "whatsappBody" TEXT,
    "emailSubject" TEXT,
    "emailBody" TEXT,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("key")
);

-- >>>
CREATE TABLE IF NOT EXISTS "NotificationLog" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "workspaceId" TEXT,
    "templateKey" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- >>>
CREATE UNIQUE INDEX IF NOT EXISTS "NotificationLog_dedupeKey_key" ON "NotificationLog"("dedupeKey");

-- >>>
CREATE INDEX IF NOT EXISTS "NotificationLog_workspaceId_createdAt_idx" ON "NotificationLog"("workspaceId", "createdAt");

-- >>>
CREATE TABLE IF NOT EXISTS "PhoneOtp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PhoneOtp_pkey" PRIMARY KEY ("id")
);

-- >>>
CREATE INDEX IF NOT EXISTS "PhoneOtp_userId_createdAt_idx" ON "PhoneOtp"("userId", "createdAt");

-- >>>
CREATE INDEX IF NOT EXISTS "PhoneOtp_phone_createdAt_idx" ON "PhoneOtp"("phone", "createdAt");

-- >>>
DO $$ BEGIN
  ALTER TABLE "PhoneOtp" ADD CONSTRAINT "PhoneOtp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
CREATE TABLE IF NOT EXISTS "BillingAuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingAuditLog_pkey" PRIMARY KEY ("id")
);

-- >>>
CREATE INDEX IF NOT EXISTS "BillingAuditLog_workspaceId_createdAt_idx" ON "BillingAuditLog"("workspaceId", "createdAt");

-- Brings a database built only from migrations in line with schema.prisma.
-- Earlier changes (AI skills, in-app notifications, some defaults) reached existing databases via
-- `prisma db push` without a migration, so a fresh database (CI, staging) was missing them.
-- Every statement is idempotent: on a database that already has these objects it changes nothing.

DO $$ BEGIN
  CREATE TYPE "NotificationAudience" AS ENUM ('CUSTOMER', 'ADMIN', 'ALL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "NotificationType" AS ENUM ('CAMPAIGN_COMPLETED', 'CAMPAIGN_PAUSED', 'CAMPAIGN_FAILED', 'DEVICE_DISCONNECTED', 'DEVICE_CONNECTED', 'SUBSCRIPTION_EXPIRING', 'PAYMENT_RECEIVED', 'SUBSCRIPTION_CANCELED', 'USER_REGISTERED', 'SYSTEM_ALERT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "AutoReplyRule" ADD COLUMN IF NOT EXISTS "aiSkillId" TEXT;

ALTER TABLE "BillingPlan" ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "BillingSettings" ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "BulkCampaign" ALTER COLUMN "delayMinSec" SET DEFAULT 150,
ALTER COLUMN "delayMaxSec" SET DEFAULT 200;

ALTER TABLE "Coupon" ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "Invoice" ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "NotificationTemplate" ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "PlanPrice" ALTER COLUMN "updatedAt" DROP DEFAULT;

ALTER TABLE "SystemSettings" ALTER COLUMN "updatedAt" DROP DEFAULT;

CREATE TABLE IF NOT EXISTS "AiSkill" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rolePrompt" TEXT NOT NULL,
    "servicesDescription" TEXT NOT NULL,
    "businessKnowledge" TEXT NOT NULL,
    "customInstructions" TEXT,
    "aiCredentialId" TEXT,
    "model" TEXT,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "maxTokens" INTEGER DEFAULT 1024,
    "continuousChat" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSkill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notifications" (
    "id" TEXT NOT NULL,
    "audience" "NotificationAudience" NOT NULL DEFAULT 'CUSTOMER',
    "workspace_id" TEXT,
    "user_id" TEXT,
    "type" "NotificationType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "message" TEXT NOT NULL,
    "link" VARCHAR(500),
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AiSkill_workspaceId_idx" ON "AiSkill"("workspaceId");

CREATE INDEX IF NOT EXISTS "AiSkill_aiCredentialId_idx" ON "AiSkill"("aiCredentialId");

CREATE UNIQUE INDEX IF NOT EXISTS "AiSkill_workspaceId_name_key" ON "AiSkill"("workspaceId", "name");

CREATE INDEX IF NOT EXISTS "notifications_workspace_id_audience_is_read_idx" ON "notifications"("workspace_id", "audience", "is_read");

CREATE INDEX IF NOT EXISTS "notifications_audience_is_read_idx" ON "notifications"("audience", "is_read");

CREATE INDEX IF NOT EXISTS "notifications_user_id_is_read_idx" ON "notifications"("user_id", "is_read");

CREATE INDEX IF NOT EXISTS "notifications_created_at_idx" ON "notifications"("created_at");

CREATE INDEX IF NOT EXISTS "AutoReplyRule_aiSkillId_idx" ON "AutoReplyRule"("aiSkillId");

DO $$ BEGIN
  ALTER TABLE "AiSkill" ADD CONSTRAINT "AiSkill_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AiSkill" ADD CONSTRAINT "AiSkill_aiCredentialId_fkey" FOREIGN KEY ("aiCredentialId") REFERENCES "AiCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AutoReplyRule" ADD CONSTRAINT "AutoReplyRule_aiSkillId_fkey" FOREIGN KEY ("aiSkillId") REFERENCES "AiSkill"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


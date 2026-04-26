-- CreateEnum
CREATE TYPE "BulkCampaignStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BulkSelectionMode" AS ENUM ('GROUPS', 'ALL_VERIFIED', 'MANUAL');

-- CreateEnum
CREATE TYPE "BulkScheduleType" AS ENUM ('IMMEDIATE', 'SCHEDULED');

-- CreateTable
CREATE TABLE "BulkCampaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "OutboundKind" NOT NULL,
    "bodyText" TEXT,
    "templateId" TEXT,
    "deviceIds" JSONB NOT NULL,
    "selectionMode" "BulkSelectionMode" NOT NULL,
    "groupIds" JSONB,
    "recipientPhones" JSONB NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "attachmentType" TEXT,
    "scheduleType" "BulkScheduleType" NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "delaySec" INTEGER NOT NULL DEFAULT 5,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "status" "BulkCampaignStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkCampaign_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "OutboundMessage" ADD COLUMN "bulkCampaignId" TEXT;

-- CreateIndex
CREATE INDEX "BulkCampaign_workspaceId_idx" ON "BulkCampaign"("workspaceId");

-- CreateIndex
CREATE INDEX "BulkCampaign_createdAt_idx" ON "BulkCampaign"("createdAt");

-- CreateIndex
CREATE INDEX "OutboundMessage_bulkCampaignId_idx" ON "OutboundMessage"("bulkCampaignId");

-- AddForeignKey
ALTER TABLE "BulkCampaign" ADD CONSTRAINT "BulkCampaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkCampaign" ADD CONSTRAINT "BulkCampaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_bulkCampaignId_fkey" FOREIGN KEY ("bulkCampaignId") REFERENCES "BulkCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

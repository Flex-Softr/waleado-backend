-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BulkCampaignStatus" ADD VALUE 'PENDING';
ALTER TYPE "BulkCampaignStatus" ADD VALUE 'RUNNING';

-- AlterTable
ALTER TABLE "BulkCampaign" ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "BulkCampaignRecipient" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "lastReplyAt" TIMESTAMP(3),
ADD COLUMN     "lastReplyMessageId" TEXT,
ADD COLUMN     "lastReplyText" TEXT,
ADD COLUMN     "repliedAt" TIMESTAMP(3),
ADD COLUMN     "seenAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "BulkCampaignRecipient_workspaceId_phone_sentAt_idx" ON "BulkCampaignRecipient"("workspaceId", "phone", "sentAt");

-- CreateIndex
CREATE INDEX "BulkCampaignRecipient_campaignId_repliedAt_idx" ON "BulkCampaignRecipient"("campaignId", "repliedAt");

CREATE TYPE "BulkCampaignRecipientStatus" AS ENUM ('PENDING', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'SIMULATED', 'SKIPPED', 'CANCELED');

CREATE TABLE "BulkCampaignRecipient" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "contactId" TEXT,
    "groupId" TEXT,
    "deviceId" TEXT,
    "status" "BulkCampaignRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "queuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "outboundMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkCampaignRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BulkCampaignRecipient_outboundMessageId_key" ON "BulkCampaignRecipient"("outboundMessageId");
CREATE UNIQUE INDEX "BulkCampaignRecipient_campaignId_phone_key" ON "BulkCampaignRecipient"("campaignId", "phone");
CREATE INDEX "BulkCampaignRecipient_workspaceId_idx" ON "BulkCampaignRecipient"("workspaceId");
CREATE INDEX "BulkCampaignRecipient_campaignId_status_idx" ON "BulkCampaignRecipient"("campaignId", "status");
CREATE INDEX "BulkCampaignRecipient_deviceId_idx" ON "BulkCampaignRecipient"("deviceId");
CREATE INDEX "BulkCampaignRecipient_outboundMessageId_idx" ON "BulkCampaignRecipient"("outboundMessageId");

ALTER TABLE "BulkCampaignRecipient" ADD CONSTRAINT "BulkCampaignRecipient_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BulkCampaignRecipient" ADD CONSTRAINT "BulkCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BulkCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BulkCampaignRecipient" ADD CONSTRAINT "BulkCampaignRecipient_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BulkCampaignRecipient" ADD CONSTRAINT "BulkCampaignRecipient_outboundMessageId_fkey" FOREIGN KEY ("outboundMessageId") REFERENCES "OutboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

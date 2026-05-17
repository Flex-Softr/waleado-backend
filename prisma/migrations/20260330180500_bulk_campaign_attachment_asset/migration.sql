-- AlterTable
ALTER TABLE "BulkCampaign" ADD COLUMN "attachmentAssetId" TEXT;

-- CreateIndex
CREATE INDEX "BulkCampaign_attachmentAssetId_idx" ON "BulkCampaign"("attachmentAssetId");

-- AddForeignKey
ALTER TABLE "BulkCampaign" ADD CONSTRAINT "BulkCampaign_attachmentAssetId_fkey" FOREIGN KEY ("attachmentAssetId") REFERENCES "TemplateMediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

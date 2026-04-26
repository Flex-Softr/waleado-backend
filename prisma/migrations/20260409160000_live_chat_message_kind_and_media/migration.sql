-- CreateEnum
CREATE TYPE "LiveChatContentKind" AS ENUM (
  'TEXT',
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'DOCUMENT',
  'STICKER',
  'LOCATION',
  'CONTACT',
  'UNKNOWN'
);

-- AlterTable
ALTER TABLE "LiveChatMessage"
ADD COLUMN "kind" "LiveChatContentKind" NOT NULL DEFAULT 'TEXT',
ADD COLUMN "mediaAssetId" TEXT,
ADD COLUMN "mimeType" TEXT,
ADD COLUMN "fileName" TEXT,
ADD COLUMN "meta" JSONB;

-- CreateIndex
CREATE INDEX "LiveChatMessage_mediaAssetId_idx" ON "LiveChatMessage"("mediaAssetId");

-- AddForeignKey
ALTER TABLE "LiveChatMessage"
ADD CONSTRAINT "LiveChatMessage_mediaAssetId_fkey"
FOREIGN KEY ("mediaAssetId")
REFERENCES "TemplateMediaAsset"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

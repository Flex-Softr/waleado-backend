-- CreateEnum
CREATE TYPE "AutoReplyTriggerType" AS ENUM ('KEYWORD', 'EXACT', 'CONTAINS', 'STARTS_WITH', 'ENDS_WITH', 'REGEX');

-- CreateEnum
CREATE TYPE "AutoReplyMessageMode" AS ENUM ('TEXT', 'TEMPLATE', 'MEDIA');

-- AlterTable
ALTER TABLE "AutoReplyRule" ADD COLUMN "triggerType" "AutoReplyTriggerType" NOT NULL DEFAULT 'CONTAINS';
ALTER TABLE "AutoReplyRule" ADD COLUMN "caseSensitive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutoReplyRule" ADD COLUMN "messageMode" "AutoReplyMessageMode" NOT NULL DEFAULT 'TEXT';
ALTER TABLE "AutoReplyRule" ADD COLUMN "mediaAssetId" TEXT;
ALTER TABLE "AutoReplyRule" ADD COLUMN "mediaCaption" TEXT;
ALTER TABLE "AutoReplyRule" ADD COLUMN "openAiEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutoReplyRule" ADD COLUMN "openAiSettings" JSONB;

-- Migrate keyword column to TEXT and infer messageMode from template
ALTER TABLE "AutoReplyRule" ALTER COLUMN "keyword" TYPE TEXT;

UPDATE "AutoReplyRule"
SET "messageMode" = 'TEMPLATE'
WHERE "templateId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "AutoReplyRule" ADD CONSTRAINT "AutoReplyRule_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "TemplateMediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AutoReplyRule_mediaAssetId_idx" ON "AutoReplyRule"("mediaAssetId");

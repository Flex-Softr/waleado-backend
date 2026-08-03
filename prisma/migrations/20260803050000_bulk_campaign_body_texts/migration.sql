-- AlterTable
ALTER TABLE "BulkCampaign" ADD COLUMN "bodyTexts" JSONB;

-- Backfill from single bodyText
UPDATE "BulkCampaign"
SET "bodyTexts" = jsonb_build_array("bodyText")
WHERE "bodyText" IS NOT NULL AND btrim("bodyText") <> '';

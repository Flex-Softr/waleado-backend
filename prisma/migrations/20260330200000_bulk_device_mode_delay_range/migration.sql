-- CreateEnum
CREATE TYPE "BulkDeviceMode" AS ENUM ('SINGLE', 'FAILOVER', 'ROUND_ROBIN');

-- AlterTable
ALTER TABLE "BulkCampaign" ADD COLUMN "deviceMode" "BulkDeviceMode" NOT NULL DEFAULT 'ROUND_ROBIN';

-- AlterTable: migrate delaySec -> delay range
ALTER TABLE "BulkCampaign" ADD COLUMN "delayMinSec" INTEGER NOT NULL DEFAULT 12;
ALTER TABLE "BulkCampaign" ADD COLUMN "delayMaxSec" INTEGER NOT NULL DEFAULT 45;

UPDATE "BulkCampaign"
SET
  "delayMinSec" = GREATEST(12, LEAST(3600, "delaySec")),
  "delayMaxSec" = GREATEST(12, LEAST(3600, "delaySec"))
WHERE TRUE;

ALTER TABLE "BulkCampaign" DROP COLUMN "delaySec";

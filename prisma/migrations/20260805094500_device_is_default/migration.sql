-- AlterTable
ALTER TABLE "Device" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Device_workspaceId_isDefault_idx" ON "Device"("workspaceId", "isDefault");

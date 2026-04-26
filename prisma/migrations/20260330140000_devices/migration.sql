-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('QR_READY', 'CONNECTED');

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'QR_READY',
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_sessionId_key" ON "Device"("sessionId");

-- CreateIndex
CREATE INDEX "Device_workspaceId_idx" ON "Device"("workspaceId");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

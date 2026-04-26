-- CreateEnum
CREATE TYPE "LiveChatMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "LiveChatThread" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "peerPhone" TEXT NOT NULL,
    "peerLabel" TEXT NOT NULL DEFAULT '',
    "lastPreview" TEXT NOT NULL DEFAULT '',
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveChatThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveChatMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "direction" "LiveChatMessageDirection" NOT NULL,
    "bodyText" TEXT NOT NULL,
    "outboundMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveChatMessage_outboundMessageId_key" ON "LiveChatMessage"("outboundMessageId");

-- CreateIndex
CREATE INDEX "LiveChatMessage_threadId_createdAt_idx" ON "LiveChatMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "LiveChatThread_workspaceId_deviceId_idx" ON "LiveChatThread"("workspaceId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveChatThread_workspaceId_deviceId_peerPhone_key" ON "LiveChatThread"("workspaceId", "deviceId", "peerPhone");

-- AddForeignKey
ALTER TABLE "LiveChatThread" ADD CONSTRAINT "LiveChatThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveChatThread" ADD CONSTRAINT "LiveChatThread_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveChatMessage" ADD CONSTRAINT "LiveChatMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "LiveChatThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveChatMessage" ADD CONSTRAINT "LiveChatMessage_outboundMessageId_fkey" FOREIGN KEY ("outboundMessageId") REFERENCES "OutboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

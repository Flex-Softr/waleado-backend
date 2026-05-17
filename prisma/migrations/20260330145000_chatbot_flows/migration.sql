-- CreateEnum
CREATE TYPE "ChatbotFlowNodeKind" AS ENUM ('MESSAGE', 'QUESTION', 'ACTION', 'CONDITION');

-- CreateTable
CREATE TABLE "ChatbotFlow" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "triggerKeywords" TEXT NOT NULL,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "conversationCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatbotFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatbotFlowNode" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "kind" "ChatbotFlowNodeKind" NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatbotFlowNode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatbotFlow_workspaceId_idx" ON "ChatbotFlow"("workspaceId");

-- CreateIndex
CREATE INDEX "ChatbotFlow_deviceId_idx" ON "ChatbotFlow"("deviceId");

-- CreateIndex
CREATE INDEX "ChatbotFlowNode_flowId_idx" ON "ChatbotFlowNode"("flowId");

-- AddForeignKey
ALTER TABLE "ChatbotFlow" ADD CONSTRAINT "ChatbotFlow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatbotFlow" ADD CONSTRAINT "ChatbotFlow_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatbotFlowNode" ADD CONSTRAINT "ChatbotFlowNode_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "ChatbotFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

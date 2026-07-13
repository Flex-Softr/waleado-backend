CREATE TYPE "CallResponderCallType" AS ENUM ('RECEIVED', 'OUTGOING', 'MISSED', 'REJECTED');

CREATE TYPE "CallResponderMessageMode" AS ENUM ('TEXT', 'TEMPLATE');

CREATE TABLE "CallResponderRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "callTypes" "CallResponderCallType"[],
    "responseDelayMinutes" INTEGER NOT NULL DEFAULT 0,
    "messageMode" "CallResponderMessageMode" NOT NULL DEFAULT 'TEXT',
    "messageBody" TEXT,
    "templateId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "responsesSent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallResponderRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CallResponderRule_workspaceId_idx" ON "CallResponderRule"("workspaceId");
CREATE INDEX "CallResponderRule_deviceId_idx" ON "CallResponderRule"("deviceId");
CREATE INDEX "CallResponderRule_templateId_idx" ON "CallResponderRule"("templateId");

ALTER TABLE "CallResponderRule" ADD CONSTRAINT "CallResponderRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallResponderRule" ADD CONSTRAINT "CallResponderRule_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallResponderRule" ADD CONSTRAINT "CallResponderRule_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

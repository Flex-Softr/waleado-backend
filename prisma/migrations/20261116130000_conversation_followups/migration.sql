-- AI follow-up planner: per-contact lead stage, summary and planned follow-up.
DO $$ BEGIN
  CREATE TYPE "LeadStage" AS ENUM ('NEW', 'INTERESTED', 'READY_TO_BUY', 'OBJECTION', 'CONVERTED', 'LOST');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "FollowUpStatus" AS ENUM ('NONE', 'SCHEDULED', 'SENT', 'CANCELED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "ConversationFollowUp" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "peerKey" TEXT NOT NULL,
  "peerPhone" TEXT,
  "peerLabel" TEXT NOT NULL DEFAULT '',
  "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
  "summary" TEXT NOT NULL DEFAULT '',
  "needsHuman" BOOLEAN NOT NULL DEFAULT false,
  "followUpStatus" "FollowUpStatus" NOT NULL DEFAULT 'NONE',
  "followUpAt" TIMESTAMP(3),
  "followUpMessage" TEXT,
  "followUpsSent" INTEGER NOT NULL DEFAULT 0,
  "lastFollowUpSentAt" TIMESTAMP(3),
  "lastConversationAt" TIMESTAMP(3) NOT NULL,
  "analyzedAt" TIMESTAMP(3),
  "analyzedActivityAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationFollowUp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConversationFollowUp_workspaceId_deviceId_peerKey_key"
  ON "ConversationFollowUp"("workspaceId", "deviceId", "peerKey");
CREATE INDEX IF NOT EXISTS "ConversationFollowUp_workspaceId_followUpStatus_followUpAt_idx"
  ON "ConversationFollowUp"("workspaceId", "followUpStatus", "followUpAt");
CREATE INDEX IF NOT EXISTS "ConversationFollowUp_workspaceId_lastConversationAt_idx"
  ON "ConversationFollowUp"("workspaceId", "lastConversationAt");

DO $$ BEGIN
  ALTER TABLE "ConversationFollowUp" ADD CONSTRAINT "ConversationFollowUp_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ConversationFollowUp" ADD CONSTRAINT "ConversationFollowUp_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

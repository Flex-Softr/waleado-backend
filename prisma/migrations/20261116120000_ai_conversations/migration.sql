-- Continuous AI conversations: rule settings + persistent per-contact conversation window.
ALTER TABLE "AutoReplyRule" ADD COLUMN IF NOT EXISTS "conversationHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "AutoReplyRule" ADD COLUMN IF NOT EXISTS "fallbackForNewChats" BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  CREATE TYPE "AiConversationStatus" AS ENUM ('ACTIVE', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "AiConversation" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "peerKey" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "status" "AiConversationStatus" NOT NULL DEFAULT 'ACTIVE',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AiConversation_workspaceId_deviceId_peerKey_key"
  ON "AiConversation"("workspaceId", "deviceId", "peerKey");
CREATE INDEX IF NOT EXISTS "AiConversation_workspaceId_deviceId_status_idx"
  ON "AiConversation"("workspaceId", "deviceId", "status");
CREATE INDEX IF NOT EXISTS "AiConversation_ruleId_idx" ON "AiConversation"("ruleId");

DO $$ BEGIN
  ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "AutoReplyRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

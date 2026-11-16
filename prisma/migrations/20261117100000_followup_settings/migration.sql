-- Follow-up settings (auto-send is opt-in) and the rule that handled each conversation.
ALTER TABLE "ConversationFollowUp" ADD COLUMN IF NOT EXISTS "ruleId" TEXT;

CREATE TABLE IF NOT EXISTS "FollowUpSettings" (
  "workspaceId" TEXT NOT NULL,
  "autoSend" BOOLEAN NOT NULL DEFAULT false,
  "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "windowStartHour" INTEGER NOT NULL DEFAULT 9,
  "windowEndHour" INTEGER NOT NULL DEFAULT 21,
  "maxFollowUps" INTEGER NOT NULL DEFAULT 3,
  "dailyLimitPerDevice" INTEGER NOT NULL DEFAULT 30,
  "idleHours" INTEGER NOT NULL DEFAULT 2,
  "maxDays" INTEGER NOT NULL DEFAULT 30,
  "instructions" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FollowUpSettings_pkey" PRIMARY KEY ("workspaceId")
);

DO $$ BEGIN
  ALTER TABLE "FollowUpSettings" ADD CONSTRAINT "FollowUpSettings_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Owner-controlled follow-ups: AI mode (auto / suggest / off), manual entries, suggestions.
ALTER TYPE "FollowUpStatus" ADD VALUE IF NOT EXISTS 'SUGGESTED';

DO $$ BEGIN
  CREATE TYPE "FollowUpAiMode" AS ENUM ('AUTO', 'SUGGEST', 'OFF');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "FollowUpSource" AS ENUM ('AI', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ConversationFollowUp" ADD COLUMN IF NOT EXISTS "source" "FollowUpSource" NOT NULL DEFAULT 'AI';
ALTER TABLE "ConversationFollowUp" ADD COLUMN IF NOT EXISTS "manualLock" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ConversationFollowUp" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "ConversationFollowUp" ADD COLUMN IF NOT EXISTS "plannedAt" TIMESTAMP(3);

ALTER TABLE "FollowUpSettings" ADD COLUMN IF NOT EXISTS "aiMode" "FollowUpAiMode" NOT NULL DEFAULT 'SUGGEST';

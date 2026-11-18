-- Follow-ups can send a saved message template instead of plain text.
ALTER TABLE "ConversationFollowUp" ADD COLUMN IF NOT EXISTS "followUpTemplateId" TEXT;

DO $$ BEGIN
  ALTER TABLE "ConversationFollowUp" ADD CONSTRAINT "ConversationFollowUp_followUpTemplateId_fkey"
    FOREIGN KEY ("followUpTemplateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

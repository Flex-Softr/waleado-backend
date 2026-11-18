-- Template library: tags, alternate versions, variables and where each template is offered.
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "versions" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "variables" JSONB;
ALTER TABLE "MessageTemplate" ADD COLUMN IF NOT EXISTS "showIn" TEXT[] DEFAULT ARRAY['follow_up', 'auto_reply', 'campaign', 'live_chat']::TEXT[];

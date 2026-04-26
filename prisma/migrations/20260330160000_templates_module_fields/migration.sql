-- AlterTable
ALTER TABLE "MessageTemplate" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'general';
ALTER TABLE "MessageTemplate" ADD COLUMN "typeId" TEXT NOT NULL DEFAULT 'text_message';
ALTER TABLE "MessageTemplate" ADD COLUMN "footer" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN "buttons" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_workspaceId_waTemplateName_key" ON "MessageTemplate"("workspaceId", "waTemplateName");

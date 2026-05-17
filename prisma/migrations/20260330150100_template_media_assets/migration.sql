-- AlterTable
ALTER TABLE "MessageTemplate" ADD COLUMN "media" JSONB;

-- CreateTable
CREATE TABLE "TemplateMediaAsset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateMediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TemplateMediaAsset_workspaceId_idx" ON "TemplateMediaAsset"("workspaceId");

-- AddForeignKey
ALTER TABLE "TemplateMediaAsset" ADD CONSTRAINT "TemplateMediaAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

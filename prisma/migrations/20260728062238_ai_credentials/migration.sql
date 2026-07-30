-- CreateEnum
CREATE TYPE "AiProvider" AS ENUM ('GEMINI', 'OPENROUTER');

-- AlterTable
ALTER TABLE "ChatbotFlow" ADD COLUMN     "aiEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiSettings" JSONB;

-- CreateTable
CREATE TABLE "AiCredential" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "AiProvider" NOT NULL,
    "apiKey" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCredential_workspaceId_idx" ON "AiCredential"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AiCredential_workspaceId_name_key" ON "AiCredential"("workspaceId", "name");

-- AddForeignKey
ALTER TABLE "AiCredential" ADD CONSTRAINT "AiCredential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "clientSecretPrefix" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_clientId_key" ON "ApiCredential"("clientId");

-- CreateIndex
CREATE INDEX "ApiCredential_workspaceId_idx" ON "ApiCredential"("workspaceId");

-- CreateIndex
CREATE INDEX "ApiCredential_clientId_idx" ON "ApiCredential"("clientId");

-- AddForeignKey
ALTER TABLE "ApiCredential" ADD CONSTRAINT "ApiCredential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

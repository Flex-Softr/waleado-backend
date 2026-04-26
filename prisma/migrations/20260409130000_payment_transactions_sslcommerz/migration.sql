-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "lastPaymentGateway" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "payment_transactions" (
    "id" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "tran_id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "session_key" TEXT,
    "val_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payment_transactions_tran_id_key" ON "payment_transactions"("tran_id");
CREATE INDEX IF NOT EXISTS "payment_transactions_workspaceId_idx" ON "payment_transactions"("workspaceId");

ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

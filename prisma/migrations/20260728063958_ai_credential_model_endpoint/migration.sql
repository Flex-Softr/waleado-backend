/*
  Warnings:

  - Added the required column `model` to the `AiCredential` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "AiCredential" ADD COLUMN     "apiEndpoint" TEXT,
ADD COLUMN     "model" TEXT NOT NULL;

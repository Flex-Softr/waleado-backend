-- Marks paid plan periods whose unused value was already given as upgrade credit.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "supersededAt" TIMESTAMP(3);

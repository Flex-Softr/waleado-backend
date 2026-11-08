-- New STARTER tier. Kept in its own migration: a new enum value cannot be used
-- in the same transaction that adds it.

-- >>>
ALTER TYPE "Plan" ADD VALUE IF NOT EXISTS 'STARTER' BEFORE 'PRO';

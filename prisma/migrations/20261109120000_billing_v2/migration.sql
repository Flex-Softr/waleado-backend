-- Billing v2: admin-editable plans and prices, lifetime deals, invoices, reverse trial.
-- Every statement is idempotent and separated by a "-- >>>" marker so the API can also
-- apply this file safely at startup. Depends on 20261109115900_plan_starter_tier (see src/billing/ensure-billing-schema.ts).

-- >>>
ALTER TABLE "Workspace"
ADD COLUMN IF NOT EXISTS "billingMonths" INTEGER,
ADD COLUMN IF NOT EXISTS "lifetimeTier" "Plan";

-- >>>
CREATE TABLE IF NOT EXISTS "BillingPlan" (
    "tier" "Plan" NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "highlight" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "limits" JSONB NOT NULL,
    "highlights" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingPlan_pkey" PRIMARY KEY ("tier")
);

-- >>>
CREATE TABLE IF NOT EXISTS "PlanPrice" (
    "id" TEXT NOT NULL,
    "tier" "Plan" NOT NULL,
    "months" INTEGER NOT NULL,
    "amountBdt" DECIMAL(12,2) NOT NULL,
    "compareAtBdt" DECIMAL(12,2),
    "amountUsd" DECIMAL(12,2),
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "saleCap" INTEGER,
    "saleEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanPrice_pkey" PRIMARY KEY ("id")
);

-- >>>
CREATE UNIQUE INDEX IF NOT EXISTS "PlanPrice_tier_months_key" ON "PlanPrice"("tier", "months");

-- >>>
DO $$ BEGIN
  ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_tier_fkey" FOREIGN KEY ("tier") REFERENCES "BillingPlan"("tier") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
CREATE TABLE IF NOT EXISTS "BillingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "trialDays" INTEGER NOT NULL DEFAULT 7,
    "trialTier" "Plan" NOT NULL DEFAULT 'PRO',
    "graceDays" INTEGER NOT NULL DEFAULT 3,
    "brandingFooter" TEXT DEFAULT 'Sent via Waleado — waleado.app',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingSettings_pkey" PRIMARY KEY ("id")
);

-- >>>
CREATE TABLE IF NOT EXISTS "Invoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tier" "Plan" NOT NULL,
    "months" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "credit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unpaid',
    "gateway" TEXT,
    "description" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- >>>
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_number_key" ON "Invoice"("number");

-- >>>
CREATE INDEX IF NOT EXISTS "Invoice_workspaceId_createdAt_idx" ON "Invoice"("workspaceId", "createdAt");

-- >>>
CREATE INDEX IF NOT EXISTS "Invoice_status_idx" ON "Invoice"("status");

-- >>>
DO $$ BEGIN
  ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
ALTER TABLE "payment_transactions" ADD COLUMN IF NOT EXISTS "invoice_id" TEXT;

-- >>>
CREATE INDEX IF NOT EXISTS "payment_transactions_invoice_id_idx" ON "payment_transactions"("invoice_id");

-- >>>
DO $$ BEGIN
  ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- >>>
CREATE SEQUENCE IF NOT EXISTS "invoice_number_seq" START 1001;

-- >>>
-- Default settings and packages. ON CONFLICT DO NOTHING keeps anything an admin already edited.
INSERT INTO "BillingSettings" ("id") VALUES ('default') ON CONFLICT ("id") DO NOTHING;

-- >>>
INSERT INTO "BillingPlan" ("tier", "name", "tagline", "isPublic", "highlight", "sortOrder", "limits", "highlights") VALUES
('FREE', 'Free', 'Free forever — try Waleado at zero cost', true, false, 0,
 '{"devices":1,"messagesPerDay":50,"messagesPerMonth":null,"contacts":500,"bulkRecipientsPerCampaign":50,"bulkMessageVariants":2,"autoReplyRules":3,"templates":5,"chatbotFlows":0,"features":{"ai":false,"chatbot":false,"api":false,"groupGrabber":false,"callResponder":false,"bulkScheduling":false,"removeBranding":false}}',
 '["1 WhatsApp device","50 messages / day","500 contacts","Live chat inbox","3 auto-reply rules","Bulk campaigns up to 50 recipients"]'),
('STARTER', 'Starter', 'For small shops getting started', true, false, 1,
 '{"devices":2,"messagesPerDay":null,"messagesPerMonth":10000,"contacts":5000,"bulkRecipientsPerCampaign":null,"bulkMessageVariants":5,"autoReplyRules":null,"templates":50,"chatbotFlows":3,"features":{"ai":false,"chatbot":true,"api":true,"groupGrabber":false,"callResponder":false,"bulkScheduling":false,"removeBranding":true}}',
 '["2 WhatsApp devices","10,000 messages / month","5,000 contacts","Unlimited auto-replies","3 chatbot flows","API access","No Waleado branding"]'),
('PRO', 'Pro', 'Everything you need to grow', true, true, 2,
 '{"devices":5,"messagesPerDay":null,"messagesPerMonth":50000,"contacts":25000,"bulkRecipientsPerCampaign":null,"bulkMessageVariants":10,"autoReplyRules":null,"templates":null,"chatbotFlows":null,"features":{"ai":true,"chatbot":true,"api":true,"groupGrabber":true,"callResponder":true,"bulkScheduling":true,"removeBranding":true}}',
 '["5 WhatsApp devices","50,000 messages / month","25,000 contacts","AI auto-reply & rewrite","Unlimited chatbot flows","Scheduled campaigns","Group grabber & call responder","WhatsApp support"]'),
('BUSINESS', 'Business', 'High volume with priority support', true, false, 3,
 '{"devices":15,"messagesPerDay":null,"messagesPerMonth":null,"contacts":null,"bulkRecipientsPerCampaign":null,"bulkMessageVariants":20,"autoReplyRules":null,"templates":null,"chatbotFlows":null,"features":{"ai":true,"chatbot":true,"api":true,"groupGrabber":true,"callResponder":true,"bulkScheduling":true,"removeBranding":true}}',
 '["15 WhatsApp devices","Unlimited messages (fair use)","Unlimited contacts","Everything in Pro","Priority support"]')
ON CONFLICT ("tier") DO NOTHING;

-- >>>
INSERT INTO "PlanPrice" ("id", "tier", "months", "amountBdt", "compareAtBdt", "label", "isActive", "saleCap") VALUES
('price-starter-1',   'STARTER', 1,  990.00,   NULL,     NULL,                true,  NULL),
('price-starter-3',   'STARTER', 3,  2690.00,  2970.00,  'Save 10%',          false, NULL),
('price-starter-6',   'STARTER', 6,  4990.00,  5940.00,  'Save 15%',          false, NULL),
('price-starter-12',  'STARTER', 12, 8900.00,  11880.00, '3 months free',     true,  NULL),
('price-starter-0',   'STARTER', 0,  19900.00, NULL,     'Launch offer',      true,  300),
('price-pro-1',       'PRO',     1,  2490.00,  NULL,     NULL,                true,  NULL),
('price-pro-3',       'PRO',     3,  6790.00,  7470.00,  'Save 10%',          false, NULL),
('price-pro-6',       'PRO',     6,  12700.00, 14940.00, 'Save 15%',          false, NULL),
('price-pro-12',      'PRO',     12, 22400.00, 29880.00, '3 months free',     true,  NULL),
('price-pro-0',       'PRO',     0,  49900.00, NULL,     'Launch offer',      true,  300),
('price-business-1',  'BUSINESS',1,  5990.00,  NULL,     NULL,                true,  NULL),
('price-business-3',  'BUSINESS',3,  16190.00, 17970.00, 'Save 10%',          false, NULL),
('price-business-6',  'BUSINESS',6,  30500.00, 35940.00, 'Save 15%',          false, NULL),
('price-business-12', 'BUSINESS',12, 53900.00, 71880.00, '3 months free',     true,  NULL),
('price-business-0',  'BUSINESS',0,  119000.00,NULL,     'Launch offer',      false, 100)
ON CONFLICT ("tier", "months") DO NOTHING;

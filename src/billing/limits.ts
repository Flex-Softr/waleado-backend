import { z } from "zod";

/** Count limits: a number, or null for unlimited. */
const countLimit = z.number().int().min(0).nullable();

export const planFeaturesSchema = z.object({
  ai: z.boolean().default(false),
  chatbot: z.boolean().default(false),
  api: z.boolean().default(false),
  groupGrabber: z.boolean().default(false),
  callResponder: z.boolean().default(false),
  bulkScheduling: z.boolean().default(false),
  removeBranding: z.boolean().default(false),
});

export const planLimitsSchema = z.object({
  devices: countLimit.default(1),
  messagesPerDay: countLimit.default(null),
  messagesPerMonth: countLimit.default(null),
  contacts: countLimit.default(null),
  bulkRecipientsPerCampaign: countLimit.default(null),
  bulkMessageVariants: z.number().int().min(1).max(50).default(2),
  autoReplyRules: countLimit.default(null),
  templates: countLimit.default(null),
  chatbotFlows: countLimit.default(null),
  features: planFeaturesSchema.default({}),
});

export type PlanFeatures = z.infer<typeof planFeaturesSchema>;
export type PlanFeature = keyof PlanFeatures;
export type PlanLimits = z.infer<typeof planLimitsSchema>;
export type CountLimitKey = Exclude<keyof PlanLimits, "features" | "bulkMessageVariants">;

export const PLAN_FEATURE_LABELS: Record<PlanFeature, string> = {
  ai: "AI replies",
  chatbot: "Chatbot flows",
  api: "API access",
  groupGrabber: "Group grabber",
  callResponder: "Call responder",
  bulkScheduling: "Scheduled campaigns",
  removeBranding: "Remove Waleado branding",
};

export const COUNT_LIMIT_LABELS: Record<CountLimitKey, string> = {
  devices: "WhatsApp devices",
  messagesPerDay: "messages per day",
  messagesPerMonth: "messages per month",
  contacts: "contacts",
  bulkRecipientsPerCampaign: "recipients per campaign",
  autoReplyRules: "auto-reply rules",
  templates: "templates",
  chatbotFlows: "chatbot flows",
};

/** Everything unlimited — used for platform admins. */
export const UNLIMITED_LIMITS: PlanLimits = {
  devices: null,
  messagesPerDay: null,
  messagesPerMonth: null,
  contacts: null,
  bulkRecipientsPerCampaign: null,
  bulkMessageVariants: 50,
  autoReplyRules: null,
  templates: null,
  chatbotFlows: null,
  features: {
    ai: true,
    chatbot: true,
    api: true,
    groupGrabber: true,
    callResponder: true,
    bulkScheduling: true,
    removeBranding: true,
  },
};

/** Safe fallback if a plan row is missing or its JSON is invalid. */
export const FALLBACK_FREE_LIMITS: PlanLimits = planLimitsSchema.parse({
  devices: 1,
  messagesPerDay: 50,
  contacts: 500,
  bulkRecipientsPerCampaign: 50,
  bulkMessageVariants: 2,
  autoReplyRules: 3,
  templates: 5,
  chatbotFlows: 0,
  features: {},
});

export function parsePlanLimits(raw: unknown): PlanLimits {
  const parsed = planLimitsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : FALLBACK_FREE_LIMITS;
}

import { OutboundStatus, Plan, type BillingSettings } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { planToApi, tierRank, type PlanIdApi } from "../lib/plan-mapping";
import { getCatalog, LIFETIME_MONTHS } from "./catalog.service";
import {
  COUNT_LIMIT_LABELS,
  FALLBACK_FREE_LIMITS,
  PLAN_FEATURE_LABELS,
  UNLIMITED_LIMITS,
  type CountLimitKey,
  type PlanFeature,
  type PlanLimits,
} from "./limits";

/** Where the workspace's current tier comes from. */
export type PlanSource = "admin" | "paid" | "grace" | "lifetime" | "trial" | "free";

export type WorkspaceBillingState = {
  plan: Plan;
  subscriptionStatus: string | null;
  currentPeriodEnd: Date | null;
  billingMonths: number | null;
  lifetimeTier: Plan | null;
  trialEndsAt: Date | null;
};

export type ResolvedPlan = {
  tier: Plan;
  source: PlanSource;
  /** End of the paid period, if a timed plan is running. */
  periodEnd: Date | null;
  /** Last moment the plan keeps working after periodEnd. */
  graceEndsAt: Date | null;
  trialEndsAt: Date | null;
  lifetimeTier: Plan | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const BILLING_WORKSPACE_SELECT = {
  plan: true,
  subscriptionStatus: true,
  currentPeriodEnd: true,
  billingMonths: true,
  lifetimeTier: true,
  trialEndsAt: true,
} as const;

/**
 * Pure resolution of the tier a workspace is entitled to right now.
 * Order: admin > running paid period > grace > lifetime > trial > free.
 */
export function resolvePlan(
  ws: WorkspaceBillingState,
  settings: Pick<BillingSettings, "graceDays" | "trialTier">,
  isPlatformAdmin: boolean,
  now = new Date()
): ResolvedPlan {
  const base = {
    trialEndsAt: ws.trialEndsAt,
    lifetimeTier: ws.lifetimeTier,
  };
  if (isPlatformAdmin) {
    return { ...base, tier: Plan.BUSINESS, source: "admin", periodEnd: null, graceEndsAt: null };
  }

  if (ws.plan !== Plan.FREE) {
    const end = ws.currentPeriodEnd;
    if (!end) {
      // No end date: lifetime purchase, or a plan an admin granted without expiry.
      const lifetime = ws.billingMonths === LIFETIME_MONTHS || ws.lifetimeTier === ws.plan;
      return {
        ...base,
        tier: ws.plan,
        source: lifetime ? "lifetime" : "paid",
        periodEnd: null,
        graceEndsAt: null,
      };
    }
    const graceEndsAt = new Date(end.getTime() + Math.max(0, settings.graceDays) * DAY_MS);
    if (end.getTime() > now.getTime()) {
      return { ...base, tier: ws.plan, source: "paid", periodEnd: end, graceEndsAt };
    }
    if (graceEndsAt.getTime() > now.getTime()) {
      return { ...base, tier: ws.plan, source: "grace", periodEnd: end, graceEndsAt };
    }
  }

  if (ws.lifetimeTier && ws.lifetimeTier !== Plan.FREE) {
    return { ...base, tier: ws.lifetimeTier, source: "lifetime", periodEnd: null, graceEndsAt: null };
  }

  if (ws.trialEndsAt && ws.trialEndsAt.getTime() > now.getTime()) {
    return { ...base, tier: settings.trialTier, source: "trial", periodEnd: null, graceEndsAt: null };
  }

  return { ...base, tier: Plan.FREE, source: "free", periodEnd: null, graceEndsAt: null };
}

export type Entitlements = ResolvedPlan & {
  workspaceId: string;
  planId: PlanIdApi;
  planName: string;
  limits: PlanLimits;
  isPlatformAdmin: boolean;
};

const ENT_CACHE_TTL_MS = 10_000;
const entCache = new Map<string, { at: number; value: Entitlements }>();

/** Drop cached entitlements after any plan change for a workspace. */
export function invalidateEntitlements(workspaceId?: string): void {
  if (workspaceId) entCache.delete(workspaceId);
  else entCache.clear();
}

export async function workspaceHasPlatformAdmin(workspaceId: string): Promise<boolean> {
  const m = await prisma.membership.findFirst({
    where: { workspaceId, user: { role: "ADMIN" } },
    select: { id: true },
  });
  return Boolean(m);
}

export async function getEntitlements(workspaceId: string): Promise<Entitlements> {
  const hit = entCache.get(workspaceId);
  if (hit && Date.now() - hit.at < ENT_CACHE_TTL_MS) return hit.value;

  const [ws, isPlatformAdmin, catalog] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: BILLING_WORKSPACE_SELECT }),
    workspaceHasPlatformAdmin(workspaceId),
    getCatalog(),
  ]);
  if (!ws) {
    throw new AppError(404, "Workspace not found", "NOT_FOUND");
  }
  const resolved = resolvePlan(ws, catalog.settings, isPlatformAdmin);
  const plan = catalog.plans.find((p) => p.tier === resolved.tier);
  const value: Entitlements = {
    ...resolved,
    workspaceId,
    planId: planToApi(resolved.tier),
    planName: isPlatformAdmin ? "Admin" : plan?.name ?? planToApi(resolved.tier),
    limits: isPlatformAdmin ? UNLIMITED_LIMITS : plan?.limits ?? FALLBACK_FREE_LIMITS,
    isPlatformAdmin,
  };
  entCache.set(workspaceId, { at: Date.now(), value });
  return value;
}

/** Lowest public tier that unlocks a feature / satisfies a predicate, for upgrade prompts. */
async function lowestTierWhere(pred: (l: PlanLimits) => boolean): Promise<PlanIdApi | null> {
  const { plans } = await getCatalog();
  const match = plans
    .filter((p) => p.isPublic && pred(p.limits))
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))[0];
  return match ? planToApi(match.tier) : null;
}

export async function hasFeature(workspaceId: string, feature: PlanFeature): Promise<boolean> {
  const ent = await getEntitlements(workspaceId);
  return ent.limits.features[feature] === true;
}

export async function assertFeature(workspaceId: string, feature: PlanFeature): Promise<void> {
  const ent = await getEntitlements(workspaceId);
  if (ent.limits.features[feature]) return;
  const requiredPlan = await lowestTierWhere((l) => l.features[feature] === true);
  throw new AppError(
    403,
    `${PLAN_FEATURE_LABELS[feature]} is not included in your ${ent.planName} plan. Upgrade to unlock it.`,
    "PLAN_FEATURE_LOCKED",
    { feature, label: PLAN_FEATURE_LABELS[feature], currentPlan: ent.planId, requiredPlan }
  );
}

/**
 * Throws when adding `adding` items would exceed a count limit.
 * `current` is the number the workspace already has.
 */
export async function assertCountLimit(
  workspaceId: string,
  key: CountLimitKey,
  current: number,
  adding = 1
): Promise<void> {
  const ent = await getEntitlements(workspaceId);
  const max = ent.limits[key];
  if (max === null || current + adding <= max) return;
  const requiredPlan = await lowestTierWhere((l) => {
    const v = l[key];
    return v === null || v >= current + adding;
  });
  throw new AppError(
    403,
    `Your ${ent.planName} plan allows up to ${max.toLocaleString("en-US")} ${COUNT_LIMIT_LABELS[key]}. Upgrade to add more.`,
    "PLAN_LIMIT_REACHED",
    { limit: key, label: COUNT_LIMIT_LABELS[key], max, current, currentPlan: ent.planId, requiredPlan }
  );
}

// ---------------------------------------------------------------------------
// Message quota (counts user-initiated outbound messages: single, live chat, bulk, API)
// ---------------------------------------------------------------------------

/** Quota days and months follow Bangladesh time (UTC+6). */
const QUOTA_TZ_OFFSET_MS = 6 * 60 * 60 * 1000;

export function quotaDayStart(now = new Date()): Date {
  const local = new Date(now.getTime() + QUOTA_TZ_OFFSET_MS);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(startLocal - QUOTA_TZ_OFFSET_MS);
}

export function quotaMonthStart(now = new Date()): Date {
  const local = new Date(now.getTime() + QUOTA_TZ_OFFSET_MS);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  return new Date(startLocal - QUOTA_TZ_OFFSET_MS);
}

const COUNTED_STATUSES = [OutboundStatus.QUEUED, OutboundStatus.SENT];

export async function countMessagesSince(workspaceId: string, since: Date): Promise<number> {
  return prisma.outboundMessage.count({
    where: { workspaceId, createdAt: { gte: since }, status: { in: COUNTED_STATUSES } },
  });
}

export type MessageUsage = {
  today: number;
  thisMonth: number;
  perDay: number | null;
  perMonth: number | null;
  /** How many more messages can be sent right now (null = unlimited). */
  remaining: number | null;
};

export async function getMessageUsage(workspaceId: string): Promise<MessageUsage> {
  const ent = await getEntitlements(workspaceId);
  const { messagesPerDay: perDay, messagesPerMonth: perMonth } = ent.limits;
  const [today, thisMonth] = await Promise.all([
    countMessagesSince(workspaceId, quotaDayStart()),
    countMessagesSince(workspaceId, quotaMonthStart()),
  ]);
  const caps: number[] = [];
  if (perDay !== null) caps.push(perDay - today);
  if (perMonth !== null) caps.push(perMonth - thisMonth);
  return {
    today,
    thisMonth,
    perDay,
    perMonth,
    remaining: caps.length ? Math.max(0, Math.min(...caps)) : null,
  };
}

export class MessageQuotaExceededError extends AppError {
  constructor(details: Record<string, unknown>, message: string) {
    super(403, message, "PLAN_LIMIT_REACHED", details);
    this.name = "MessageQuotaExceededError";
  }
}

/** Throws MessageQuotaExceededError when sending `count` more messages would exceed the plan quota. */
export async function assertMessageQuota(workspaceId: string, count = 1): Promise<void> {
  const ent = await getEntitlements(workspaceId);
  const { messagesPerDay: perDay, messagesPerMonth: perMonth } = ent.limits;
  if (perDay === null && perMonth === null) return;
  const usage = await getMessageUsage(workspaceId);
  const dayHit = perDay !== null && usage.today + count > perDay;
  const monthHit = perMonth !== null && usage.thisMonth + count > perMonth;
  if (!dayHit && !monthHit) return;
  const key: CountLimitKey = dayHit ? "messagesPerDay" : "messagesPerMonth";
  const max = (dayHit ? perDay : perMonth) as number;
  const requiredPlan = await lowestTierWhere((l) => {
    const v = l[key];
    return v === null || v > max;
  });
  const when = dayHit ? "today" : "this month";
  throw new MessageQuotaExceededError(
    {
      limit: key,
      label: COUNT_LIMIT_LABELS[key],
      max,
      current: dayHit ? usage.today : usage.thisMonth,
      currentPlan: ent.planId,
      requiredPlan,
    },
    `You've used all ${max.toLocaleString("en-US")} messages your ${ent.planName} plan allows ${when}. Upgrade to keep sending.`
  );
}

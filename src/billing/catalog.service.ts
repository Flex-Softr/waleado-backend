import { Plan, type BillingPlan, type BillingSettings, type PlanPrice } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { planToApi, tierRank, type PlanIdApi } from "../lib/plan-mapping";
import { FALLBACK_FREE_LIMITS, parsePlanLimits, type PlanLimits } from "./limits";

/** months value that represents a lifetime (one-time, never expires) price. */
export const LIFETIME_MONTHS = 0;

export type CatalogPrice = {
  id: string;
  tier: Plan;
  months: number;
  isLifetime: boolean;
  amountBdt: number;
  compareAtBdt: number | null;
  amountUsd: number | null;
  label: string | null;
  isActive: boolean;
  saleCap: number | null;
  saleEndsAt: Date | null;
  /** Paid sales so far (only computed for capped prices). */
  sold: number;
  /** Remaining units for capped prices, otherwise null. */
  remaining: number | null;
  /** Active, not sold out, and not past its end date. */
  available: boolean;
};

export type CatalogPlan = {
  tier: Plan;
  name: string;
  tagline: string | null;
  isPublic: boolean;
  highlight: boolean;
  sortOrder: number;
  limits: PlanLimits;
  highlights: string[];
  prices: CatalogPrice[];
};

export type Catalog = {
  plans: CatalogPlan[];
  settings: BillingSettings;
};

const DEFAULT_SETTINGS: BillingSettings = {
  id: "default",
  trialDays: 7,
  trialTier: Plan.PRO,
  graceDays: 3,
  brandingFooter: "Sent via Waleado — waleado.app",
  updatedAt: new Date(0),
};

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: Catalog } | null = null;
let inflight: Promise<Catalog> | null = null;

/** Call after any admin change to plans, prices or settings. */
export function invalidateCatalogCache(): void {
  cache = null;
}

function toNumber(d: { toString(): string } | null | undefined): number | null {
  if (d === null || d === undefined) return null;
  const n = Number(d.toString());
  return Number.isFinite(n) ? n : null;
}

function toHighlights(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

async function countPaidSales(prices: PlanPrice[]): Promise<Map<string, number>> {
  const capped = prices.filter((p) => p.saleCap !== null);
  const out = new Map<string, number>();
  if (!capped.length) return out;
  const rows = await prisma.invoice.groupBy({
    by: ["tier", "months"],
    where: {
      status: "paid",
      OR: capped.map((p) => ({ tier: p.tier, months: p.months })),
    },
    _count: { _all: true },
  });
  for (const r of rows) {
    out.set(`${r.tier}:${r.months}`, r._count._all);
  }
  return out;
}

function buildPrice(p: PlanPrice, sold: number, now: Date): CatalogPrice {
  const remaining = p.saleCap !== null ? Math.max(0, p.saleCap - sold) : null;
  const ended = p.saleEndsAt !== null && p.saleEndsAt.getTime() <= now.getTime();
  return {
    id: p.id,
    tier: p.tier,
    months: p.months,
    isLifetime: p.months === LIFETIME_MONTHS,
    amountBdt: toNumber(p.amountBdt) ?? 0,
    compareAtBdt: toNumber(p.compareAtBdt),
    amountUsd: toNumber(p.amountUsd),
    label: p.label,
    isActive: p.isActive,
    saleCap: p.saleCap,
    saleEndsAt: p.saleEndsAt,
    sold,
    remaining,
    available: p.isActive && !ended && (remaining === null || remaining > 0),
  };
}

function buildPlan(
  row: BillingPlan & { prices: PlanPrice[] },
  sales: Map<string, number>,
  now: Date
): CatalogPlan {
  const prices = [...row.prices]
    .sort((a, b) => {
      // Lifetime last, otherwise by months ascending.
      const am = a.months === LIFETIME_MONTHS ? Number.MAX_SAFE_INTEGER : a.months;
      const bm = b.months === LIFETIME_MONTHS ? Number.MAX_SAFE_INTEGER : b.months;
      return am - bm;
    })
    .map((p) => buildPrice(p, sales.get(`${p.tier}:${p.months}`) ?? 0, now));
  return {
    tier: row.tier,
    name: row.name,
    tagline: row.tagline,
    isPublic: row.isPublic,
    highlight: row.highlight,
    sortOrder: row.sortOrder,
    limits: parsePlanLimits(row.limits),
    highlights: toHighlights(row.highlights),
    prices,
  };
}

async function loadCatalog(): Promise<Catalog> {
  const [rows, settings] = await Promise.all([
    prisma.billingPlan.findMany({ include: { prices: true } }),
    prisma.billingSettings.findUnique({ where: { id: "default" } }),
  ]);
  const sales = await countPaidSales(rows.flatMap((r) => r.prices));
  const now = new Date();
  const plans = rows
    .map((r) => buildPlan(r, sales, now))
    .sort((a, b) => a.sortOrder - b.sortOrder || tierRank(a.tier) - tierRank(b.tier));
  return { plans, settings: settings ?? DEFAULT_SETTINGS };
}

/** Plans, prices and settings, cached for a short time (admin edits invalidate immediately). */
export async function getCatalog(): Promise<Catalog> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (!inflight) {
    inflight = loadCatalog()
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function getBillingSettings(): Promise<BillingSettings> {
  return (await getCatalog()).settings;
}

export async function getPlanLimits(tier: Plan): Promise<PlanLimits> {
  const plan = (await getCatalog()).plans.find((p) => p.tier === tier);
  return plan?.limits ?? FALLBACK_FREE_LIMITS;
}

export async function getCatalogPlan(tier: Plan): Promise<CatalogPlan | undefined> {
  return (await getCatalog()).plans.find((p) => p.tier === tier);
}

export function trialDurationMs(settings: BillingSettings): number {
  return Math.max(0, settings.trialDays) * 24 * 60 * 60 * 1000;
}

export type PublicPricingPrice = {
  months: number;
  isLifetime: boolean;
  amountBdt: number;
  compareAtBdt: number | null;
  amountUsd: number | null;
  /** amountBdt divided by months (null for lifetime). */
  perMonthBdt: number | null;
  label: string | null;
  saleCap: number | null;
  remaining: number | null;
  saleEndsAt: string | null;
  available: boolean;
};

export type PublicPricingPlan = {
  id: PlanIdApi;
  name: string;
  tagline: string | null;
  highlight: boolean;
  limits: PlanLimits;
  highlights: string[];
  prices: PublicPricingPrice[];
};

/** Shape served to pricing pages (dashboard + landing). Only public plans and active prices. */
export async function getPublicPricing(): Promise<{
  currency: "BDT";
  trialDays: number;
  trialPlanId: PlanIdApi;
  plans: PublicPricingPlan[];
}> {
  const { plans, settings } = await getCatalog();
  return {
    currency: "BDT",
    trialDays: settings.trialDays,
    trialPlanId: planToApi(settings.trialTier),
    plans: plans
      .filter((p) => p.isPublic)
      .map((p) => ({
        id: planToApi(p.tier),
        name: p.name,
        tagline: p.tagline,
        highlight: p.highlight,
        limits: p.limits,
        highlights: p.highlights,
        prices: p.prices
          .filter((x) => x.isActive)
          .map((x) => ({
            months: x.months,
            isLifetime: x.isLifetime,
            amountBdt: x.amountBdt,
            compareAtBdt: x.compareAtBdt,
            amountUsd: x.amountUsd,
            perMonthBdt: x.isLifetime ? null : Math.round(x.amountBdt / x.months),
            label: x.label,
            saleCap: x.saleCap,
            remaining: x.remaining,
            saleEndsAt: x.saleEndsAt?.toISOString() ?? null,
            available: x.available,
          })),
      })),
  };
}

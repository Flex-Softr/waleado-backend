import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { apiPlanToDb, planToApi, PLAN_ID_VALUES, PAID_PLAN_ID_VALUES } from "../../lib/plan-mapping";
import { getCatalog, invalidateCatalogCache, LIFETIME_MONTHS } from "../catalog.service";
import { invalidateEntitlements } from "../entitlements.service";
import { planLimitsSchema } from "../limits";

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getAdminBillingConfig() {
  invalidateCatalogCache();
  const { plans, settings } = await getCatalog();
  return {
    settings: {
      trialDays: settings.trialDays,
      trialPlanId: planToApi(settings.trialTier),
      graceDays: settings.graceDays,
      brandingFooter: settings.brandingFooter ?? "",
      renewalInvoiceDays: settings.renewalInvoiceDays,
      reminderDays: settings.reminderDays,
      usageAlertPercents: settings.usageAlertPercents,
      walletMinTopup: Number(settings.walletMinTopup),
      walletMaxTopup: Number(settings.walletMaxTopup),
    },
    plans: plans.map((p) => ({
      id: planToApi(p.tier),
      name: p.name,
      tagline: p.tagline,
      isPublic: p.isPublic,
      highlight: p.highlight,
      sortOrder: p.sortOrder,
      limits: p.limits,
      highlights: p.highlights,
      prices: p.prices.map((x) => ({
        id: x.id,
        months: x.months,
        isLifetime: x.isLifetime,
        amountBdt: x.amountBdt,
        compareAtBdt: x.compareAtBdt,
        amountUsd: x.amountUsd,
        label: x.label,
        isActive: x.isActive,
        saleCap: x.saleCap,
        saleEndsAt: x.saleEndsAt?.toISOString() ?? null,
        sold: x.sold,
        remaining: x.remaining,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Write: everything in one request so the pricing grid saves in a single click
// ---------------------------------------------------------------------------

const money = z.coerce.number().min(0).max(100_000_000);

const priceInput = z.object({
  planId: z.enum(PAID_PLAN_ID_VALUES),
  months: z.coerce.number().int().min(0).max(60),
  amountBdt: money,
  compareAtBdt: money.nullable().optional(),
  amountUsd: money.nullable().optional(),
  label: z.string().trim().max(60).nullable().optional(),
  isActive: z.boolean(),
  saleCap: z.coerce.number().int().min(0).max(1_000_000).nullable().optional(),
  saleEndsAt: z.string().datetime().nullable().optional(),
  /** Remove this billing cycle for the plan. */
  remove: z.boolean().optional(),
});

const planInput = z.object({
  planId: z.enum(PLAN_ID_VALUES),
  name: z.string().trim().min(1).max(40),
  tagline: z.string().trim().max(160).nullable().optional(),
  isPublic: z.boolean(),
  highlight: z.boolean(),
  sortOrder: z.coerce.number().int().min(0).max(100),
  limits: planLimitsSchema,
  highlights: z.array(z.string().trim().min(1).max(120)).max(20),
});

const dayList = z.array(z.coerce.number().int().min(0).max(60)).max(10);

const settingsInput = z
  .object({
    trialDays: z.coerce.number().int().min(0).max(90),
    trialPlanId: z.enum(PLAN_ID_VALUES),
    graceDays: z.coerce.number().int().min(0).max(60),
    brandingFooter: z.string().trim().max(200),
    renewalInvoiceDays: z.coerce.number().int().min(0).max(60),
    reminderDays: dayList,
    usageAlertPercents: z.array(z.coerce.number().int().min(1).max(100)).max(5),
    walletMinTopup: money,
    walletMaxTopup: money,
  })
  .refine((s) => s.walletMinTopup <= s.walletMaxTopup, {
    message: "Minimum top-up must not exceed the maximum",
    path: ["walletMinTopup"],
  });

export const adminBillingUpdateSchema = z.object({
  settings: settingsInput.optional(),
  plans: z.array(planInput).max(10).optional(),
  prices: z.array(priceInput).max(100).optional(),
});

export type AdminBillingUpdate = z.infer<typeof adminBillingUpdateSchema>;

export async function updateAdminBillingConfig(input: AdminBillingUpdate) {
  const ops: Prisma.PrismaPromise<unknown>[] = [];

  if (input.settings) {
    const st = input.settings;
    const data = {
      trialDays: st.trialDays,
      trialTier: apiPlanToDb(st.trialPlanId),
      graceDays: st.graceDays,
      brandingFooter: st.brandingFooter || null,
      renewalInvoiceDays: st.renewalInvoiceDays,
      reminderDays: [...new Set(st.reminderDays)].sort((a, b) => b - a),
      usageAlertPercents: [...new Set(st.usageAlertPercents)].sort((a, b) => a - b),
      walletMinTopup: st.walletMinTopup,
      walletMaxTopup: st.walletMaxTopup,
    };
    ops.push(
      prisma.billingSettings.upsert({
        where: { id: "default" },
        create: { id: "default", ...data },
        update: data,
      })
    );
  }

  for (const p of input.plans ?? []) {
    const data = {
      name: p.name,
      tagline: p.tagline ?? null,
      isPublic: p.isPublic,
      highlight: p.highlight,
      sortOrder: p.sortOrder,
      limits: p.limits as unknown as Prisma.InputJsonValue,
      highlights: p.highlights as unknown as Prisma.InputJsonValue,
    };
    const tier = apiPlanToDb(p.planId);
    ops.push(
      prisma.billingPlan.upsert({ where: { tier }, create: { tier, ...data }, update: data })
    );
  }

  for (const x of input.prices ?? []) {
    const tier = apiPlanToDb(x.planId);
    if (x.remove) {
      ops.push(prisma.planPrice.deleteMany({ where: { tier, months: x.months } }));
      continue;
    }
    if (x.months !== LIFETIME_MONTHS && x.amountBdt <= 0) {
      throw new AppError(400, `Price for ${x.planId} (${x.months} months) must be above 0.`, "VALIDATION");
    }
    const data = {
      amountBdt: x.amountBdt,
      compareAtBdt: x.compareAtBdt ?? null,
      amountUsd: x.amountUsd ?? null,
      label: x.label || null,
      isActive: x.isActive,
      saleCap: x.saleCap ?? null,
      saleEndsAt: x.saleEndsAt ? new Date(x.saleEndsAt) : null,
    };
    ops.push(
      prisma.planPrice.upsert({
        where: { tier_months: { tier, months: x.months } },
        create: { tier, months: x.months, ...data },
        update: data,
      })
    );
  }

  if (ops.length) {
    await prisma.$transaction(ops);
  }
  invalidateCatalogCache();
  invalidateEntitlements();
  return getAdminBillingConfig();
}

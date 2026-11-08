import { Plan, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { apiPlanToDb, planToApi, PLAN_ID_VALUES, PAID_PLAN_ID_VALUES } from "../lib/plan-mapping";
import { getCatalog, invalidateCatalogCache, LIFETIME_MONTHS } from "./catalog.service";
import { invalidateEntitlements } from "./entitlements.service";
import { planLimitsSchema } from "./limits";
import { serializeInvoice } from "./invoices.service";

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

const settingsInput = z.object({
  trialDays: z.coerce.number().int().min(0).max(90),
  trialPlanId: z.enum(PLAN_ID_VALUES),
  graceDays: z.coerce.number().int().min(0).max(60),
  brandingFooter: z.string().trim().max(200),
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

// ---------------------------------------------------------------------------
// Invoices (admin view)
// ---------------------------------------------------------------------------

export async function listAdminInvoices(input: {
  page: number;
  pageSize: number;
  status?: string;
  q?: string;
}) {
  const where: Prisma.InvoiceWhereInput = {};
  if (input.status) where.status = input.status;
  const q = input.q?.trim();
  if (q) {
    where.OR = [
      { number: { contains: q, mode: "insensitive" } },
      { workspace: { name: { contains: q, mode: "insensitive" } } },
      {
        workspace: {
          memberships: { some: { user: { email: { contains: q, mode: "insensitive" } } } },
        },
      },
    ];
  }
  const [total, rows] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
            memberships: {
              where: { role: "OWNER" },
              take: 1,
              select: { user: { select: { email: true, name: true } } },
            },
          },
        },
      },
    }),
  ]);
  return {
    page: input.page,
    pageSize: input.pageSize,
    total,
    invoices: rows.map((r) => ({
      ...serializeInvoice(r),
      workspace: { id: r.workspace.id, name: r.workspace.name },
      owner: r.workspace.memberships[0]?.user ?? null,
    })),
  };
}

/** Summary numbers for the admin pricing page. */
export async function getAdminBillingStats() {
  const now = new Date();
  const [byTier, lifetimeByTier, revenue] = await Promise.all([
    prisma.workspace.groupBy({ by: ["plan"], _count: { _all: true } }),
    prisma.workspace.groupBy({
      by: ["lifetimeTier"],
      where: { lifetimeTier: { not: null } },
      _count: { _all: true },
    }),
    prisma.invoice.aggregate({
      where: {
        status: "paid",
        paidAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) },
      },
      _sum: { total: true },
      _count: { _all: true },
    }),
  ]);
  const tiers: Plan[] = [Plan.FREE, Plan.STARTER, Plan.PRO, Plan.BUSINESS];
  return {
    workspacesByPlan: Object.fromEntries(
      tiers.map((t) => [planToApi(t), byTier.find((r) => r.plan === t)?._count._all ?? 0])
    ),
    lifetimeByPlan: Object.fromEntries(
      tiers.map((t) => [
        planToApi(t),
        lifetimeByTier.find((r) => r.lifetimeTier === t)?._count._all ?? 0,
      ])
    ),
    revenueThisMonth: Number(revenue._sum.total ?? 0),
    paidInvoicesThisMonth: revenue._count._all,
  };
}

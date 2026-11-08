import {
  NotificationAudience,
  NotificationType,
  Plan,
  Prisma,
  type Invoice,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { planToApi, tierRank, type PlanIdApi } from "../lib/plan-mapping";
import { createNotification } from "../services/notifications.service";
import {
  getCatalog,
  invalidateCatalogCache,
  LIFETIME_MONTHS,
  type CatalogPlan,
  type CatalogPrice,
} from "./catalog.service";
import {
  BILLING_WORKSPACE_SELECT,
  invalidateEntitlements,
  resolvePlan,
  workspaceHasPlatformAdmin,
} from "./entitlements.service";

const DAY_MS = 24 * 60 * 60 * 1000;
export const INVOICE_CURRENCY = "BDT";

export type InvoiceKind = "new" | "renewal" | "upgrade";

export type Quote = {
  planId: PlanIdApi;
  planName: string;
  tier: Plan;
  months: number;
  isLifetime: boolean;
  kind: InvoiceKind;
  subtotal: number;
  credit: number;
  total: number;
  currency: string;
  amountUsd: number | null;
  /** Human description of what the payment buys. */
  description: string;
  /** When the purchased period would start and end if paid now (null end = lifetime). */
  periodStart: string;
  periodEnd: string | null;
  /** Extra days granted when upgrade credit exceeds the price. */
  bonusDays: number;
  price: CatalogPrice;
};

/** Credit above the price, converted to time at the new plan's daily rate. */
function bonusPeriodMs(subtotal: number, credit: number, start: Date, end: Date): number {
  const excess = credit - subtotal;
  if (excess <= 0 || subtotal <= 0) return 0;
  return Math.floor((excess / subtotal) * (end.getTime() - start.getTime()));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Adds calendar months, clamping to the last day of the target month (Jan 31 + 1 = Feb 28/29). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export function cycleLabel(months: number): string {
  if (months === LIFETIME_MONTHS) return "Lifetime";
  if (months === 1) return "1 month";
  if (months === 12) return "1 year";
  if (months % 12 === 0) return `${months / 12} years`;
  return `${months} months`;
}

async function loadWorkspace(workspaceId: string) {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ...BILLING_WORKSPACE_SELECT, id: true, name: true },
  });
  if (!ws) throw new AppError(404, "Workspace not found", "NOT_FOUND");
  return ws;
}

function findPlanAndPrice(
  plans: CatalogPlan[],
  tier: Plan,
  months: number
): { plan: CatalogPlan; price: CatalogPrice } {
  const plan = plans.find((p) => p.tier === tier);
  const price = plan?.prices.find((p) => p.months === months);
  if (!plan || !price || !price.isActive) {
    throw new AppError(404, "This plan or billing cycle is not available.", "PRICE_NOT_FOUND");
  }
  if (!price.available) {
    const soldOut = price.remaining === 0;
    throw new AppError(
      409,
      soldOut
        ? `The ${plan.name} ${cycleLabel(months).toLowerCase()} offer is sold out.`
        : `The ${plan.name} ${cycleLabel(months).toLowerCase()} offer has ended.`,
      soldOut ? "PRICE_SOLD_OUT" : "PRICE_ENDED"
    );
  }
  return { plan, price };
}

/**
 * Unused value of the timed periods still running for a tier, based on what was paid.
 * Renewals stack, so every paid invoice that has not fully elapsed contributes its unused share.
 */
async function remainingTimedCredit(workspaceId: string, tier: Plan, now: Date): Promise<number> {
  const invoices = await prisma.invoice.findMany({
    where: {
      workspaceId,
      status: "paid",
      tier,
      months: { gt: 0 },
      periodEnd: { gt: now },
    },
    select: { subtotal: true, periodStart: true, periodEnd: true },
  });
  let credit = 0;
  for (const inv of invoices) {
    if (!inv.periodStart || !inv.periodEnd) continue;
    const totalMs = inv.periodEnd.getTime() - inv.periodStart.getTime();
    if (totalMs <= 0) continue;
    const unusedMs = inv.periodEnd.getTime() - Math.max(now.getTime(), inv.periodStart.getTime());
    const share = Math.min(1, Math.max(0, unusedMs / totalMs));
    credit += Number(inv.subtotal) * share;
  }
  return round2(credit);
}

/** What the workspace paid for the lifetime tier it currently owns. */
async function lifetimeCredit(workspaceId: string, tier: Plan): Promise<number> {
  const inv = await prisma.invoice.findFirst({
    where: { workspaceId, status: "paid", tier, months: LIFETIME_MONTHS },
    orderBy: { paidAt: "desc" },
  });
  return inv ? Number(inv.subtotal) : 0;
}

/**
 * Prices a purchase for this workspace, applying upgrade credit and blocking
 * combinations that make no sense (downgrades mid-period, buying what a lifetime already covers).
 */
export async function quotePurchase(
  workspaceId: string,
  tier: Plan,
  months: number,
  now = new Date()
): Promise<Quote> {
  if (tier === Plan.FREE) {
    throw new AppError(400, "The Free plan does not need a payment.", "VALIDATION");
  }
  if (await workspaceHasPlatformAdmin(workspaceId)) {
    throw new AppError(400, "Platform admin workspaces already have full access.", "ADMIN_WORKSPACE");
  }
  const [catalog, ws] = await Promise.all([getCatalog(), loadWorkspace(workspaceId)]);
  const { plan, price } = findPlanAndPrice(catalog.plans, tier, months);
  const resolved = resolvePlan(ws, catalog.settings, false, now);
  const lifetime = ws.lifetimeTier && ws.lifetimeTier !== Plan.FREE ? ws.lifetimeTier : null;
  const timedTier =
    (resolved.source === "paid" || resolved.source === "grace") && resolved.periodEnd
      ? ws.plan
      : null;
  const isLifetime = months === LIFETIME_MONTHS;
  const planName = plan.name;

  let kind: InvoiceKind = "new";
  let credit = 0;
  let periodStart = now;

  if (isLifetime) {
    if (lifetime && tierRank(tier) <= tierRank(lifetime)) {
      throw new AppError(
        409,
        `You already own ${catalog.plans.find((p) => p.tier === lifetime)?.name ?? planToApi(lifetime)} for life.`,
        "ALREADY_OWNED"
      );
    }
    if (lifetime) {
      kind = "upgrade";
      credit += await lifetimeCredit(workspaceId, lifetime);
    }
    if (timedTier && tierRank(tier) >= tierRank(timedTier)) {
      kind = "upgrade";
      credit += await remainingTimedCredit(workspaceId, timedTier, now);
    }
  } else {
    if (lifetime && tierRank(tier) <= tierRank(lifetime)) {
      throw new AppError(
        409,
        `Your lifetime ${catalog.plans.find((p) => p.tier === lifetime)?.name ?? ""} plan already covers this.`,
        "ALREADY_OWNED"
      );
    }
    if (timedTier) {
      if (tier === timedTier) {
        kind = "renewal";
        if (resolved.periodEnd && resolved.periodEnd.getTime() > now.getTime()) {
          periodStart = resolved.periodEnd;
        }
      } else if (tierRank(tier) > tierRank(timedTier)) {
        kind = "upgrade";
        credit = await remainingTimedCredit(workspaceId, timedTier, now);
      } else {
        const ends = resolved.periodEnd?.toISOString().slice(0, 10);
        throw new AppError(
          409,
          `You can switch to a lower plan after your current plan ends${ends ? ` on ${ends}` : ""}.`,
          "DOWNGRADE_NOT_ALLOWED",
          { periodEnd: resolved.periodEnd?.toISOString() ?? null }
        );
      }
    }
  }

  const subtotal = round2(price.amountBdt);
  // Lifetime has no time to extend, so credit is capped at the price there. For timed plans
  // any credit beyond the price becomes extra days on the new plan instead of being lost.
  credit = round2(isLifetime ? Math.min(credit, subtotal) : credit);
  const total = round2(Math.max(0, subtotal - credit));
  const baseEnd = isLifetime ? null : addMonths(periodStart, months);
  const bonusMs = baseEnd ? bonusPeriodMs(subtotal, credit, periodStart, baseEnd) : 0;
  const periodEnd = baseEnd ? new Date(baseEnd.getTime() + bonusMs) : null;
  const amountUsd =
    price.amountUsd !== null && subtotal > 0 ? round2((price.amountUsd * total) / subtotal) : null;

  return {
    planId: planToApi(tier),
    planName,
    tier,
    months,
    isLifetime,
    kind,
    subtotal,
    credit,
    total,
    currency: INVOICE_CURRENCY,
    amountUsd,
    description: `Waleado ${planName} — ${cycleLabel(months)}${
      kind === "renewal" ? " (renewal)" : kind === "upgrade" ? " (upgrade)" : ""
    }`,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd?.toISOString() ?? null,
    bonusDays: Math.floor(bonusMs / DAY_MS),
    price,
  };
}

async function nextInvoiceNumber(): Promise<string> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('invoice_number_seq') AS n`;
  const n = Number(rows[0]?.n ?? Date.now());
  return `WLD-${new Date().getUTCFullYear()}-${String(n).padStart(6, "0")}`;
}

/** Creates an unpaid invoice for a quote. Older unpaid invoices of the workspace are cancelled. */
export async function createInvoiceFromQuote(
  workspaceId: string,
  quote: Quote,
  gateway: string | null
): Promise<Invoice> {
  const number = await nextInvoiceNumber();
  return prisma.$transaction(async (tx) => {
    await tx.invoice.updateMany({
      where: { workspaceId, status: "unpaid" },
      data: { status: "cancelled" },
    });
    return tx.invoice.create({
      data: {
        number,
        workspaceId,
        tier: quote.tier,
        months: quote.months,
        kind: quote.kind,
        subtotal: quote.subtotal,
        credit: quote.credit,
        total: quote.total,
        currency: quote.currency,
        gateway,
        description: quote.description,
      },
    });
  });
}

/**
 * Marks an invoice paid (once) and applies it to the workspace:
 * - lifetime: owns the tier for life
 * - same tier still running: extends from the current end date (no days lost)
 * - otherwise: a new period starts now
 * Safe to call more than once; only the first call changes anything.
 */
export async function applyPaidInvoice(
  invoiceId: string,
  gateway: string | null
): Promise<{ applied: boolean; invoice: Invoice }> {
  const now = new Date();
  const result = await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.invoice.updateMany({
        where: { id: invoiceId, status: { in: ["unpaid", "cancelled"] } },
        data: { status: "paid", paidAt: now, ...(gateway ? { gateway } : {}) },
      });
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
      if (claimed.count === 0) {
        return { applied: false, invoice };
      }

      const ws = await tx.workspace.findUniqueOrThrow({
        where: { id: invoice.workspaceId },
        select: BILLING_WORKSPACE_SELECT,
      });

      let periodStart = now;
      let periodEnd: Date | null = null;
      const data: Prisma.WorkspaceUpdateInput = {
        subscriptionStatus: "active",
        lastPaymentGateway: gateway ?? invoice.gateway ?? null,
      };

      if (invoice.months === LIFETIME_MONTHS) {
        data.lifetimeTier = invoice.tier;
        const timedHigherStillRunning =
          ws.plan !== Plan.FREE &&
          tierRank(ws.plan) > tierRank(invoice.tier) &&
          ws.currentPeriodEnd !== null &&
          ws.currentPeriodEnd.getTime() > now.getTime();
        if (!timedHigherStillRunning) {
          data.plan = invoice.tier;
          data.currentPeriodEnd = null;
          data.billingMonths = LIFETIME_MONTHS;
        }
      } else {
        const sameTierRunning =
          ws.plan === invoice.tier &&
          ws.currentPeriodEnd !== null &&
          ws.currentPeriodEnd.getTime() > now.getTime();
        periodStart = sameTierRunning ? (ws.currentPeriodEnd as Date) : now;
        const baseEnd = addMonths(periodStart, invoice.months);
        periodEnd = new Date(
          baseEnd.getTime() +
            bonusPeriodMs(Number(invoice.subtotal), Number(invoice.credit), periodStart, baseEnd)
        );
        data.plan = invoice.tier;
        data.currentPeriodEnd = periodEnd;
        data.billingMonths = invoice.months;
      }

      await tx.workspace.update({ where: { id: invoice.workspaceId }, data });
      const updated = await tx.invoice.update({
        where: { id: invoice.id },
        data: { periodStart, periodEnd },
      });
      return { applied: true, invoice: updated };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  if (result.applied) {
    invalidateEntitlements(result.invoice.workspaceId);
    invalidateCatalogCache();
    void notifyInvoicePaid(result.invoice);
  }
  return result;
}

async function notifyInvoicePaid(invoice: Invoice): Promise<void> {
  try {
    const ws = await prisma.workspace.findUnique({
      where: { id: invoice.workspaceId },
      select: { name: true },
    });
    const amount = `${invoice.currency} ${Number(invoice.total).toFixed(2)}`;
    await createNotification({
      audience: NotificationAudience.ADMIN,
      type: NotificationType.PAYMENT_RECEIVED,
      title: `Payment Received: ${amount}`,
      message: `${invoice.description} paid by "${ws?.name ?? "Workspace"}" (Invoice ${invoice.number}).`,
      link: "/admin/payments",
      metadata: {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        amount: Number(invoice.total),
        currency: invoice.currency,
        gateway: invoice.gateway,
        planId: planToApi(invoice.tier),
        months: invoice.months,
        workspaceId: invoice.workspaceId,
      },
    });
    await createNotification({
      audience: NotificationAudience.CUSTOMER,
      workspaceId: invoice.workspaceId,
      type: NotificationType.PAYMENT_RECEIVED,
      title: "Payment confirmed",
      message: `${invoice.description} is active. Invoice ${invoice.number} — ${amount}.`,
      link: "/billing",
      metadata: { invoiceId: invoice.id, invoiceNumber: invoice.number },
    });
  } catch (e) {
    console.warn("[billing] invoice paid notification failed:", e);
  }
}

export function serializeInvoice(inv: Invoice) {
  return {
    id: inv.id,
    number: inv.number,
    planId: planToApi(inv.tier),
    months: inv.months,
    isLifetime: inv.months === LIFETIME_MONTHS,
    cycle: cycleLabel(inv.months),
    kind: inv.kind,
    subtotal: Number(inv.subtotal),
    credit: Number(inv.credit),
    total: Number(inv.total),
    currency: inv.currency,
    status: inv.status,
    gateway: inv.gateway,
    description: inv.description,
    periodStart: inv.periodStart?.toISOString() ?? null,
    periodEnd: inv.periodEnd?.toISOString() ?? null,
    paidAt: inv.paidAt?.toISOString() ?? null,
    createdAt: inv.createdAt.toISOString(),
  };
}

export async function listWorkspaceInvoices(workspaceId: string) {
  const rows = await prisma.invoice.findMany({
    where: { workspaceId, status: { not: "cancelled" } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map(serializeInvoice);
}

export async function getWorkspaceInvoice(workspaceId: string, invoiceId: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, workspaceId },
    include: {
      workspace: {
        select: {
          name: true,
          memberships: {
            where: { role: "OWNER" },
            take: 1,
            select: { user: { select: { name: true, email: true, phone: true } } },
          },
        },
      },
    },
  });
  if (!inv) throw new AppError(404, "Invoice not found", "NOT_FOUND");
  const owner = inv.workspace.memberships[0]?.user ?? null;
  return {
    ...serializeInvoice(inv),
    billedTo: {
      workspace: inv.workspace.name,
      name: owner?.name ?? null,
      email: owner?.email ?? null,
      phone: owner?.phone ?? null,
    },
  };
}

/**
 * Ends lapsed timed plans once their grace period is over. Workspaces that own a lifetime
 * tier fall back to it; others drop to Free. Stripe-managed subscriptions are left to webhooks.
 */
export async function expireLapsedPlans(now = new Date()): Promise<number> {
  const { settings } = await getCatalog();
  const cutoff = new Date(now.getTime() - Math.max(0, settings.graceDays) * DAY_MS);
  const rows = await prisma.workspace.findMany({
    where: {
      plan: { not: Plan.FREE },
      currentPeriodEnd: { lt: cutoff },
      stripeSubscriptionId: null,
    },
    select: { id: true, lifetimeTier: true },
  });
  for (const row of rows) {
    const fallback = row.lifetimeTier && row.lifetimeTier !== Plan.FREE ? row.lifetimeTier : null;
    await prisma.workspace.updateMany({
      where: { id: row.id, currentPeriodEnd: { lt: cutoff } },
      data: fallback
        ? { plan: fallback, currentPeriodEnd: null, billingMonths: LIFETIME_MONTHS, subscriptionStatus: "active" }
        : { plan: Plan.FREE, currentPeriodEnd: null, billingMonths: null, subscriptionStatus: "expired", lastPaymentGateway: null },
    });
    invalidateEntitlements(row.id);
  }
  return rows.length;
}

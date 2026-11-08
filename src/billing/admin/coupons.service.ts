import { CouponDiscountType, CouponDuration, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { apiPlanToDb, planToApi, PAID_PLAN_ID_VALUES } from "../../lib/plan-mapping";
import { normalizeCouponCode } from "../coupons/coupon.service";

export const couponInputSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(3)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, - or _ only"),
    description: z.string().trim().max(200).nullable().optional(),
    discountType: z.nativeEnum(CouponDiscountType),
    discountValue: z.coerce.number().positive().max(10_000_000),
    duration: z.nativeEnum(CouponDuration),
    planIds: z.array(z.enum(PAID_PLAN_ID_VALUES)).default([]),
    cycles: z.array(z.coerce.number().int().min(0).max(60)).default([]),
    maxRedemptions: z.coerce.number().int().min(1).nullable().optional(),
    perWorkspaceLimit: z.coerce.number().int().min(1).max(100).default(1),
    startsAt: z.string().datetime().nullable().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .refine((c) => c.discountType !== CouponDiscountType.PERCENT || c.discountValue <= 100, {
    message: "Percent discount cannot exceed 100",
    path: ["discountValue"],
  });

export type CouponInput = z.infer<typeof couponInputSchema>;

function toData(input: CouponInput) {
  return {
    code: normalizeCouponCode(input.code),
    description: input.description ?? null,
    discountType: input.discountType,
    discountValue: input.discountValue,
    duration: input.duration,
    tiers: input.planIds.map(apiPlanToDb),
    cycles: [...new Set(input.cycles)],
    maxRedemptions: input.maxRedemptions ?? null,
    perWorkspaceLimit: input.perWorkspaceLimit,
    startsAt: input.startsAt ? new Date(input.startsAt) : null,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    isActive: input.isActive,
  };
}

function rethrowDuplicate(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    throw new AppError(409, "A coupon with this code already exists.", "COUPON_EXISTS");
  }
  throw e;
}

export async function listCoupons() {
  const [coupons, usage] = await Promise.all([
    prisma.coupon.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.couponRedemption.groupBy({
      by: ["couponId"],
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);
  return coupons.map((c) => {
    const u = usage.find((x) => x.couponId === c.id);
    return {
      id: c.id,
      code: c.code,
      description: c.description,
      discountType: c.discountType,
      discountValue: Number(c.discountValue),
      duration: c.duration,
      planIds: c.tiers.map(planToApi),
      cycles: c.cycles,
      maxRedemptions: c.maxRedemptions,
      perWorkspaceLimit: c.perWorkspaceLimit,
      startsAt: c.startsAt?.toISOString() ?? null,
      expiresAt: c.expiresAt?.toISOString() ?? null,
      isActive: c.isActive,
      createdAt: c.createdAt.toISOString(),
      redemptions: u?._count._all ?? 0,
      totalDiscount: Number(u?._sum.amount ?? 0),
    };
  });
}

export async function createCoupon(input: CouponInput) {
  await prisma.coupon.create({ data: toData(input) }).catch(rethrowDuplicate);
}

export async function updateCoupon(id: string, input: CouponInput) {
  const exists = await prisma.coupon.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new AppError(404, "Coupon not found", "NOT_FOUND");
  await prisma.coupon.update({ where: { id }, data: toData(input) }).catch(rethrowDuplicate);
}

/** Used coupons are deactivated instead of deleted so invoices keep their history. */
export async function deleteCoupon(id: string) {
  const used = await prisma.couponRedemption.count({ where: { couponId: id } });
  if (used > 0) {
    await prisma.coupon.update({ where: { id }, data: { isActive: false } });
    return { deleted: false, deactivated: true };
  }
  await prisma.coupon.delete({ where: { id } });
  return { deleted: true, deactivated: false };
}

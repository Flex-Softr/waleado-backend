import Stripe from "stripe";
import { Plan } from "@prisma/client";
import { env } from "../../env";
import { AppError } from "../../lib/errors";

const productDefaultPriceCache = new Map<string, string>();

/** Presentment currencies where the amount is already in the smallest unit (no ×100). */
const STRIPE_ZERO_DECIMAL_CURRENCIES = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

const STRIPE_MONEY_MAJOR_REGEX = /^\d+(\.\d+)?$/;

/** Stripe Price object id (Checkout `line_items[].price`). */
export function isLikelyStripePriceId(value: string | undefined | null): boolean {
  const v = value?.trim();
  if (!v) return false;
  return /^price_[A-Za-z0-9]+$/.test(v);
}

/** Stripe Product id — we resolve `default_price` to a Price id for Checkout. */
export function isLikelyStripeProductId(value: string | undefined | null): boolean {
  const v = value?.trim();
  if (!v) return false;
  return /^prod_[A-Za-z0-9]+$/.test(v);
}

/** Major-unit decimal for Checkout `price_data` (e.g. `29`, `29.99`), not a Stripe id. */
export function isStripeMoneyMajorAmount(value: string | undefined | null): boolean {
  const v = value?.trim();
  if (!v || !STRIPE_MONEY_MAJOR_REGEX.test(v)) return false;
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0;
}

export function isStripeLineItemEnvReference(value: string | undefined | null): boolean {
  return (
    isLikelyStripePriceId(value) ||
    isLikelyStripeProductId(value) ||
    isStripeMoneyMajorAmount(value)
  );
}

function majorAmountToStripeUnitAmount(major: string, currency: string): number {
  const n = parseFloat(major.trim());
  const cur = currency.trim().toLowerCase();
  if (!Number.isFinite(n) || n <= 0) {
    throw new AppError(
      400,
      "Stripe amount must be a positive number (major currency units).",
      "INVALID_STRIPE_AMOUNT"
    );
  }
  if (STRIPE_ZERO_DECIMAL_CURRENCIES.has(cur)) {
    const u = Math.round(n);
    if (u < 1) {
      throw new AppError(400, "Stripe amount too small for this currency.", "INVALID_STRIPE_AMOUNT");
    }
    return u;
  }
  const minor = Math.round(n * 100);
  if (minor < 1) {
    throw new AppError(400, "Stripe amount too small for this currency.", "INVALID_STRIPE_AMOUNT");
  }
  return minor;
}

async function resolveProductToDefaultPriceId(
  stripe: Stripe,
  productId: string
): Promise<string> {
  const cached = productDefaultPriceCache.get(productId);
  if (cached) return cached;
  try {
    const product = await stripe.products.retrieve(productId, {
      expand: ["default_price"],
    });
    const dp = product.default_price;
    let priceId: string | null = null;
    if (typeof dp === "string") {
      priceId = dp;
    } else if (dp && typeof dp === "object" && "id" in dp) {
      const p = dp as Stripe.Price;
      if (!p.deleted) priceId = p.id;
    }
    if (!priceId) {
      throw new AppError(
        400,
        `Stripe product ${productId} has no default price. Set a default price on the product, or use a price_… id in .env instead of prod_….`,
        "PRODUCT_NO_DEFAULT_PRICE"
      );
    }
    productDefaultPriceCache.set(productId, priceId);
    return priceId;
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof Stripe.errors.StripeError) {
      throw new AppError(
        400,
        `${e.message} Use the same Stripe mode (test vs live) and account as STRIPE_SECRET_KEY; prod_/price_ ids must exist there.`,
        e.code ?? "STRIPE_ERROR"
      );
    }
    throw e;
  }
}

/**
 * Resolves `.env` to a Checkout line item: `price_…`, `prod_…` (default price), or major-unit amount
 * (`price_data`, monthly, `STRIPE_CURRENCY`).
 */
export async function resolveStripeCheckoutLineItem(
  stripe: Stripe,
  raw: string,
  envVarName: string,
  productDisplayName: string,
  currency: string
): Promise<Stripe.Checkout.SessionCreateParams.LineItem> {
  const v = raw.trim();
  if (isLikelyStripePriceId(v)) {
    return { price: v, quantity: 1 };
  }
  if (isLikelyStripeProductId(v)) {
    const priceId = await resolveProductToDefaultPriceId(stripe, v);
    return { price: priceId, quantity: 1 };
  }
  if (isStripeMoneyMajorAmount(v)) {
    const unitAmount = majorAmountToStripeUnitAmount(v, currency);
    const cur = currency.trim().toLowerCase();
    return {
      quantity: 1,
      price_data: {
        currency: cur,
        unit_amount: unitAmount,
        recurring: { interval: "month" },
        product_data: { name: productDisplayName },
      },
    };
  }
  throw new AppError(
    400,
    `${envVarName} must be a Stripe Price id (price_…), Product id (prod_…) with a default price, or a positive decimal amount (e.g. 29.99) with STRIPE_CURRENCY.`,
    "INVALID_STRIPE_LINE_REFERENCE"
  );
}

/** Maps subscription line item `price.id` to Pro/Business using env (price or product refs). */
export async function matchSubscriptionPriceToPlan(
  stripe: Stripe,
  itemPriceId: string
): Promise<Plan | null> {
  const pro = env.STRIPE_PRICE_PRO_MONTHLY?.trim();
  const biz = env.STRIPE_PRICE_BUSINESS_MONTHLY?.trim();
  if (!pro || !biz) return null;

  let proResolved: string | null = null;
  if (isLikelyStripeProductId(pro)) {
    proResolved = await resolveProductToDefaultPriceId(stripe, pro);
  } else if (isLikelyStripePriceId(pro)) {
    proResolved = pro;
  }

  let bizResolved: string | null = null;
  if (isLikelyStripeProductId(biz)) {
    bizResolved = await resolveProductToDefaultPriceId(stripe, biz);
  } else if (isLikelyStripePriceId(biz)) {
    bizResolved = biz;
  }

  if (proResolved && itemPriceId === proResolved) return Plan.PRO;
  if (bizResolved && itemPriceId === bizResolved) return Plan.BUSINESS;
  return null;
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isLikelyStripePriceId = isLikelyStripePriceId;
exports.isLikelyStripeProductId = isLikelyStripeProductId;
exports.isStripeMoneyMajorAmount = isStripeMoneyMajorAmount;
exports.isStripeLineItemEnvReference = isStripeLineItemEnvReference;
exports.resolveStripeCheckoutLineItem = resolveStripeCheckoutLineItem;
exports.matchSubscriptionPriceToPlan = matchSubscriptionPriceToPlan;
const stripe_1 = __importDefault(require("stripe"));
const client_1 = require("@prisma/client");
const env_1 = require("../../env");
const errors_1 = require("../../lib/errors");
const productDefaultPriceCache = new Map();
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
function isLikelyStripePriceId(value) {
    const v = value?.trim();
    if (!v)
        return false;
    return /^price_[A-Za-z0-9]+$/.test(v);
}
/** Stripe Product id — we resolve `default_price` to a Price id for Checkout. */
function isLikelyStripeProductId(value) {
    const v = value?.trim();
    if (!v)
        return false;
    return /^prod_[A-Za-z0-9]+$/.test(v);
}
/** Major-unit decimal for Checkout `price_data` (e.g. `29`, `29.99`), not a Stripe id. */
function isStripeMoneyMajorAmount(value) {
    const v = value?.trim();
    if (!v || !STRIPE_MONEY_MAJOR_REGEX.test(v))
        return false;
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0;
}
function isStripeLineItemEnvReference(value) {
    return (isLikelyStripePriceId(value) ||
        isLikelyStripeProductId(value) ||
        isStripeMoneyMajorAmount(value));
}
function majorAmountToStripeUnitAmount(major, currency) {
    const n = parseFloat(major.trim());
    const cur = currency.trim().toLowerCase();
    if (!Number.isFinite(n) || n <= 0) {
        throw new errors_1.AppError(400, "Stripe amount must be a positive number (major currency units).", "INVALID_STRIPE_AMOUNT");
    }
    if (STRIPE_ZERO_DECIMAL_CURRENCIES.has(cur)) {
        const u = Math.round(n);
        if (u < 1) {
            throw new errors_1.AppError(400, "Stripe amount too small for this currency.", "INVALID_STRIPE_AMOUNT");
        }
        return u;
    }
    const minor = Math.round(n * 100);
    if (minor < 1) {
        throw new errors_1.AppError(400, "Stripe amount too small for this currency.", "INVALID_STRIPE_AMOUNT");
    }
    return minor;
}
async function resolveProductToDefaultPriceId(stripe, productId) {
    const cached = productDefaultPriceCache.get(productId);
    if (cached)
        return cached;
    try {
        const product = await stripe.products.retrieve(productId, {
            expand: ["default_price"],
        });
        const dp = product.default_price;
        let priceId = null;
        if (typeof dp === "string") {
            priceId = dp;
        }
        else if (dp && typeof dp === "object" && "id" in dp) {
            const p = dp;
            if (!p.deleted)
                priceId = p.id;
        }
        if (!priceId) {
            throw new errors_1.AppError(400, `Stripe product ${productId} has no default price. Set a default price on the product, or use a price_… id in .env instead of prod_….`, "PRODUCT_NO_DEFAULT_PRICE");
        }
        productDefaultPriceCache.set(productId, priceId);
        return priceId;
    }
    catch (e) {
        if (e instanceof errors_1.AppError)
            throw e;
        if (e instanceof stripe_1.default.errors.StripeError) {
            throw new errors_1.AppError(400, `${e.message} Use the same Stripe mode (test vs live) and account as STRIPE_SECRET_KEY; prod_/price_ ids must exist there.`, e.code ?? "STRIPE_ERROR");
        }
        throw e;
    }
}
/**
 * Resolves `.env` to a Checkout line item: `price_…`, `prod_…` (default price), or major-unit amount
 * (`price_data`, monthly, `STRIPE_CURRENCY`).
 */
async function resolveStripeCheckoutLineItem(stripe, raw, envVarName, productDisplayName, currency) {
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
    throw new errors_1.AppError(400, `${envVarName} must be a Stripe Price id (price_…), Product id (prod_…) with a default price, or a positive decimal amount (e.g. 29.99) with STRIPE_CURRENCY.`, "INVALID_STRIPE_LINE_REFERENCE");
}
/** Maps subscription line item `price.id` to Pro/Business using env (price or product refs). */
async function matchSubscriptionPriceToPlan(stripe, itemPriceId) {
    const pro = env_1.env.STRIPE_PRICE_PRO_MONTHLY?.trim();
    const biz = env_1.env.STRIPE_PRICE_BUSINESS_MONTHLY?.trim();
    if (!pro || !biz)
        return null;
    let proResolved = null;
    if (isLikelyStripeProductId(pro)) {
        proResolved = await resolveProductToDefaultPriceId(stripe, pro);
    }
    else if (isLikelyStripePriceId(pro)) {
        proResolved = pro;
    }
    let bizResolved = null;
    if (isLikelyStripeProductId(biz)) {
        bizResolved = await resolveProductToDefaultPriceId(stripe, biz);
    }
    else if (isLikelyStripePriceId(biz)) {
        bizResolved = biz;
    }
    if (proResolved && itemPriceId === proResolved)
        return client_1.Plan.PRO;
    if (bizResolved && itemPriceId === bizResolved)
        return client_1.Plan.BUSINESS;
    return null;
}

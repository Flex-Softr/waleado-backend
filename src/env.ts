import path from "path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { normalizeDatabaseUrl } from "./lib/normalize-database-url";

const repoRoot = path.resolve(__dirname, "../..");
const serverDir = path.resolve(__dirname, "..");

// Repo root: `.env` then `.env.local` (Next.js-style; local overrides). `server/.env` only fills keys still unset.
loadDotenv({ path: path.join(repoRoot, ".env") });
loadDotenv({ path: path.join(repoRoot, ".env.local"), override: true });
loadDotenv({ path: path.join(serverDir, ".env") });

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().default(4000),
  /** Max JSON body size (e.g. contact bulk import). Default 2mb — 256kb is too small for 2k lines. */
  HTTP_JSON_BODY_LIMIT: z.string().default("2mb"),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 chars"),
  JWT_ACCESS_EXPIRES_IN: z.string().default("15m"),
  REFRESH_TOKEN_DAYS: z.coerce.number().min(1).max(90).default(7),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  COOKIE_SAME_SITE: z.enum(["strict", "lax", "none"]).default("lax"),
  TRUST_PROXY: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  /** Base URL of the Next.js app (success/cancel redirects, no trailing slash) */
  APP_PUBLIC_URL: z.string().default("http://localhost:3000"),
  /**
   * Public base URL of this API (no trailing slash). Used for SSLCommerz success/fail/cancel/IPN
   * callbacks — must be reachable from the internet in production.
   */
  API_PUBLIC_URL: z.string().default("http://localhost:4000"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /**
   * Monthly subscription line: Stripe `price_…` / `prod_…` (default price), or a positive decimal
   * major amount (e.g. `29` or `29.99`) with `STRIPE_CURRENCY` (Checkout `price_data`, monthly).
   */
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),
  STRIPE_PRICE_BUSINESS_MONTHLY: z.string().optional(),
  /**
   * ISO currency for digit `STRIPE_PRICE_*` values (minor units: ×100 except [zero-decimal](https://stripe.com/docs/currencies#presentment-currencies)).
   */
  STRIPE_CURRENCY: z
    .string()
    .default("usd")
    .transform((s) => s.trim().toLowerCase() || "usd"),
  /** SSLCommerz store credentials (sandbox vs live controlled by SSLCOMMERZ_SANDBOX). */
  SSLCOMMERZ_STORE_ID: z.string().optional(),
  SSLCOMMERZ_STORE_PASSWORD: z.string().optional(),
  SSLCOMMERZ_SANDBOX: z.preprocess((v: unknown) => {
    if (v === undefined || v === "" || v === null) return true;
    const s = String(v).trim().toLowerCase();
    return s !== "false" && s !== "0" && s !== "no" && s !== "off";
  }, z.boolean()),
  /** List prices for Pro/Business (interpreted as USD when CONVERSION_RATE_USD_TO_BDT is set; otherwise in SSLCOMMERZ_CURRENCY). */
  SSLCOMMERZ_PRO_AMOUNT: z.string().default("29.00"),
  SSLCOMMERZ_BUSINESS_AMOUNT: z.string().default("79.00"),
  SSLCOMMERZ_CURRENCY: z.string().default("USD"),
  /**
   * When set, SSLCOMMERZ_*_AMOUNT values are treated as USD, multiplied by this rate,
   * and SSLCommerz receives BDT (your fixed taka pricing, e.g. 29 × 120 = 3480 BDT).
   * When unset, amounts are charged as-is in SSLCOMMERZ_CURRENCY (USD with no rate → gateway may show its own BDT estimate).
   * Also reads CONVERTION_RATE_USD_TO_BDT when this key is empty.
   */
  CONVERSION_RATE_USD_TO_BDT: z.preprocess((v: unknown) => {
    if (v !== undefined && v !== "" && v !== null) return v;
    const typo = process.env.CONVERTION_RATE_USD_TO_BDT;
    if (typo !== undefined && typo !== "" && typo !== null) return typo;
    return undefined;
  }, z.coerce.number().positive().optional()),
  /** Absolute or repo-relative folder for Baileys auth files (default: `<repo>/.wa-sessions`) */
  WA_SESSIONS_DIR: z.string().optional(),
  /**
   * Baileys / real QR + sending. Must be a real boolean after parse — if this were ever
   * `undefined`, `!env.WHATSAPP_BRIDGE_ENABLED` would wrongly skip sending.
   */
  WHATSAPP_BRIDGE_ENABLED: z.preprocess((v: unknown) => {
    if (v === undefined || v === "" || v === null) return true;
    const s = String(v).trim().toLowerCase();
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
    return true;
  }, z.boolean()),
  /** Directory for uploaded template images/docs (default: `<repo>/uploads/template-media`). */
  TEMPLATE_MEDIA_ROOT: z
    .string()
    .optional()
    .transform((v) => {
      const raw = v?.trim();
      if (raw) return path.resolve(raw);
      return path.join(repoRoot, "uploads", "template-media");
    }),
  /** ISO 3166-1 alpha-2 (e.g. US, SA). Helps parse local numbers missing +country. */
  PHONE_DEFAULT_REGION: z
    .string()
    .optional()
    .transform((s) => {
      const t = s?.trim().toUpperCase();
      return t && t.length === 2 ? t : undefined;
    }),
  /**
   * Comma-separated emails that see admin overview in **platform** scope (DB-wide).
   * Other authenticated workspace admins see metrics for their JWT workspace only.
   */
  PLATFORM_OPERATOR_EMAILS: z.string().optional(),
  /** Google OAuth2 (authorization code flow). Both required when enabling “Continue with Google”. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /**
   * Must match an authorized redirect URI in Google Cloud Console (no trailing slash).
   * Defaults to `${API_PUBLIC_URL}/v1/auth/google/callback`.
   */
  GOOGLE_OAUTH_REDIRECT_URI: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
    console.error(
      "Set variables in the repo root `.env` or `.env.local` (recommended for secrets). If you still use `server/.env`, it is applied only for keys not already set."
    );
    throw new Error("Invalid environment configuration");
  }
  const data = parsed.data;
  const dbUrl = normalizeDatabaseUrl(data.DATABASE_URL);
  if (dbUrl !== data.DATABASE_URL) {
    process.env.DATABASE_URL = dbUrl;
  }
  return { ...data, DATABASE_URL: dbUrl };
}

export const env = loadEnv();

export function isGoogleOAuthConfigured(): boolean {
  const id = env.GOOGLE_CLIENT_ID?.trim();
  const secret = env.GOOGLE_CLIENT_SECRET?.trim();
  return Boolean(id && secret);
}

export function getGoogleOAuthRedirectUri(): string {
  const raw = env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return `${env.API_PUBLIC_URL.replace(/\/$/, "")}/v1/auth/google/callback`;
}

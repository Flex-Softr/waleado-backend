"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const path_1 = __importDefault(require("path"));
const dotenv_1 = require("dotenv");
const zod_1 = require("zod");
const normalize_database_url_1 = require("./lib/normalize-database-url");
const repoRoot = path_1.default.resolve(__dirname, "../..");
const serverDir = path_1.default.resolve(__dirname, "..");
// Repo root: `.env` then `.env.local` (Next.js-style; local overrides). `server/.env` only fills keys still unset.
(0, dotenv_1.config)({ path: path_1.default.join(repoRoot, ".env") });
(0, dotenv_1.config)({ path: path_1.default.join(repoRoot, ".env.local"), override: true });
(0, dotenv_1.config)({ path: path_1.default.join(serverDir, ".env") });
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z
        .enum(["development", "production", "test"])
        .default("development"),
    PORT: zod_1.z.coerce.number().default(4000),
    /** Max JSON body size (e.g. contact bulk import). Default 2mb — 256kb is too small for 2k lines. */
    HTTP_JSON_BODY_LIMIT: zod_1.z.string().default("2mb"),
    DATABASE_URL: zod_1.z.string().min(1),
    JWT_ACCESS_SECRET: zod_1.z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 chars"),
    JWT_ACCESS_EXPIRES_IN: zod_1.z.string().default("15m"),
    REFRESH_TOKEN_DAYS: zod_1.z.coerce.number().min(1).max(90).default(7),
    CORS_ORIGIN: zod_1.z.string().default("http://localhost:3000"),
    COOKIE_SECURE: zod_1.z
        .enum(["true", "false"])
        .optional()
        .transform((v) => v === "true"),
    COOKIE_SAME_SITE: zod_1.z.enum(["strict", "lax", "none"]).default("lax"),
    TRUST_PROXY: zod_1.z
        .enum(["true", "false"])
        .optional()
        .transform((v) => v === "true"),
    /** Base URL of the Next.js app (success/cancel redirects, no trailing slash) */
    APP_PUBLIC_URL: zod_1.z.string().default("http://localhost:3000"),
    /**
     * Public base URL of this API (no trailing slash). Used for SSLCommerz success/fail/cancel/IPN
     * callbacks — must be reachable from the internet in production.
     */
    API_PUBLIC_URL: zod_1.z.string().default("http://localhost:4000"),
    STRIPE_SECRET_KEY: zod_1.z.string().optional(),
    STRIPE_WEBHOOK_SECRET: zod_1.z.string().optional(),
    STRIPE_PRICE_PRO_MONTHLY: zod_1.z.string().optional(),
    STRIPE_PRICE_BUSINESS_MONTHLY: zod_1.z.string().optional(),
    /** SSLCommerz store credentials (sandbox vs live controlled by SSLCOMMERZ_SANDBOX). */
    SSLCOMMERZ_STORE_ID: zod_1.z.string().optional(),
    SSLCOMMERZ_STORE_PASSWORD: zod_1.z.string().optional(),
    SSLCOMMERZ_SANDBOX: zod_1.z.preprocess((v) => {
        if (v === undefined || v === "" || v === null)
            return true;
        const s = String(v).trim().toLowerCase();
        return s !== "false" && s !== "0" && s !== "no" && s !== "off";
    }, zod_1.z.boolean()),
    /** Charge amounts for plan upgrades (same currency as SSLCOMMERZ_CURRENCY). */
    SSLCOMMERZ_PRO_AMOUNT: zod_1.z.string().default("29.00"),
    SSLCOMMERZ_BUSINESS_AMOUNT: zod_1.z.string().default("79.00"),
    SSLCOMMERZ_CURRENCY: zod_1.z.string().default("USD"),
    /** Absolute or repo-relative folder for Baileys auth files (default: `<repo>/.wa-sessions`) */
    WA_SESSIONS_DIR: zod_1.z.string().optional(),
    /**
     * Baileys / real QR + sending. Must be a real boolean after parse — if this were ever
     * `undefined`, `!env.WHATSAPP_BRIDGE_ENABLED` would wrongly skip sending.
     */
    WHATSAPP_BRIDGE_ENABLED: zod_1.z.preprocess((v) => {
        if (v === undefined || v === "" || v === null)
            return true;
        const s = String(v).trim().toLowerCase();
        if (s === "false" || s === "0" || s === "no" || s === "off")
            return false;
        return true;
    }, zod_1.z.boolean()),
    /** Directory for uploaded template images/docs (default: `<repo>/uploads/template-media`). */
    TEMPLATE_MEDIA_ROOT: zod_1.z
        .string()
        .optional()
        .transform((v) => {
        const raw = v?.trim();
        if (raw)
            return path_1.default.resolve(raw);
        return path_1.default.join(repoRoot, "uploads", "template-media");
    }),
    /** ISO 3166-1 alpha-2 (e.g. US, SA). Helps parse local numbers missing +country. */
    PHONE_DEFAULT_REGION: zod_1.z
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
    PLATFORM_OPERATOR_EMAILS: zod_1.z.string().optional(),
});
function loadEnv() {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
        console.error("Set variables in the repo root `.env` or `.env.local` (recommended for secrets). If you still use `server/.env`, it is applied only for keys not already set.");
        throw new Error("Invalid environment configuration");
    }
    const data = parsed.data;
    const dbUrl = (0, normalize_database_url_1.normalizeDatabaseUrl)(data.DATABASE_URL);
    if (dbUrl !== data.DATABASE_URL) {
        process.env.DATABASE_URL = dbUrl;
    }
    return { ...data, DATABASE_URL: dbUrl };
}
exports.env = loadEnv();

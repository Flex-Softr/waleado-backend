import type { AiProvider } from "@prisma/client";

export type AiModelTier = "free" | "paid";

export type AiModelCatalogEntry = {
  id: string;
  provider: AiProvider;
  label: string;
  tier: AiModelTier;
  /** Provider model string sent to the API */
  modelId: string;
};

export const AI_PROVIDERS: {
  id: AiProvider;
  label: string;
  baseUrl: string;
}[] = [
  {
    id: "GEMINI",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  {
    id: "OPENROUTER",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
];

export const DEPRECATED_GEMINI_MODEL_ALIASES: Record<string, string> = {
  "gemini-flash-latest": "gemini-1.5-flash",
  "gemini-flash-lite-latest": "gemini-1.5-flash-8b",
  "gemini-pro-latest": "gemini-1.5-pro",
  "gemini-3.5-flash": "gemini-2.5-flash",
  "gemini-3.5-flash-lite": "gemini-2.0-flash-lite",
  "gemini-3.6-flash": "gemini-2.5-flash",
  "gemini-3.7-flash": "gemini-2.5-flash",
  "gemini-3.1-pro-preview": "gemini-2.5-pro",
};

/** Curated accepted models for UI selects (free + paid). */
export const AI_MODEL_CATALOG: AiModelCatalogEntry[] = [
  // Gemini — free-tier friendly
  {
    id: "gemini-2.5-flash",
    provider: "GEMINI",
    label: "Gemini 2.5 Flash",
    tier: "free",
    modelId: "gemini-2.5-flash",
  },
  {
    id: "gemini-2.0-flash",
    provider: "GEMINI",
    label: "Gemini 2.0 Flash",
    tier: "free",
    modelId: "gemini-2.0-flash",
  },
  {
    id: "gemini-2.0-flash-lite",
    provider: "GEMINI",
    label: "Gemini 2.0 Flash Lite",
    tier: "free",
    modelId: "gemini-2.0-flash-lite",
  },
  {
    id: "gemini-1.5-flash",
    provider: "GEMINI",
    label: "Gemini 1.5 Flash",
    tier: "free",
    modelId: "gemini-1.5-flash",
  },
  {
    id: "gemini-1.5-flash-8b",
    provider: "GEMINI",
    label: "Gemini 1.5 Flash 8B",
    tier: "free",
    modelId: "gemini-1.5-flash-8b",
  },
  // Gemini — paid / advanced
  {
    id: "gemini-2.5-pro",
    provider: "GEMINI",
    label: "Gemini 2.5 Pro",
    tier: "paid",
    modelId: "gemini-2.5-pro",
  },
  {
    id: "gemini-1.5-pro",
    provider: "GEMINI",
    label: "Gemini 1.5 Pro",
    tier: "paid",
    modelId: "gemini-1.5-pro",
  },
  // OpenRouter — free
  {
    id: "openrouter-gemini-2.0-flash-exp-free",
    provider: "OPENROUTER",
    label: "Gemini 2.0 Flash Exp (free)",
    tier: "free",
    modelId: "google/gemini-2.0-flash-exp:free",
  },
  {
    id: "openrouter-llama-3.3-70b-free",
    provider: "OPENROUTER",
    label: "Llama 3.3 70B (free)",
    tier: "free",
    modelId: "meta-llama/llama-3.3-70b-instruct:free",
  },
  {
    id: "openrouter-deepseek-r1-free",
    provider: "OPENROUTER",
    label: "DeepSeek R1 (free)",
    tier: "free",
    modelId: "deepseek/deepseek-r1:free",
  },
  {
    id: "openrouter-qwen-2.5-72b-free",
    provider: "OPENROUTER",
    label: "Qwen 2.5 72B (free)",
    tier: "free",
    modelId: "qwen/qwen-2.5-72b-instruct:free",
  },
  // OpenRouter — paid
  {
    id: "openrouter-gpt-4o-mini",
    provider: "OPENROUTER",
    label: "GPT-4o Mini",
    tier: "paid",
    modelId: "openai/gpt-4o-mini",
  },
  {
    id: "openrouter-gpt-4o",
    provider: "OPENROUTER",
    label: "GPT-4o",
    tier: "paid",
    modelId: "openai/gpt-4o",
  },
  {
    id: "openrouter-claude-3-5-sonnet",
    provider: "OPENROUTER",
    label: "Claude 3.5 Sonnet",
    tier: "paid",
    modelId: "anthropic/claude-3.5-sonnet",
  },
  {
    id: "openrouter-claude-3-7-sonnet",
    provider: "OPENROUTER",
    label: "Claude 3.7 Sonnet",
    tier: "paid",
    modelId: "anthropic/claude-3.7-sonnet",
  },
  {
    id: "openrouter-gemini-2.5-pro",
    provider: "OPENROUTER",
    label: "Gemini 2.5 Pro",
    tier: "paid",
    modelId: "google/gemini-2.5-pro",
  },
  {
    id: "openrouter-gemini-2.5-flash",
    provider: "OPENROUTER",
    label: "Gemini 2.5 Flash",
    tier: "paid",
    modelId: "google/gemini-2.5-flash",
  },
];

export function getProviderBaseUrl(provider: AiProvider): string {
  const row = AI_PROVIDERS.find((p) => p.id === provider);
  if (!row) {
    throw new Error(`Unknown AI provider: ${provider}`);
  }
  return row.baseUrl;
}

/**
 * Normalize a stored/custom endpoint into an OpenAI-compatible chat base URL
 * (no trailing slash; Gemini native `/v1beta` → `/v1beta/openai`).
 */
export function normalizeOpenAiCompatibleBaseUrl(
  provider: AiProvider,
  endpoint: string | null | undefined
): string {
  let base = (endpoint?.trim() || getProviderBaseUrl(provider)).replace(
    /\/$/,
    ""
  );

  if (provider === "GEMINI") {
    // Users often paste the native Gemini root without the OpenAI-compat suffix.
    if (
      /^https:\/\/generativelanguage\.googleapis\.com\/v1beta$/i.test(base) ||
      /^https:\/\/generativelanguage\.googleapis\.com\/v1$/i.test(base)
    ) {
      base = `${base}/openai`;
    }
  }

  return base;
}

export function listCatalogModels(opts?: {
  provider?: AiProvider;
  tier?: AiModelTier;
}): AiModelCatalogEntry[] {
  return AI_MODEL_CATALOG.filter((m) => {
    if (opts?.provider && m.provider !== opts.provider) return false;
    if (opts?.tier && m.tier !== opts.tier) return false;
    return true;
  });
}

/**
 * Resolve a catalog id or raw provider modelId for a provider.
 * Returns the API model string, or null if not allowed.
 */
export function resolveCatalogModelId(
  provider: AiProvider,
  modelOrCatalogId: string
): string | null {
  let raw = modelOrCatalogId.trim();
  if (!raw) return null;
  if (provider === "GEMINI" && DEPRECATED_GEMINI_MODEL_ALIASES[raw]) {
    raw = DEPRECATED_GEMINI_MODEL_ALIASES[raw];
  }
  const byId = AI_MODEL_CATALOG.find(
    (m) => m.provider === provider && m.id === raw
  );
  if (byId) return byId.modelId;
  const byModelId = AI_MODEL_CATALOG.find(
    (m) => m.provider === provider && m.modelId === raw
  );
  if (byModelId) return byModelId.modelId;
  if (
    provider === "GEMINI" &&
    (raw.startsWith("gemini-") || raw.startsWith("models/gemini-"))
  ) {
    return raw.replace(/^models\//, "");
  }
  if (provider === "OPENROUTER" && raw.length > 0) {
    return raw;
  }
  return null;
}

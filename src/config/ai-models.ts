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
  "gemini-2.5-flash-lite": "gemini-flash-lite-latest",
  "gemini-2.5-flash": "gemini-flash-latest",
  "gemini-2.0-flash": "gemini-flash-latest",
  "gemini-2.0-flash-lite": "gemini-flash-lite-latest",
  "gemini-1.5-flash": "gemini-flash-latest",
  "gemini-1.5-flash-8b": "gemini-flash-lite-latest",
  "gemini-1.5-pro": "gemini-pro-latest",
  "gemini-2.5-pro": "gemini-pro-latest",
};

/** Curated accepted models for UI selects (free + paid). */
export const AI_MODEL_CATALOG: AiModelCatalogEntry[] = [
  // Gemini — free-tier friendly
  {
    id: "gemini-flash-latest",
    provider: "GEMINI",
    label: "Gemini Flash (latest)",
    tier: "free",
    modelId: "gemini-flash-latest",
  },
  {
    id: "gemini-flash-lite-latest",
    provider: "GEMINI",
    label: "Gemini Flash Lite (latest)",
    tier: "free",
    modelId: "gemini-flash-lite-latest",
  },
  {
    id: "gemini-3.5-flash",
    provider: "GEMINI",
    label: "Gemini 3.5 Flash",
    tier: "free",
    modelId: "gemini-3.5-flash",
  },
  {
    id: "gemini-3.5-flash-lite",
    provider: "GEMINI",
    label: "Gemini 3.5 Flash Lite",
    tier: "free",
    modelId: "gemini-3.5-flash-lite",
  },
  {
    id: "gemini-3.6-flash",
    provider: "GEMINI",
    label: "Gemini 3.6 Flash",
    tier: "free",
    modelId: "gemini-3.6-flash",
  },
  {
    id: "gemini-3.7-flash",
    provider: "GEMINI",
    label: "Gemini 3.7 Flash",
    tier: "free",
    modelId: "gemini-3.7-flash",
  },
  {
    id: "gemini-pro-latest",
    provider: "GEMINI",
    label: "Gemini Pro (latest)",
    tier: "paid",
    modelId: "gemini-pro-latest",
  },
  {
    id: "gemini-3.1-pro-preview",
    provider: "GEMINI",
    label: "Gemini 3.1 Pro Preview",
    tier: "paid",
    modelId: "gemini-3.1-pro-preview",
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
    id: "openrouter-claude-sonnet",
    provider: "OPENROUTER",
    label: "Claude Sonnet 4",
    tier: "paid",
    modelId: "anthropic/claude-sonnet-4",
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
  return null;
}

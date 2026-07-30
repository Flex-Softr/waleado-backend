import { AiProvider } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import {
  AI_MODEL_CATALOG,
  getProviderBaseUrl,
  normalizeOpenAiCompatibleBaseUrl,
  resolveCatalogModelId,
} from "../config/ai-models";

export type AiCredentialJson = {
  id: string;
  name: string;
  provider: "gemini" | "openrouter";
  apiKeyMasked: string;
  model: string;
  modelLabel: string | null;
  apiEndpoint: string | null;
  defaultApiEndpoint: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

function providerToApi(p: AiProvider): "gemini" | "openrouter" {
  return p === AiProvider.GEMINI ? "gemini" : "openrouter";
}

export function providerFromApi(s: string): AiProvider {
  const v = s.trim().toLowerCase();
  if (v === "gemini") return AiProvider.GEMINI;
  if (v === "openrouter") return AiProvider.OPENROUTER;
  throw new AppError(400, "Invalid provider", "VALIDATION");
}

export function maskApiKey(apiKey: string): string {
  const t = apiKey.trim();
  if (t.length <= 4) return "••••";
  return `••••${t.slice(-4)}`;
}

function catalogLabel(provider: AiProvider, model: string): string | null {
  const entry = AI_MODEL_CATALOG.find(
    (m) =>
      m.provider === provider &&
      (m.id === model || m.modelId === model)
  );
  return entry?.label ?? null;
}

/** Normalize and validate model; returns catalog id for storage. */
export function normalizeCredentialModel(
  provider: AiProvider,
  model: string
): string {
  const raw = model.trim();
  if (!raw) {
    throw new AppError(400, "Model is required", "VALIDATION");
  }
  const modelId = resolveCatalogModelId(provider, raw);
  if (!modelId) {
    throw new AppError(
      400,
      "Selected model is not allowed for this provider",
      "VALIDATION"
    );
  }
  const entry = AI_MODEL_CATALOG.find(
    (m) => m.provider === provider && m.modelId === modelId
  );
  return entry?.id ?? raw;
}

export function normalizeApiEndpoint(
  endpoint: string | undefined | null,
  provider?: AiProvider
): string | null {
  if (endpoint === undefined || endpoint === null) return null;
  const trimmed = endpoint.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new AppError(
      400,
      "API endpoint must start with http:// or https://",
      "VALIDATION"
    );
  }
  const cleaned = trimmed.replace(/\/$/, "");
  if (provider) {
    return normalizeOpenAiCompatibleBaseUrl(provider, cleaned);
  }
  // Gemini native root without OpenAI-compat path → append /openai
  if (
    /^https:\/\/generativelanguage\.googleapis\.com\/v1beta$/i.test(cleaned) ||
    /^https:\/\/generativelanguage\.googleapis\.com\/v1$/i.test(cleaned)
  ) {
    return `${cleaned}/openai`;
  }
  return cleaned;
}

function toJson(row: {
  id: string;
  name: string;
  provider: AiProvider;
  apiKey: string;
  model: string;
  apiEndpoint: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AiCredentialJson {
  return {
    id: row.id,
    name: row.name,
    provider: providerToApi(row.provider),
    apiKeyMasked: maskApiKey(row.apiKey),
    model: row.model,
    modelLabel: catalogLabel(row.provider, row.model),
    apiEndpoint: row.apiEndpoint,
    defaultApiEndpoint: getProviderBaseUrl(row.provider),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAiCredentials(
  workspaceId: string
): Promise<AiCredentialJson[]> {
  const rows = await prisma.aiCredential.findMany({
    where: { workspaceId },
    orderBy: [{ provider: "asc" }, { name: "asc" }],
  });
  return rows.map(toJson);
}

export async function createAiCredential(
  workspaceId: string,
  input: {
    name: string;
    provider: string;
    apiKey: string;
    model: string;
    apiEndpoint?: string | null;
  }
): Promise<AiCredentialJson> {
  const name = input.name.trim();
  const apiKey = input.apiKey.trim();
  if (!name) {
    throw new AppError(400, "Credential name is required", "VALIDATION");
  }
  if (!apiKey) {
    throw new AppError(400, "API key is required", "VALIDATION");
  }
  const provider = providerFromApi(input.provider);
  const model = normalizeCredentialModel(provider, input.model);
  const apiEndpoint = normalizeApiEndpoint(input.apiEndpoint, provider);

  const existing = await prisma.aiCredential.findFirst({
    where: { workspaceId, name },
  });
  if (existing) {
    throw new AppError(
      409,
      "A credential with this name already exists",
      "CONFLICT"
    );
  }

  const row = await prisma.aiCredential.create({
    data: {
      workspaceId,
      name: name.slice(0, 200),
      provider,
      apiKey,
      model,
      apiEndpoint,
      active: true,
    },
  });
  return toJson(row);
}

export async function updateAiCredential(
  workspaceId: string,
  credentialId: string,
  input: {
    name?: string;
    apiKey?: string;
    model?: string;
    apiEndpoint?: string | null;
    active?: boolean;
  }
): Promise<AiCredentialJson> {
  const existing = await prisma.aiCredential.findFirst({
    where: { id: credentialId, workspaceId },
  });
  if (!existing) {
    throw new AppError(404, "Credential not found", "NOT_FOUND");
  }

  const data: {
    name?: string;
    apiKey?: string;
    model?: string;
    apiEndpoint?: string | null;
    active?: boolean;
  } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      throw new AppError(400, "Credential name is required", "VALIDATION");
    }
    const clash = await prisma.aiCredential.findFirst({
      where: {
        workspaceId,
        name,
        NOT: { id: credentialId },
      },
    });
    if (clash) {
      throw new AppError(
        409,
        "A credential with this name already exists",
        "CONFLICT"
      );
    }
    data.name = name.slice(0, 200);
  }
  if (input.apiKey !== undefined) {
    const apiKey = input.apiKey.trim();
    if (!apiKey) {
      throw new AppError(400, "API key is required", "VALIDATION");
    }
    data.apiKey = apiKey;
  }
  if (input.model !== undefined) {
    data.model = normalizeCredentialModel(existing.provider, input.model);
  }
  if (input.apiEndpoint !== undefined) {
    data.apiEndpoint = normalizeApiEndpoint(
      input.apiEndpoint,
      existing.provider
    );
  }
  if (input.active !== undefined) {
    data.active = input.active;
  }
  if (Object.keys(data).length === 0) {
    throw new AppError(400, "At least one field is required", "VALIDATION");
  }

  const row = await prisma.aiCredential.update({
    where: { id: credentialId },
    data,
  });
  return toJson(row);
}

export async function deleteAiCredential(
  workspaceId: string,
  credentialId: string
): Promise<void> {
  const existing = await prisma.aiCredential.findFirst({
    where: { id: credentialId, workspaceId },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError(404, "Credential not found", "NOT_FOUND");
  }

  const [rules, flows] = await Promise.all([
    prisma.autoReplyRule.findMany({
      where: { workspaceId, openAiEnabled: true },
      select: { id: true, openAiSettings: true },
    }),
    prisma.chatbotFlow.findMany({
      where: { workspaceId, aiEnabled: true },
      select: { id: true, aiSettings: true },
    }),
  ]);

  const referenced =
    rules.some((r) => settingsUsesCredential(r.openAiSettings, credentialId)) ||
    flows.some((f) => settingsUsesCredential(f.aiSettings, credentialId));

  if (referenced) {
    throw new AppError(
      409,
      "Credential is used by an auto-reply rule or chatbot flow",
      "CONFLICT"
    );
  }

  await prisma.aiCredential.delete({ where: { id: credentialId } });
}

function settingsUsesCredential(
  settings: unknown,
  credentialId: string
): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return false;
  }
  const id = (settings as { credentialId?: unknown }).credentialId;
  return typeof id === "string" && id === credentialId;
}

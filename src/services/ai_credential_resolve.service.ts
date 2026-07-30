import type { AiProvider } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import {
  normalizeOpenAiCompatibleBaseUrl,
  resolveCatalogModelId,
} from "../config/ai-models";
import type { OpenAiSettingsInput } from "./openai_auto_reply.service";

export type AiSettingsShape = {
  credentialId?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number | null;
  continuousChat?: boolean;
};

export function parseAiSettingsJson(raw: unknown): AiSettingsShape | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    credentialId:
      typeof o.credentialId === "string" ? o.credentialId : undefined,
    apiKey: typeof o.apiKey === "string" ? o.apiKey : undefined,
    model: typeof o.model === "string" ? o.model : undefined,
    baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : undefined,
    systemPrompt:
      typeof o.systemPrompt === "string" ? o.systemPrompt : undefined,
    temperature: typeof o.temperature === "number" ? o.temperature : undefined,
    maxTokens: typeof o.maxTokens === "number" ? o.maxTokens : null,
    continuousChat:
      typeof o.continuousChat === "boolean" ? o.continuousChat : undefined,
  };
}

/**
 * Validate AI settings for create/update when AI is enabled.
 * Prefer credentialId (+ optional model override); allow legacy apiKey for dual-read.
 */
export async function assertValidAiSettings(
  workspaceId: string,
  settings: unknown,
  opts?: { allowLegacyApiKey?: boolean }
): Promise<void> {
  const parsed = parseAiSettingsJson(settings);
  if (!parsed) {
    throw new AppError(
      400,
      "AI settings with credentialId are required when AI is enabled",
      "VALIDATION"
    );
  }

  if (parsed.credentialId?.trim()) {
    await resolveCredentialToOpenAiInput(workspaceId, {
      credentialId: parsed.credentialId,
      model: parsed.model,
      systemPrompt: parsed.systemPrompt,
      temperature: parsed.temperature,
      maxTokens: parsed.maxTokens,
    });
    return;
  }

  if (opts?.allowLegacyApiKey !== false && parsed.apiKey?.trim()) {
    if (!parsed.model?.trim()) {
      throw new AppError(
        400,
        "AI settings require a model when using a legacy API key",
        "VALIDATION"
      );
    }
    return;
  }

  throw new AppError(
    400,
    "AI settings with credentialId are required when AI is enabled",
    "VALIDATION"
  );
}

/**
 * Resolve stored AI settings (credential-based or legacy) into OpenAI-compatible input.
 */
export async function resolveAiSettingsToOpenAiInput(
  workspaceId: string,
  settings: unknown
): Promise<OpenAiSettingsInput | null> {
  const parsed = parseAiSettingsJson(settings);
  if (!parsed) return null;

  if (parsed.credentialId?.trim()) {
    try {
      return await resolveCredentialToOpenAiInput(workspaceId, parsed);
    } catch (err) {
      console.error(
        "[ai] Failed to resolve credential settings",
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  if (parsed.apiKey?.trim()) {
    return {
      apiKey: parsed.apiKey,
      model: parsed.model,
      baseUrl: parsed.baseUrl,
      systemPrompt: parsed.systemPrompt,
      temperature: parsed.temperature,
      maxTokens: parsed.maxTokens ?? null,
    };
  }

  return null;
}

export async function resolveCredentialToOpenAiInput(
  workspaceId: string,
  settings: AiSettingsShape
): Promise<OpenAiSettingsInput> {
  const credentialId = settings.credentialId?.trim();
  if (!credentialId) {
    throw new AppError(400, "credentialId is required", "VALIDATION");
  }

  const cred = await prisma.aiCredential.findFirst({
    where: { id: credentialId, workspaceId },
  });
  if (!cred) {
    throw new AppError(404, "AI credential not found", "NOT_FOUND");
  }
  if (!cred.active) {
    throw new AppError(400, "AI credential is inactive", "VALIDATION");
  }

  const modelRaw = settings.model?.trim() || cred.model?.trim();
  if (!modelRaw) {
    throw new AppError(400, "model is required", "VALIDATION");
  }

  const modelId = resolveCatalogModelId(cred.provider as AiProvider, modelRaw);
  if (!modelId) {
    throw new AppError(
      400,
      "Selected model is not allowed for this provider",
      "VALIDATION"
    );
  }

  const baseUrl = normalizeOpenAiCompatibleBaseUrl(
    cred.provider as AiProvider,
    cred.apiEndpoint
  );

  return {
    apiKey: cred.apiKey,
    model: modelId,
    baseUrl,
    systemPrompt: settings.systemPrompt,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens ?? null,
  };
}

/** Strip secrets from settings before returning to clients. */
export function sanitizeAiSettingsForResponse(
  settings: unknown
): Record<string, unknown> | null {
  const parsed = parseAiSettingsJson(settings);
  if (!parsed) return null;
  const out: Record<string, unknown> = {};
  if (parsed.credentialId) out.credentialId = parsed.credentialId;
  if (parsed.model) out.model = parsed.model;
  if (parsed.systemPrompt !== undefined) out.systemPrompt = parsed.systemPrompt;
  if (parsed.temperature !== undefined) out.temperature = parsed.temperature;
  if (parsed.maxTokens !== undefined) out.maxTokens = parsed.maxTokens;
  if (parsed.continuousChat !== undefined) {
    out.continuousChat = parsed.continuousChat;
  }
  if (parsed.apiKey?.trim() && !parsed.credentialId) {
    out.hasLegacyApiKey = true;
    if (parsed.baseUrl) out.baseUrl = parsed.baseUrl;
  }
  return out;
}

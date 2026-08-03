import { AppError } from "../lib/errors";
import {
  assertValidAiSettings,
  resolveAiSettingsToOpenAiInput,
} from "./ai_credential_resolve.service";
import { generateOpenAiReply } from "./openai_auto_reply.service";

const DEFAULT_REWRITE_SYSTEM_PROMPT = [
  "You rewrite marketing/outreach WhatsApp messages.",
  "Return only the rewritten message text — no quotes, labels, markdown, or commentary.",
  "Keep the same language, intent, and meaning.",
  "Vary wording naturally so it does not look identical to the original.",
  "Keep length similar; do not invent facts, links, or offers.",
].join(" ");

export type BulkAiRewriteInput = {
  enabled: boolean;
  count: number;
  credentialId: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number | null;
};

/** Normalize custom message texts: trim, drop empties, preserve order. */
export function normalizeBodyTexts(input: {
  bodyText?: string;
  bodyTexts?: string[];
}): string[] {
  const fromArray = Array.isArray(input.bodyTexts) ? input.bodyTexts : [];
  const fromSingle = input.bodyText?.trim() ? [input.bodyText] : [];
  const source = fromArray.length > 0 ? fromArray : fromSingle;
  const out: string[] = [];
  for (const raw of source) {
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (!text) continue;
    if (text.length > 4096) {
      throw new AppError(
        400,
        "Message is too long (max 4096 characters)",
        "VALIDATION"
      );
    }
    out.push(text);
  }
  return out;
}

export function parseStoredBodyTexts(
  raw: unknown,
  fallback: string | null | undefined
): string[] {
  if (Array.isArray(raw)) {
    const texts = raw
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
    if (texts.length > 0) return texts;
  }
  const fb = fallback?.trim();
  return fb ? [fb] : [];
}

export function pickRandomBodyText(pool: string[]): string {
  if (pool.length === 0) return "";
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? "";
}

/**
 * Generate AI rewrite variants from the first custom seed text.
 * Fails the whole create if any generation call fails.
 */
export async function generateAiRewriteVariants(
  workspaceId: string,
  seedText: string,
  aiRewrite: BulkAiRewriteInput
): Promise<string[]> {
  if (!aiRewrite.enabled || aiRewrite.count < 1) return [];

  await assertValidAiSettings(
    workspaceId,
    {
      credentialId: aiRewrite.credentialId,
      systemPrompt: aiRewrite.systemPrompt,
      temperature: aiRewrite.temperature,
      maxTokens: aiRewrite.maxTokens,
    },
    { allowLegacyApiKey: false }
  );

  const resolved = await resolveAiSettingsToOpenAiInput(workspaceId, {
    credentialId: aiRewrite.credentialId,
    systemPrompt: [
      DEFAULT_REWRITE_SYSTEM_PROMPT,
      aiRewrite.systemPrompt?.trim() || "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    temperature: aiRewrite.temperature ?? 0.85,
    maxTokens: aiRewrite.maxTokens,
  });

  if (!resolved) {
    throw new AppError(
      400,
      "Unable to resolve AI credentials for message rewrite",
      "VALIDATION"
    );
  }

  const variants: string[] = [];
  for (let i = 0; i < aiRewrite.count; i++) {
    try {
      const rewritten = await generateOpenAiReply(
        resolved,
        `Rewrite this WhatsApp message (variant ${i + 1} of ${aiRewrite.count}). Make it distinct from other variants:\n\n${seedText}`
      );
      const text = rewritten.trim();
      if (!text) {
        throw new Error("empty rewrite");
      }
      variants.push(text.slice(0, 4096));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AppError(
        502,
        `AI message rewrite failed (${i + 1}/${aiRewrite.count}): ${msg}`,
        "AI_REWRITE_FAILED"
      );
    }
  }
  return variants;
}

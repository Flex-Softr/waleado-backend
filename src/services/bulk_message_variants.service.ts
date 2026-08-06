import { AppError } from "../lib/errors";
import {
  assertValidAiSettings,
  resolveCredentialToOpenAiInput,
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
  model?: string;
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

function coerceStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Double-encoded JSON array (legacy / bad writes).
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        return coerceStringList(JSON.parse(trimmed) as unknown);
      } catch {
        // fall through
      }
    }
    return trimmed ? [trimmed] : [];
  }

  // Some JSON drivers may surface arrays as objects with numeric keys.
  if (raw && typeof raw === "object") {
    const values = Object.values(raw as Record<string, unknown>);
    if (values.length > 0 && values.every((v) => typeof v === "string")) {
      return values
        .map((s) => (s as string).trim())
        .filter(Boolean);
    }
  }

  return [];
}

export function parseStoredBodyTexts(
  raw: unknown,
  fallback: string | null | undefined
): string[] {
  const texts = coerceStringList(raw);
  if (texts.length > 0) return texts;
  const fb = fallback?.trim();
  return fb ? [fb] : [];
}

export function pickRandomBodyText(pool: string[]): string {
  if (pool.length === 0) return "";
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx] ?? "";
}

/**
 * Pick a variant for recipient `recipientIndex`.
 * Uses a random start offset + round-robin so every custom/AI variant is used
 * evenly (pure Math.random alone can look "stuck" on the first with small lists).
 */
export function pickBodyTextForRecipient(
  pool: string[],
  recipientIndex: number,
  rotationOffset = 0
): string {
  if (pool.length === 0) return "";
  if (pool.length === 1) return pool[0] ?? "";
  const idx =
    (Math.abs(rotationOffset) + Math.max(0, recipientIndex)) % pool.length;
  return pool[idx] ?? pool[0] ?? "";
}

function normalizeRewriteText(text: string): string {
  return text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^rewrite(?:d)?(?:\s*message)?\s*:\s*/i, "")
    .trim();
}

function isDistinctVariant(candidate: string, seed: string, existing: string[]): boolean {
  const norm = candidate.toLowerCase().replace(/\s+/g, " ").trim();
  if (!norm) return false;
  const seedNorm = seed.toLowerCase().replace(/\s+/g, " ").trim();
  if (norm === seedNorm) return false;
  return !existing.some(
    (e) => e.toLowerCase().replace(/\s+/g, " ").trim() === norm
  );
}

/**
 * Generate AI rewrite variants from the first custom seed text.
 * Fails the whole create if any generation call fails or yields too few variants.
 */
export async function generateAiRewriteVariants(
  workspaceId: string,
  seedText: string,
  aiRewrite: BulkAiRewriteInput
): Promise<string[]> {
  const count = Math.floor(Number(aiRewrite.count));
  if (!aiRewrite.enabled || !Number.isFinite(count) || count < 1) {
    throw new AppError(
      400,
      "AI rewrite requires enabled=true and count >= 1",
      "VALIDATION"
    );
  }

  const seed = seedText.trim();
  if (!seed) {
    throw new AppError(
      400,
      "A seed message is required to generate AI variants",
      "VALIDATION"
    );
  }

  const credentialId = aiRewrite.credentialId?.trim();
  if (!credentialId) {
    throw new AppError(
      400,
      "credentialId is required when AI rewrite is enabled",
      "VALIDATION"
    );
  }

  await assertValidAiSettings(
    workspaceId,
    {
      credentialId,
      model: aiRewrite.model,
      systemPrompt: aiRewrite.systemPrompt,
      temperature: aiRewrite.temperature,
      maxTokens: aiRewrite.maxTokens,
    },
    { allowLegacyApiKey: false }
  );

  // Resolve directly — do not use the null-swallowing helper used by inbound bots.
  const resolved = await resolveCredentialToOpenAiInput(workspaceId, {
    credentialId,
    model: aiRewrite.model,
    systemPrompt: [
      DEFAULT_REWRITE_SYSTEM_PROMPT,
      aiRewrite.systemPrompt?.trim() || "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    temperature: aiRewrite.temperature ?? 0.9,
    maxTokens: aiRewrite.maxTokens,
  });

  const variants: string[] = [];
  const maxAttempts = count * 3;

  for (let attempt = 0; attempt < maxAttempts && variants.length < count; attempt++) {
    const variantNo = variants.length + 1;
    try {
      const rewritten = await generateOpenAiReply(
        {
          ...resolved,
          // Nudge temperature slightly per attempt so retries diverge.
          temperature: Math.min(
            1.4,
            (resolved.temperature ?? 0.9) + attempt * 0.05
          ),
        },
        [
          `Rewrite this WhatsApp outreach message.`,
          `Create variant ${variantNo} of ${count}.`,
          `It must be clearly different wording from the original and from other variants.`,
          `Return only the message body.`,
          ``,
          `Original:`,
          seed,
          variants.length > 0
            ? `\nAlready used (do not repeat):\n${variants.map((v, i) => `${i + 1}. ${v}`).join("\n")}`
            : "",
        ].join("\n")
      );
      const text = normalizeRewriteText(rewritten).slice(0, 4096);
      if (!isDistinctVariant(text, seed, variants)) {
        continue;
      }
      variants.push(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Keep trying a couple times on transient provider errors, then fail hard.
      if (attempt >= maxAttempts - 1 || variants.length === 0 && attempt >= 2) {
        throw new AppError(
          502,
          `AI message rewrite failed (${variantNo}/${count}): ${msg}`,
          "AI_REWRITE_FAILED"
        );
      }
    }
  }

  if (variants.length < count) {
    throw new AppError(
      502,
      `AI rewrite only produced ${variants.length} of ${count} distinct variant(s). Try again or use a different model.`,
      "AI_REWRITE_INSUFFICIENT"
    );
  }

  return variants;
}

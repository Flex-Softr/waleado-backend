import { hasFeature } from "../billing/entitlements.service";
import {
  normalizeOpenAiCompatibleBaseUrl,
  resolveCatalogModelId,
} from "../config/ai-models";
import { AppError } from "../lib/errors";
import { prisma } from "../lib/prisma";
import { generateOpenAiReply } from "./openai_auto_reply.service";

export const TEMPLATE_AI_ACTIONS = ["write", "shorter", "polite", "grammar", "version"] as const;
export type TemplateAiAction = (typeof TEMPLATE_AI_ACTIONS)[number];

const INSTRUCTIONS: Record<TemplateAiAction, string> = {
  write:
    "Write a short WhatsApp message for a business to send to a customer, based on the owner's request.",
  shorter: "Rewrite the message shorter, keeping its meaning and tone.",
  polite: "Rewrite the message to sound warmer and more polite, keeping it short.",
  grammar: "Fix spelling and grammar only. Change nothing else.",
  version:
    "Write one new version of the message with clearly different wording but the same meaning, so repeated sends do not look identical.",
};

/**
 * Writes or rewrites template text with the workspace's own AI credential. Placeholders such as
 * {name} are kept exactly; the reply is the message text only.
 */
export async function rewriteTemplateText(
  workspaceId: string,
  input: { action: TemplateAiAction; text?: string; prompt?: string; avoid?: string[] }
): Promise<{ text: string }> {
  if (!(await hasFeature(workspaceId, "ai"))) {
    throw new AppError(403, "AI writing is not included in your plan", "PLAN_FEATURE");
  }
  const text = input.text?.trim() ?? "";
  const prompt = input.prompt?.trim() ?? "";
  if (input.action === "write" ? !prompt && !text : !text) {
    throw new AppError(
      400,
      input.action === "write" ? "Describe the message you want" : "Write a message first",
      "VALIDATION"
    );
  }

  const cred = await prisma.aiCredential.findFirst({
    where: { workspaceId, active: true },
    orderBy: { createdAt: "asc" },
  });
  if (!cred) {
    throw new AppError(400, "Add an AI credential under AI settings first", "VALIDATION");
  }
  const rawModel = cred.model || "gemini-3.6-flash";

  const systemPrompt = [
    INSTRUCTIONS[input.action],
    "Rules: reply with the message text only, no quotes, no explanations.",
    "Keep every placeholder in curly braces exactly as written, e.g. {name}, {plan}.",
    "Write in the same language as the original message (or the request). Use WhatsApp formatting (*bold*, _italic_) only if the original does. No emoji unless the original has them.",
  ].join("\n");
  const user =
    input.action === "write"
      ? [prompt && `Request: ${prompt}`, text && `Current draft:\n${text}`].filter(Boolean).join("\n\n")
      : [
          `Message:\n${text}`,
          input.avoid?.length
            ? `Do not repeat these existing versions:\n${input.avoid.slice(0, 5).map((v, i) => `${i + 1}. ${v}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");

  let out: string;
  try {
    out = await generateOpenAiReply(
      {
        apiKey: cred.apiKey,
        model: resolveCatalogModelId(cred.provider, rawModel) || rawModel,
        baseUrl: normalizeOpenAiCompatibleBaseUrl(cred.provider, cred.apiEndpoint),
        temperature: input.action === "grammar" ? 0.1 : 0.7,
        maxTokens: 600,
        systemPrompt,
      },
      user
    );
  } catch (err) {
    throw new AppError(
      502,
      `The AI could not write this: ${err instanceof Error ? err.message : "unknown error"}`,
      "AI_ERROR"
    );
  }
  const cleaned = out.trim().replace(/^["“]|["”]$/g, "").trim().slice(0, 4096);
  if (!cleaned) throw new AppError(502, "The AI returned an empty message", "AI_ERROR");
  return { text: cleaned };
}

import {
  LiveChatMessageDirection,
  type ConversationFollowUp,
  type LeadStage,
} from "@prisma/client";
import { hasFeature } from "../billing/entitlements.service";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import {
  buildAnalysisSystemPrompt,
  buildTranscript,
  CLOSED_STAGES,
  computeFollowUpAt,
  DEFAULT_IDLE_HOURS,
  LEAD_STAGES,
  MAX_FOLLOW_UPS_PER_CONTACT,
  parseAnalysis,
  stretchDays,
  type TranscriptLine,
} from "../lib/followup-analysis";
import {
  normalizeOpenAiCompatibleBaseUrl,
  resolveCatalogModelId,
} from "../config/ai-models";
import { resolveAiSettingsToOpenAiInput } from "./ai_credential_resolve.service";
import { decodeLiveChatBodyText } from "./live_chat_message_codec";
import {
  generateOpenAiReply,
  type OpenAiSettingsInput,
} from "./openai_auto_reply.service";
import * as messaging from "./messaging.service";

export type FollowUpJson = {
  id: string;
  deviceId: string;
  peerPhone: string | null;
  peerLabel: string;
  /** What to show as the contact's name. */
  displayTitle: string;
  stage: LeadStage;
  summary: string;
  needsHuman: boolean;
  followUpStatus: "NONE" | "SCHEDULED" | "SENT" | "CANCELED";
  followUpAt: string | null;
  followUpMessage: string | null;
  followUpsSent: number;
  lastFollowUpSentAt: string | null;
  lastConversationAt: string;
  canSend: boolean;
};

function toJson(r: ConversationFollowUp): FollowUpJson {
  const label = r.peerLabel.trim();
  return {
    id: r.id,
    deviceId: r.deviceId,
    peerPhone: r.peerPhone,
    peerLabel: r.peerLabel,
    displayTitle: label || r.peerPhone || r.peerKey,
    stage: r.stage,
    summary: r.summary,
    needsHuman: r.needsHuman,
    followUpStatus: r.followUpStatus,
    followUpAt: r.followUpAt?.toISOString() ?? null,
    followUpMessage: r.followUpMessage,
    followUpsSent: r.followUpsSent,
    lastFollowUpSentAt: r.lastFollowUpSentAt?.toISOString() ?? null,
    lastConversationAt: r.lastConversationAt.toISOString(),
    canSend: Boolean(r.peerPhone),
  };
}

// ───────────────────────── list / update / send ─────────────────────────

export type FollowUpView = "today" | "scheduled" | "converted" | "all";

export async function listFollowUps(
  workspaceId: string,
  opts: { view: FollowUpView; since?: Date; deviceId?: string }
): Promise<FollowUpJson[]> {
  const where: Record<string, unknown> = { workspaceId };
  if (opts.deviceId) where.deviceId = opts.deviceId;
  let orderBy: Record<string, "asc" | "desc">[] = [{ lastConversationAt: "desc" }];

  if (opts.view === "today") {
    where.lastConversationAt = {
      gte: opts.since ?? new Date(Date.now() - 24 * 3_600_000),
    };
  } else if (opts.view === "scheduled") {
    where.followUpStatus = "SCHEDULED";
    orderBy = [{ followUpAt: "asc" }];
  } else if (opts.view === "converted") {
    where.stage = "CONVERTED";
  }

  const rows = await prisma.conversationFollowUp.findMany({
    where,
    orderBy,
    take: 300,
  });
  return rows.map(toJson);
}

export type UpdateFollowUpInput = {
  stage?: LeadStage;
  followUpAt?: Date | null;
  followUpMessage?: string | null;
  followUpStatus?: "SCHEDULED" | "CANCELED";
  needsHuman?: boolean;
};

export async function updateFollowUp(
  workspaceId: string,
  id: string,
  input: UpdateFollowUpInput
): Promise<FollowUpJson> {
  const existing = await prisma.conversationFollowUp.findFirst({
    where: { id, workspaceId },
  });
  if (!existing) throw new AppError(404, "Follow-up not found", "NOT_FOUND");

  const data: Record<string, unknown> = {};
  if (input.stage !== undefined) {
    data.stage = input.stage;
    if (CLOSED_STAGES.has(input.stage)) {
      // Converted / lost contacts never get follow-ups.
      data.followUpStatus = "CANCELED";
    }
  }
  if (input.followUpAt !== undefined) data.followUpAt = input.followUpAt;
  if (input.followUpMessage !== undefined) {
    const t = input.followUpMessage?.trim() ?? "";
    data.followUpMessage = t ? t.slice(0, 1500) : null;
  }
  if (input.needsHuman !== undefined) data.needsHuman = input.needsHuman;

  const nextStage = (data.stage as LeadStage | undefined) ?? existing.stage;
  if (input.followUpStatus === "CANCELED") {
    data.followUpStatus = "CANCELED";
  } else if (input.followUpStatus === "SCHEDULED") {
    if (CLOSED_STAGES.has(nextStage)) {
      throw new AppError(400, "Converted or lost contacts cannot have a follow-up", "VALIDATION");
    }
    const at = (data.followUpAt as Date | null | undefined) ?? existing.followUpAt;
    const msg =
      data.followUpMessage !== undefined
        ? (data.followUpMessage as string | null)
        : existing.followUpMessage;
    if (!at || !msg) {
      throw new AppError(400, "A follow-up needs a date and a message", "VALIDATION");
    }
    if (!existing.peerPhone) {
      throw new AppError(400, "This contact has no phone number to message", "VALIDATION");
    }
    data.followUpStatus = "SCHEDULED";
  }

  const row = await prisma.conversationFollowUp.update({ where: { id }, data });
  return toJson(row);
}

/** Sends the planned follow-up now. Recorded as an automated message so the AI is not paused. */
export async function sendFollowUpNow(
  workspaceId: string,
  id: string
): Promise<FollowUpJson> {
  const row = await prisma.conversationFollowUp.findFirst({ where: { id, workspaceId } });
  if (!row) throw new AppError(404, "Follow-up not found", "NOT_FOUND");
  if (!row.peerPhone) {
    throw new AppError(400, "This contact has no phone number to message", "VALIDATION");
  }
  if (CLOSED_STAGES.has(row.stage)) {
    throw new AppError(400, "Converted or lost contacts cannot be followed up", "VALIDATION");
  }
  const text = row.followUpMessage?.trim();
  if (!text) throw new AppError(400, "Write the follow-up message first", "VALIDATION");

  const outbound = await messaging.sendSingleMessage(workspaceId, {
    deviceId: row.deviceId,
    toPhone: row.peerPhone,
    kind: "text",
    bodyText: text,
  });

  const now = new Date();
  try {
    const thread = await prisma.liveChatThread.upsert({
      where: {
        workspaceId_deviceId_peerPhone: {
          workspaceId,
          deviceId: row.deviceId,
          peerPhone: row.peerPhone,
        },
      },
      update: { lastPreview: text.slice(0, 200), lastMessageAt: now },
      create: {
        workspaceId,
        deviceId: row.deviceId,
        peerPhone: row.peerPhone,
        lastPreview: text.slice(0, 200),
        lastMessageAt: now,
      },
    });
    await prisma.liveChatMessage.create({
      data: {
        threadId: thread.id,
        direction: LiveChatMessageDirection.OUTBOUND,
        bodyText: text,
        outboundMessageId: outbound.id,
        // automated + bot: must NOT count as a human reply (that would pause the AI for 24h).
        meta: { sender: "bot", automated: true, source: "follow_up" },
      },
    });
  } catch (err) {
    console.warn("[follow-up] failed to record follow-up in live chat", err);
  }

  const updated = await prisma.conversationFollowUp.update({
    where: { id },
    data: {
      followUpStatus: "SENT",
      followUpsSent: { increment: 1 },
      lastFollowUpSentAt: now,
    },
  });
  return toJson(updated);
}

// ───────────────────────── AI analysis job ─────────────────────────

type AnalysisAi = { input: OpenAiSettingsInput; businessContext: string | null };

async function resolveAnalysisAi(
  workspaceId: string,
  ruleId: string
): Promise<AnalysisAi | null> {
  const rule = await prisma.autoReplyRule.findUnique({
    where: { id: ruleId },
    include: { aiSkill: { include: { aiCredential: true } } },
  });

  let cred = rule?.aiSkill?.aiCredential ?? null;
  if (cred && !cred.active) cred = null;
  if (!cred && !rule?.openAiSettings) {
    cred = await prisma.aiCredential.findFirst({ where: { workspaceId, active: true } });
  }

  let input: OpenAiSettingsInput | null = null;
  if (cred) {
    const rawModel = rule?.aiSkill?.model || cred.model || "gemini-3.6-flash";
    input = {
      apiKey: cred.apiKey,
      model: resolveCatalogModelId(cred.provider, rawModel) || rawModel,
      baseUrl: normalizeOpenAiCompatibleBaseUrl(cred.provider, cred.apiEndpoint),
    };
  } else if (rule?.openAiSettings) {
    input = await resolveAiSettingsToOpenAiInput(workspaceId, rule.openAiSettings);
  }
  if (!input?.apiKey) return null;

  const skill = rule?.aiSkill;
  const businessContext = skill
    ? [
        skill.servicesDescription && `Services: ${skill.servicesDescription}`,
        skill.customInstructions && `Instructions: ${skill.customInstructions}`,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 3000) || null
    : null;

  return {
    input: { ...input, temperature: 0.2, maxTokens: 700 },
    businessContext,
  };
}

async function loadTranscript(
  workspaceId: string,
  deviceId: string,
  peerPhone: string
): Promise<{ lines: TranscriptLine[]; label: string }> {
  const thread = await prisma.liveChatThread.findUnique({
    where: { workspaceId_deviceId_peerPhone: { workspaceId, deviceId, peerPhone } },
  });
  if (!thread) return { lines: [], label: "" };
  const msgs = await prisma.liveChatMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  msgs.reverse();
  const lines: TranscriptLine[] = msgs.map((m) => ({
    role: m.direction === LiveChatMessageDirection.INBOUND ? "customer" : "business",
    text: decodeLiveChatBodyText(m.bodyText).text,
  }));
  return { lines, label: thread.peerLabel };
}

/** Skip conversations whose analysis recently failed (avoids hammering a broken AI key). */
const retryAfter = new Map<string, number>();
const RETRY_DELAY_MS = 30 * 60_000;
const BATCH = 25;

export async function runConversationAnalysis(): Promise<{ analyzed: number }> {
  const now = Date.now();
  const idleBefore = new Date(now - DEFAULT_IDLE_HOURS * 3_600_000);
  const notOlderThan = new Date(now - 14 * 24 * 3_600_000);

  const candidates = await prisma.aiConversation.findMany({
    where: { lastActivityAt: { lte: idleBefore, gte: notOlderThan } },
    orderBy: { lastActivityAt: "desc" },
    take: 200,
  });
  if (candidates.length === 0) return { analyzed: 0 };

  const existingRows = await prisma.conversationFollowUp.findMany({
    where: {
      workspaceId: { in: [...new Set(candidates.map((c) => c.workspaceId))] },
      peerKey: { in: candidates.map((c) => c.peerKey) },
    },
  });
  const existingByKey = new Map(
    existingRows.map((r) => [`${r.workspaceId}|${r.deviceId}|${r.peerKey}`, r])
  );

  const aiAllowed = new Map<string, boolean>();
  let analyzed = 0;

  for (const conv of candidates) {
    if (analyzed >= BATCH) break;
    const key = `${conv.workspaceId}|${conv.deviceId}|${conv.peerKey}`;
    const existing = existingByKey.get(key);
    if (existing?.analyzedActivityAt && existing.analyzedActivityAt >= conv.lastActivityAt) {
      continue;
    }
    if ((retryAfter.get(conv.id) ?? 0) > now) continue;

    if (!aiAllowed.has(conv.workspaceId)) {
      aiAllowed.set(conv.workspaceId, await hasFeature(conv.workspaceId, "ai"));
    }
    if (!aiAllowed.get(conv.workspaceId)) continue;

    try {
      const peerPhone = conv.peerKey.startsWith("+") ? conv.peerKey : null;
      if (!peerPhone) {
        retryAfter.set(conv.id, now + 24 * 3_600_000);
        continue;
      }
      const ai = await resolveAnalysisAi(conv.workspaceId, conv.ruleId);
      if (!ai) throw new Error("no AI credential available");

      const { lines, label } = await loadTranscript(conv.workspaceId, conv.deviceId, peerPhone);
      const transcript = buildTranscript(lines);
      if (!transcript) {
        retryAfter.set(conv.id, now + 24 * 3_600_000);
        continue;
      }

      // Customer answered after our last follow-up → the unanswered counter starts over.
      const answeredFollowUp =
        existing?.lastFollowUpSentAt != null &&
        conv.lastActivityAt > existing.lastFollowUpSentAt;
      const sentSoFar = answeredFollowUp ? 0 : existing?.followUpsSent ?? 0;

      const raw = await generateOpenAiReply(
        {
          ...ai.input,
          systemPrompt: buildAnalysisSystemPrompt({
            businessContext: ai.businessContext,
            followUpNumber: sentSoFar + 1,
          }),
        },
        `Conversation:\n${transcript}\n\nReturn the JSON now.`
      );
      const result = parseAnalysis(raw);
      if (!result) throw new Error("AI returned an unreadable analysis");

      const stage: LeadStage =
        existing?.stage === "CONVERTED" ? "CONVERTED" : result.stage;
      const limitReached = sentSoFar >= MAX_FOLLOW_UPS_PER_CONTACT;
      const schedule =
        !CLOSED_STAGES.has(stage) &&
        !limitReached &&
        result.followUpDays !== null &&
        result.followUpMessage !== null;

      const planned = schedule
        ? {
            followUpStatus: "SCHEDULED" as const,
            followUpAt: computeFollowUpAt(new Date(), stretchDays(result.followUpDays!, sentSoFar)),
            followUpMessage: result.followUpMessage,
          }
        : {
            followUpStatus: CLOSED_STAGES.has(stage) ? ("CANCELED" as const) : ("NONE" as const),
            followUpAt: null,
            followUpMessage: null,
          };

      const common = {
        peerPhone,
        peerLabel: label,
        stage,
        summary: result.summary,
        needsHuman: result.needsHuman,
        ...planned,
        followUpsSent: sentSoFar,
        lastConversationAt: conv.lastActivityAt,
        analyzedAt: new Date(),
        analyzedActivityAt: conv.lastActivityAt,
      };
      await prisma.conversationFollowUp.upsert({
        where: {
          workspaceId_deviceId_peerKey: {
            workspaceId: conv.workspaceId,
            deviceId: conv.deviceId,
            peerKey: conv.peerKey,
          },
        },
        create: {
          workspaceId: conv.workspaceId,
          deviceId: conv.deviceId,
          peerKey: conv.peerKey,
          ...common,
        },
        update: common,
      });
      analyzed += 1;
    } catch (err) {
      retryAfter.set(conv.id, now + RETRY_DELAY_MS);
      console.warn(
        "[follow-up] analysis failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  if (retryAfter.size > 5000) {
    for (const [k, t] of retryAfter) if (t < now) retryAfter.delete(k);
  }
  return { analyzed };
}

export const LEAD_STAGE_VALUES = LEAD_STAGES;

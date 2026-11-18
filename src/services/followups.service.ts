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
  LEAD_STAGES,
  parseAnalysis,
  stretchDays,
  type AnalysisResult,
  type LeadStageName,
  type TranscriptLine,
} from "../lib/followup-analysis";
import {
  fillFollowUpPlaceholders,
  isValidTimezone,
  isWithinSendWindow,
  randomSendGapMs,
} from "../lib/followup-schedule";
import { requireActiveTemplate } from "./templates.service";
import { hasHumanRepliedRecently } from "./auto_reply_inbound.service";
import { validateAndFormatPhone } from "../lib/phone";
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
  followUpStatus: "NONE" | "SCHEDULED" | "SENT" | "CANCELED" | "SUGGESTED";
  /** Who added the contact: the AI after a chat, or the owner by hand. */
  source: "AI" | "MANUAL";
  /** True when the owner controls the plan (the AI will not change date or message). */
  manualLock: boolean;
  note: string;
  followUpAt: string | null;
  followUpMessage: string | null;
  /** Saved template sent instead of plain text (keeps its media and buttons). */
  followUpTemplateId: string | null;
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
    source: r.source,
    manualLock: r.manualLock,
    note: r.note ?? "",
    followUpAt: r.followUpAt?.toISOString() ?? null,
    followUpMessage: r.followUpMessage,
    followUpTemplateId: r.followUpTemplateId,
    followUpsSent: r.followUpsSent,
    lastFollowUpSentAt: r.lastFollowUpSentAt?.toISOString() ?? null,
    lastConversationAt: r.lastConversationAt.toISOString(),
    canSend: Boolean(r.peerPhone),
  };
}

// ───────────────────────── settings ─────────────────────────

export type FollowUpSettingsJson = {
  /** False until the owner saves settings once (the UI then suggests the browser timezone). */
  configured: boolean;
  autoSend: boolean;
  /** AUTO: AI schedules by itself. SUGGEST: AI drafts, owner approves. OFF: owner only. */
  aiMode: "AUTO" | "SUGGEST" | "OFF";
  timezone: string;
  windowStartHour: number;
  windowEndHour: number;
  maxFollowUps: number;
  dailyLimitPerDevice: number;
  idleHours: number;
  maxDays: number;
  instructions: string;
};

export const FOLLOW_UP_SETTING_DEFAULTS: FollowUpSettingsJson = {
  configured: false,
  autoSend: false,
  aiMode: "SUGGEST",
  timezone: "UTC",
  windowStartHour: 9,
  windowEndHour: 21,
  maxFollowUps: 3,
  dailyLimitPerDevice: 30,
  idleHours: 2,
  maxDays: 30,
  instructions: "",
};

export async function getFollowUpSettings(workspaceId: string): Promise<FollowUpSettingsJson> {
  const row = await prisma.followUpSettings.findUnique({ where: { workspaceId } });
  if (!row) return { ...FOLLOW_UP_SETTING_DEFAULTS };
  return {
    configured: true,
    autoSend: row.autoSend,
    aiMode: row.aiMode,
    timezone: row.timezone,
    windowStartHour: row.windowStartHour,
    windowEndHour: row.windowEndHour,
    maxFollowUps: row.maxFollowUps,
    dailyLimitPerDevice: row.dailyLimitPerDevice,
    idleHours: row.idleHours,
    maxDays: row.maxDays,
    instructions: row.instructions ?? "",
  };
}

export type SaveFollowUpSettingsInput = Partial<Omit<FollowUpSettingsJson, "configured">>;

export async function saveFollowUpSettings(
  workspaceId: string,
  input: SaveFollowUpSettingsInput
): Promise<FollowUpSettingsJson> {
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    throw new AppError(400, "Unknown timezone", "VALIDATION");
  }
  const data = {
    ...(input.autoSend !== undefined && { autoSend: input.autoSend }),
    ...(input.aiMode !== undefined && { aiMode: input.aiMode }),
    ...(input.timezone !== undefined && { timezone: input.timezone }),
    ...(input.windowStartHour !== undefined && { windowStartHour: input.windowStartHour }),
    ...(input.windowEndHour !== undefined && { windowEndHour: input.windowEndHour }),
    ...(input.maxFollowUps !== undefined && { maxFollowUps: input.maxFollowUps }),
    ...(input.dailyLimitPerDevice !== undefined && { dailyLimitPerDevice: input.dailyLimitPerDevice }),
    ...(input.idleHours !== undefined && { idleHours: input.idleHours }),
    ...(input.maxDays !== undefined && { maxDays: input.maxDays }),
    ...(input.instructions !== undefined && {
      instructions: input.instructions.trim().slice(0, 3000) || null,
    }),
  };
  await prisma.followUpSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, ...data },
    update: data,
  });
  return getFollowUpSettings(workspaceId);
}

// ───────────────────────── list / update / send ─────────────────────────

export type FollowUpView = "today" | "suggested" | "scheduled" | "converted" | "all";

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
  } else if (opts.view === "suggested") {
    where.followUpStatus = "SUGGESTED";
    orderBy = [{ followUpAt: "asc" }];
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
  /** Send a saved template instead of the text; null goes back to plain text. */
  followUpTemplateId?: string | null;
  followUpStatus?: "SCHEDULED" | "CANCELED";
  needsHuman?: boolean;
  /** true = owner controls the plan; false = hand the plan back to the AI. */
  manualLock?: boolean;
  note?: string | null;
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
  if (input.followUpTemplateId !== undefined) {
    if (input.followUpTemplateId) {
      const tpl = await requireActiveTemplate(workspaceId, input.followUpTemplateId);
      data.followUpTemplateId = tpl.id;
      // Keep a readable summary of what will be sent for the list and the review page.
      if (data.followUpMessage === undefined) {
        data.followUpMessage = templateSummary(tpl);
      }
    } else {
      data.followUpTemplateId = null;
    }
  }
  if (input.needsHuman !== undefined) data.needsHuman = input.needsHuman;
  if (input.note !== undefined) {
    data.note = input.note?.trim().slice(0, 1000) || null;
  }

  // The owner changing the date or message makes it the owner's plan: lock it from the AI.
  const dateChanged =
    input.followUpAt !== undefined &&
    (input.followUpAt?.getTime() ?? null) !== (existing.followUpAt?.getTime() ?? null);
  const messageChanged =
    (data.followUpMessage !== undefined && data.followUpMessage !== existing.followUpMessage) ||
    (data.followUpTemplateId !== undefined &&
      data.followUpTemplateId !== existing.followUpTemplateId);
  if (input.manualLock === false) {
    data.manualLock = false;
    // Let the next analysis run re-plan this contact.
    data.analyzedActivityAt = null;
  } else if (input.manualLock === true || dateChanged || messageChanged) {
    data.manualLock = true;
    data.plannedAt = new Date();
  }

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
    const tplId =
      data.followUpTemplateId !== undefined
        ? (data.followUpTemplateId as string | null)
        : existing.followUpTemplateId;
    if (!at || (!msg && !tplId)) {
      throw new AppError(400, "A follow-up needs a date and a message or template", "VALIDATION");
    }
    if (!existing.peerPhone) {
      throw new AppError(400, "This contact has no phone number to message", "VALIDATION");
    }
    data.followUpStatus = "SCHEDULED";
  }

  const row = await prisma.conversationFollowUp.update({ where: { id }, data });
  return toJson(row);
}

function templateSummary(tpl: { name: string; body: string | null }): string {
  const body = tpl.body?.trim();
  return (body || `Template: ${tpl.name}`).slice(0, 1500);
}

export type CreateManualFollowUpInput = {
  deviceId: string;
  phone: string;
  name?: string | null;
  note?: string | null;
  followUpAt: Date;
  /** Plain text (may contain {name}). Optional when a template is chosen. */
  followUpMessage?: string | null;
  followUpTemplateId?: string | null;
};

/**
 * Owner adds a number to follow-up by hand (or re-plans an existing contact). One row per
 * contact per device: adding the same number again updates it. The plan is locked from the AI.
 */
export async function createManualFollowUp(
  workspaceId: string,
  input: CreateManualFollowUpInput
): Promise<{ item: FollowUpJson; everMessaged: boolean }> {
  const phone = validateAndFormatPhone(input.phone);
  if (!phone.valid) {
    throw new AppError(400, phone.message, "INVALID_PHONE");
  }
  const peerPhone = phone.e164.startsWith("+") ? phone.e164 : `+${phone.e164}`;
  const tpl = input.followUpTemplateId
    ? await requireActiveTemplate(workspaceId, input.followUpTemplateId)
    : null;
  const typed = input.followUpMessage?.trim().slice(0, 1500) ?? "";
  const message = tpl ? typed || templateSummary(tpl) : typed;
  if (!message) throw new AppError(400, "Write the follow-up message or pick a template", "VALIDATION");
  if (Number.isNaN(input.followUpAt.getTime())) {
    throw new AppError(400, "Pick a follow-up date", "VALIDATION");
  }

  const device = await prisma.device.findFirst({
    where: { id: input.deviceId, workspaceId },
    select: { id: true },
  });
  if (!device) throw new AppError(404, "Device not found", "NOT_FOUND");

  const thread = await prisma.liveChatThread.findUnique({
    where: {
      workspaceId_deviceId_peerPhone: { workspaceId, deviceId: device.id, peerPhone },
    },
    select: { id: true, peerLabel: true },
  });
  const everMessaged = thread
    ? Boolean(
        await prisma.liveChatMessage.findFirst({
          where: { threadId: thread.id, direction: LiveChatMessageDirection.INBOUND },
          select: { id: true },
        })
      )
    : false;

  const key = { workspaceId, deviceId: device.id, peerKey: peerPhone };
  const existing = await prisma.conversationFollowUp.findUnique({
    where: { workspaceId_deviceId_peerKey: key },
  });
  const now = new Date();
  const name = input.name?.trim().slice(0, 200) || "";
  const note = input.note?.trim().slice(0, 1000) || null;
  const plan = {
    followUpStatus: "SCHEDULED" as const,
    followUpAt: input.followUpAt,
    followUpMessage: message,
    followUpTemplateId: tpl?.id ?? null,
    manualLock: true,
    plannedAt: now,
    // A fresh manual plan starts its own count of unanswered follow-ups.
    followUpsSent: 0,
  };

  const row = existing
    ? await prisma.conversationFollowUp.update({
        where: { id: existing.id },
        data: {
          ...plan,
          peerPhone,
          ...(name && { peerLabel: name }),
          ...(note !== null && { note }),
          // Adding someone back to follow-up reopens a converted / lost contact.
          ...(CLOSED_STAGES.has(existing.stage) && { stage: "INTERESTED" as const }),
        },
      })
    : await prisma.conversationFollowUp.create({
        data: {
          ...key,
          ...plan,
          peerPhone,
          peerLabel: name || thread?.peerLabel || "",
          note,
          source: "MANUAL",
          stage: "NEW",
          lastConversationAt: now,
        },
      });
  return { item: toJson(row), everMessaged };
}

/** Removes a contact from the follow-up list for good. */
export async function deleteFollowUp(workspaceId: string, id: string): Promise<void> {
  const res = await prisma.conversationFollowUp.deleteMany({ where: { id, workspaceId } });
  if (res.count === 0) throw new AppError(404, "Follow-up not found", "NOT_FOUND");
}

/** Approves every AI suggestion that is ready to send (has a date, a message and a phone). */
export async function approveAllSuggestions(workspaceId: string): Promise<{ approved: number }> {
  const res = await prisma.conversationFollowUp.updateMany({
    where: {
      workspaceId,
      followUpStatus: "SUGGESTED",
      followUpAt: { not: null },
      followUpMessage: { not: null },
      peerPhone: { not: null },
      stage: { notIn: ["CONVERTED", "LOST"] },
    },
    data: { followUpStatus: "SCHEDULED" },
  });
  return { approved: res.count };
}

/**
 * Sends the follow-up text and records it in live chat as an automated message, so it is
 * NOT treated as a human reply (that would pause the AI for 24h). Marks the row SENT.
 */
async function deliverFollowUp(row: ConversationFollowUp): Promise<ConversationFollowUp> {
  if (!row.peerPhone) {
    throw new AppError(400, "This contact has no phone number to message", "VALIDATION");
  }
  let outbound: Awaited<ReturnType<typeof messaging.sendSingleMessage>>;
  let text: string;
  if (row.followUpTemplateId) {
    // Saved template: sent exactly as designed (media, buttons, footer).
    outbound = await messaging.sendSingleMessage(row.workspaceId, {
      deviceId: row.deviceId,
      toPhone: row.peerPhone,
      kind: "template",
      templateId: row.followUpTemplateId,
    });
    text = row.followUpMessage?.trim() || "(template message)";
  } else {
    const raw = row.followUpMessage?.trim();
    if (!raw) throw new AppError(400, "Write the follow-up message first", "VALIDATION");
    text = fillFollowUpPlaceholders(raw, row.peerLabel);
    outbound = await messaging.sendSingleMessage(row.workspaceId, {
      deviceId: row.deviceId,
      toPhone: row.peerPhone,
      kind: "text",
      bodyText: text,
    });
  }

  const now = new Date();
  try {
    const thread = await prisma.liveChatThread.upsert({
      where: {
        workspaceId_deviceId_peerPhone: {
          workspaceId: row.workspaceId,
          deviceId: row.deviceId,
          peerPhone: row.peerPhone,
        },
      },
      update: { lastPreview: text.slice(0, 200), lastMessageAt: now },
      create: {
        workspaceId: row.workspaceId,
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
        meta: { sender: "bot", automated: true, source: "follow_up" },
      },
    });
  } catch (err) {
    console.warn("[follow-up] failed to record follow-up in live chat", err);
  }

  return prisma.conversationFollowUp.update({
    where: { id: row.id },
    data: {
      followUpStatus: "SENT",
      followUpsSent: { increment: 1 },
      lastFollowUpSentAt: now,
    },
  });
}

/** Manual "Send now" from the review page. */
export async function sendFollowUpNow(
  workspaceId: string,
  id: string
): Promise<FollowUpJson> {
  const row = await prisma.conversationFollowUp.findFirst({ where: { id, workspaceId } });
  if (!row) throw new AppError(404, "Follow-up not found", "NOT_FOUND");
  if (CLOSED_STAGES.has(row.stage)) {
    throw new AppError(400, "Converted or lost contacts cannot be followed up", "VALIDATION");
  }
  return toJson(await deliverFollowUp(row));
}

// ───────────────────────── AI analysis job ─────────────────────────

type AnalysisAi = { input: OpenAiSettingsInput; businessContext: string | null };

async function resolveAnalysisAi(
  workspaceId: string,
  ruleId: string | null,
  instructions: string
): Promise<AnalysisAi | null> {
  const rule = ruleId
    ? await prisma.autoReplyRule.findUnique({
        where: { id: ruleId },
        include: { aiSkill: { include: { aiCredential: true } } },
      })
    : null;

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
  const context = [
    skill?.servicesDescription && `Services: ${skill.servicesDescription}`,
    skill?.customInstructions && `Skill instructions: ${skill.customInstructions}`,
    instructions.trim() && `Owner's follow-up guidance (follow this first): ${instructions.trim()}`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);

  return {
    input: { ...input, temperature: 0.2, maxTokens: 700 },
    businessContext: context || null,
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

type PlanResult = {
  label: string;
  result: AnalysisResult;
  stage: LeadStage;
  planned: {
    followUpStatus: "SCHEDULED" | "SUGGESTED" | "NONE" | "CANCELED";
    followUpAt: Date | null;
    followUpMessage: string | null;
    followUpTemplateId: null;
  };
};

/**
 * Reads the conversation, asks the AI for summary/stage/follow-up and turns it into a plan.
 * Returns null when there is nothing to analyse (no transcript yet).
 */
async function planFollowUp(args: {
  workspaceId: string;
  deviceId: string;
  peerPhone: string;
  ruleId: string | null;
  sentSoFar: number;
  existingStage: LeadStage | null;
  settings: FollowUpSettingsJson;
}): Promise<PlanResult | null> {
  const ai = await resolveAnalysisAi(args.workspaceId, args.ruleId, args.settings.instructions);
  if (!ai) throw new Error("no AI credential available");

  const { lines, label } = await loadTranscript(args.workspaceId, args.deviceId, args.peerPhone);
  const transcript = buildTranscript(lines);
  if (!transcript) return null;

  const raw = await generateOpenAiReply(
    {
      ...ai.input,
      systemPrompt: buildAnalysisSystemPrompt({
        businessContext: ai.businessContext,
        followUpNumber: args.sentSoFar + 1,
        maxDays: args.settings.maxDays,
      }),
    },
    `Conversation:\n${transcript}\n\nReturn the JSON now.`
  );
  const result = parseAnalysis(raw, { maxDays: args.settings.maxDays });
  if (!result) throw new Error("AI returned an unreadable analysis");

  // A contact the owner marked CONVERTED stays converted; everything else follows the AI.
  const stage: LeadStage =
    args.existingStage === "CONVERTED" ? "CONVERTED" : (result.stage as LeadStageName);
  const closed = CLOSED_STAGES.has(stage);
  const limitReached = args.sentSoFar >= args.settings.maxFollowUps;
  const schedule =
    !closed && !limitReached && result.followUpDays !== null && result.followUpMessage !== null;

  const planned = schedule
    ? {
        // In "suggest" mode the plan waits for the owner's approval before it can be sent.
        followUpStatus:
          args.settings.aiMode === "SUGGEST" ? ("SUGGESTED" as const) : ("SCHEDULED" as const),
        followUpAt: computeFollowUpAt(
          new Date(),
          stretchDays(result.followUpDays!, args.sentSoFar, args.settings.maxDays)
        ),
        followUpMessage: result.followUpMessage,
        followUpTemplateId: null,
      }
    : {
        followUpStatus: closed ? ("CANCELED" as const) : ("NONE" as const),
        followUpAt: null,
        followUpMessage: null,
        followUpTemplateId: null,
      };
  return { label, result, stage, planned };
}

/** Skip conversations whose analysis recently failed (avoids hammering a broken AI key). */
const retryAfter = new Map<string, number>();
const RETRY_DELAY_MS = 30 * 60_000;
const BATCH = 25;

type AnalysisCandidate = {
  workspaceId: string;
  deviceId: string;
  peerKey: string;
  /** AI rule that handled the chat, when the AI took part (picks the AI credential). */
  ruleId: string | null;
  /** When the conversation last moved; follow-ups we send never count as activity. */
  lastActivityAt: Date;
};

/**
 * Every recent private chat is a candidate, not only the ones the AI answered: chats the owner
 * handled by hand or with a template rule need follow-ups too. For live-chat threads the
 * activity time is the customer's last message, so our own follow-ups never look like a reply.
 */
export async function loadAnalysisCandidates(now: number, notOlderThan: Date): Promise<AnalysisCandidate[]> {
  // Shortest allowed idle time is 1h; each workspace's own idleHours is applied by the caller.
  const idleCutoff = now - 3_600_000;
  const byKey = new Map<string, AnalysisCandidate>();

  const aiConvs = await prisma.aiConversation.findMany({
    where: { lastActivityAt: { lte: new Date(idleCutoff), gte: notOlderThan } },
    orderBy: { lastActivityAt: "desc" },
    take: 200,
  });
  for (const c of aiConvs) {
    byKey.set(`${c.workspaceId}|${c.deviceId}|${c.peerKey}`, {
      workspaceId: c.workspaceId,
      deviceId: c.deviceId,
      peerKey: c.peerKey,
      ruleId: c.ruleId,
      lastActivityAt: c.lastActivityAt,
    });
  }

  // Latest customer message per thread. No upper bound here: a thread whose customer wrote
  // again a minute ago must not be analysed on an older message.
  const lastInbound = await prisma.liveChatMessage.groupBy({
    by: ["threadId"],
    where: { direction: LiveChatMessageDirection.INBOUND, createdAt: { gte: notOlderThan } },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: "desc" } },
    take: 500,
  });
  const idle = lastInbound.filter(
    (g) => g._max.createdAt !== null && g._max.createdAt.getTime() <= idleCutoff
  );
  if (idle.length > 0) {
    const threads = await prisma.liveChatThread.findMany({
      where: { id: { in: idle.map((g) => g.threadId) } },
      select: { id: true, workspaceId: true, deviceId: true, peerPhone: true },
    });
    const lastByThread = new Map(idle.map((g) => [g.threadId, g._max.createdAt as Date]));
    for (const t of threads) {
      if (!t.peerPhone.startsWith("+")) continue;
      const at = lastByThread.get(t.id);
      if (!at) continue;
      const key = `${t.workspaceId}|${t.deviceId}|${t.peerPhone}`;
      const ai = byKey.get(key);
      if (ai) {
        // AI chats keep their rule; use whichever activity is newer.
        if (at > ai.lastActivityAt) ai.lastActivityAt = at;
      } else {
        byKey.set(key, {
          workspaceId: t.workspaceId,
          deviceId: t.deviceId,
          peerKey: t.peerPhone,
          ruleId: null,
          lastActivityAt: at,
        });
      }
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime()
  );
}

export async function runConversationAnalysis(): Promise<{ analyzed: number }> {
  const now = Date.now();
  const notOlderThan = new Date(now - 14 * 24 * 3_600_000);
  const candidates = await loadAnalysisCandidates(now, notOlderThan);
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
  const settingsByWs = new Map<string, FollowUpSettingsJson>();
  let analyzed = 0;

  for (const conv of candidates) {
    if (analyzed >= BATCH) break;
    const key = `${conv.workspaceId}|${conv.deviceId}|${conv.peerKey}`;
    const existing = existingByKey.get(key);
    if (existing?.analyzedActivityAt && existing.analyzedActivityAt >= conv.lastActivityAt) {
      continue;
    }
    if ((retryAfter.get(key) ?? 0) > now) continue;

    if (!aiAllowed.has(conv.workspaceId)) {
      aiAllowed.set(conv.workspaceId, await hasFeature(conv.workspaceId, "ai"));
    }
    if (!aiAllowed.get(conv.workspaceId)) continue;

    let settings = settingsByWs.get(conv.workspaceId);
    if (!settings) {
      settings = await getFollowUpSettings(conv.workspaceId);
      settingsByWs.set(conv.workspaceId, settings);
    }
    // "Manual only": the AI neither analyses nor plans anything.
    if (settings.aiMode === "OFF") continue;
    if (conv.lastActivityAt.getTime() > now - settings.idleHours * 3_600_000) continue;

    try {
      const peerPhone = conv.peerKey.startsWith("+") ? conv.peerKey : null;
      if (!peerPhone) {
        retryAfter.set(key, now + 24 * 3_600_000);
        continue;
      }

      // Customer answered after our last follow-up → the unanswered counter starts over.
      const answeredFollowUp =
        existing?.lastFollowUpSentAt != null &&
        conv.lastActivityAt > existing.lastFollowUpSentAt;
      const sentSoFar = answeredFollowUp ? 0 : existing?.followUpsSent ?? 0;

      const plan = await planFollowUp({
        workspaceId: conv.workspaceId,
        deviceId: conv.deviceId,
        peerPhone,
        ruleId: conv.ruleId,
        sentSoFar,
        existingStage: existing?.stage ?? null,
        settings,
      });
      if (!plan) {
        retryAfter.set(key, now + 24 * 3_600_000);
        continue;
      }

      // Owner-locked plans keep their date and message; the AI only refreshes the summary.
      const locked = existing?.manualLock === true;
      const common = {
        peerPhone,
        peerLabel: plan.label || existing?.peerLabel || "",
        ruleId: conv.ruleId,
        stage: plan.stage,
        summary: plan.result.summary,
        needsHuman: plan.result.needsHuman,
        ...(locked ? {} : plan.planned),
        followUpsSent: locked ? existing.followUpsSent : sentSoFar,
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
      retryAfter.set(key, now + RETRY_DELAY_MS);
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

// ───────────────────────── automatic sender ─────────────────────────

const SENDS_PER_RUN = 20;
/** Lease/backoff: a due follow-up that is skipped or fails is looked at again after this. */
const LEASE_MS = 30 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function customerWroteSince(
  workspaceId: string,
  deviceId: string,
  peerPhone: string,
  since: Date
): Promise<boolean> {
  const thread = await prisma.liveChatThread.findUnique({
    where: { workspaceId_deviceId_peerPhone: { workspaceId, deviceId, peerPhone } },
    select: { id: true },
  });
  if (!thread) return false;
  const latest = await prisma.liveChatMessage.findFirst({
    where: { threadId: thread.id, direction: LiveChatMessageDirection.INBOUND },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return Boolean(latest && latest.createdAt > since);
}

/** After an unanswered follow-up, let the AI plan the next, later one (until the limit). */
async function planNextAfterSend(
  sent: ConversationFollowUp,
  settings: FollowUpSettingsJson
): Promise<void> {
  // The owner's own plans are never extended by the AI.
  if (sent.manualLock || settings.aiMode === "OFF") return;
  if (!sent.peerPhone || sent.followUpsSent >= settings.maxFollowUps) return;
  try {
    const plan = await planFollowUp({
      workspaceId: sent.workspaceId,
      deviceId: sent.deviceId,
      peerPhone: sent.peerPhone,
      ruleId: sent.ruleId,
      sentSoFar: sent.followUpsSent,
      existingStage: sent.stage,
      settings,
    });
    if (!plan || plan.planned.followUpAt === null) return;
    await prisma.conversationFollowUp.update({
      where: { id: sent.id },
      data: {
        ...plan.planned,
        stage: plan.stage,
        summary: plan.result.summary,
        needsHuman: plan.result.needsHuman,
      },
    });
  } catch (err) {
    console.warn(
      "[follow-up] could not plan the next follow-up:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Sends due follow-ups for workspaces that turned auto-send on. Safety rules: only inside
 * the owner's send window, never to someone a human is chatting with or who just wrote back,
 * never to contacts flagged "needs you", a per-device daily cap, and a random gap between sends.
 */
export async function runFollowUpSender(): Promise<{ sent: number }> {
  const now = new Date();
  const due = await prisma.conversationFollowUp.findMany({
    where: {
      followUpStatus: "SCHEDULED",
      followUpAt: { lte: now },
      stage: { notIn: ["CONVERTED", "LOST"] },
      needsHuman: false,
      peerPhone: { not: null },
    },
    orderBy: { followUpAt: "asc" },
    take: 100,
  });
  if (due.length === 0) return { sent: 0 };

  const settingsByWs = new Map<string, FollowUpSettingsJson>();
  const aiAllowed = new Map<string, boolean>();
  const sentTodayByDevice = new Map<string, number>();
  let sent = 0;

  for (const row of due) {
    if (sent >= SENDS_PER_RUN) break;

    let settings = settingsByWs.get(row.workspaceId);
    if (!settings) {
      settings = await getFollowUpSettings(row.workspaceId);
      settingsByWs.set(row.workspaceId, settings);
    }
    if (!settings.autoSend) continue;
    if (!isWithinSendWindow(now, settings.timezone, settings.windowStartHour, settings.windowEndHour)) {
      continue;
    }
    if (!aiAllowed.has(row.workspaceId)) {
      aiAllowed.set(row.workspaceId, await hasFeature(row.workspaceId, "ai"));
    }
    if (!aiAllowed.get(row.workspaceId)) continue;

    if (!sentTodayByDevice.has(row.deviceId)) {
      sentTodayByDevice.set(
        row.deviceId,
        await prisma.conversationFollowUp.count({
          where: {
            workspaceId: row.workspaceId,
            deviceId: row.deviceId,
            lastFollowUpSentAt: { gte: new Date(now.getTime() - 24 * 3_600_000) },
          },
        })
      );
    }
    if ((sentTodayByDevice.get(row.deviceId) ?? 0) >= settings.dailyLimitPerDevice) continue;

    const phone = row.peerPhone!;
    // Someone is already talking to this customer: leave the follow-up for the owner to decide.
    // (Skipped for the owner's own plans: they chose this date knowing about the chat.)
    if (!row.manualLock && (await hasHumanRepliedRecently(row.workspaceId, row.deviceId, phone))) {
      continue;
    }
    // The customer wrote back after the plan was made: hold it so nothing odd goes out.
    const plannedSince =
      row.manualLock && row.plannedAt ? row.plannedAt : row.lastConversationAt;
    if (await customerWroteSince(row.workspaceId, row.deviceId, phone, plannedSince)) {
      continue;
    }

    // Lease: push the due time forward atomically so two runs never send the same follow-up.
    const lease = await prisma.conversationFollowUp.updateMany({
      where: { id: row.id, followUpStatus: "SCHEDULED", followUpAt: row.followUpAt },
      data: { followUpAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (lease.count !== 1) continue;

    try {
      const updated = await deliverFollowUp(row);
      sent += 1;
      sentTodayByDevice.set(row.deviceId, (sentTodayByDevice.get(row.deviceId) ?? 0) + 1);
      await planNextAfterSend(updated, settings);
      await sleep(randomSendGapMs());
    } catch (err) {
      console.warn(
        "[follow-up] auto-send failed (will retry later):",
        err instanceof Error ? err.message : err
      );
    }
  }
  return { sent };
}

export const LEAD_STAGE_VALUES = LEAD_STAGES;

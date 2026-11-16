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
  isValidTimezone,
  isWithinSendWindow,
  randomSendGapMs,
} from "../lib/followup-schedule";
import { hasHumanRepliedRecently } from "./auto_reply_inbound.service";
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

// ───────────────────────── settings ─────────────────────────

export type FollowUpSettingsJson = {
  /** False until the owner saves settings once (the UI then suggests the browser timezone). */
  configured: boolean;
  autoSend: boolean;
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

/**
 * Sends the follow-up text and records it in live chat as an automated message, so it is
 * NOT treated as a human reply (that would pause the AI for 24h). Marks the row SENT.
 */
async function deliverFollowUp(row: ConversationFollowUp): Promise<ConversationFollowUp> {
  if (!row.peerPhone) {
    throw new AppError(400, "This contact has no phone number to message", "VALIDATION");
  }
  const text = row.followUpMessage?.trim();
  if (!text) throw new AppError(400, "Write the follow-up message first", "VALIDATION");

  const outbound = await messaging.sendSingleMessage(row.workspaceId, {
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
    followUpStatus: "SCHEDULED" | "NONE" | "CANCELED";
    followUpAt: Date | null;
    followUpMessage: string | null;
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
        followUpStatus: "SCHEDULED" as const,
        followUpAt: computeFollowUpAt(
          new Date(),
          stretchDays(result.followUpDays!, args.sentSoFar, args.settings.maxDays)
        ),
        followUpMessage: result.followUpMessage,
      }
    : {
        followUpStatus: closed ? ("CANCELED" as const) : ("NONE" as const),
        followUpAt: null,
        followUpMessage: null,
      };
  return { label, result, stage, planned };
}

/** Skip conversations whose analysis recently failed (avoids hammering a broken AI key). */
const retryAfter = new Map<string, number>();
const RETRY_DELAY_MS = 30 * 60_000;
const BATCH = 25;

export async function runConversationAnalysis(): Promise<{ analyzed: number }> {
  const now = Date.now();
  const notOlderThan = new Date(now - 14 * 24 * 3_600_000);
  // Shortest allowed idle time is 1h; each workspace's own idleHours is applied below.
  const candidates = await prisma.aiConversation.findMany({
    where: {
      lastActivityAt: { lte: new Date(now - 3_600_000), gte: notOlderThan },
    },
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
  const settingsByWs = new Map<string, FollowUpSettingsJson>();
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

    let settings = settingsByWs.get(conv.workspaceId);
    if (!settings) {
      settings = await getFollowUpSettings(conv.workspaceId);
      settingsByWs.set(conv.workspaceId, settings);
    }
    if (conv.lastActivityAt.getTime() > now - settings.idleHours * 3_600_000) continue;

    try {
      const peerPhone = conv.peerKey.startsWith("+") ? conv.peerKey : null;
      if (!peerPhone) {
        retryAfter.set(conv.id, now + 24 * 3_600_000);
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
        retryAfter.set(conv.id, now + 24 * 3_600_000);
        continue;
      }

      const common = {
        peerPhone,
        peerLabel: plan.label,
        ruleId: conv.ruleId,
        stage: plan.stage,
        summary: plan.result.summary,
        needsHuman: plan.result.needsHuman,
        ...plan.planned,
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
    if (!plan || plan.planned.followUpStatus !== "SCHEDULED") return;
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
    if (await hasHumanRepliedRecently(row.workspaceId, row.deviceId, phone)) continue;
    // The customer wrote back after the analysed chat; the AI will re-plan once it goes quiet.
    if (await customerWroteSince(row.workspaceId, row.deviceId, phone, row.lastConversationAt)) {
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

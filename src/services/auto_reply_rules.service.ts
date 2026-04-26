import {
  AutoReplyMessageMode,
  AutoReplyTriggerType,
  Prisma,
} from "@prisma/client";
import {
  parseAutoReplyKeywords,
  parseRegexPatterns,
  parseTriggerTokens,
} from "../lib/auto-reply-keywords";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { requireActiveTemplate } from "./templates.service";

/** API ↔ Prisma trigger type (REST uses snake_case strings). */
export type AutoReplyTriggerTypeApi =
  | "keyword"
  | "exact"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "regex";

export type AutoReplyMessageModeApi = "text" | "template" | "media";

export type AutoReplyRuleJson = {
  id: string;
  name: string;
  keyword: string;
  triggerType: AutoReplyTriggerTypeApi;
  caseSensitive: boolean;
  deviceId: string;
  deviceLabel: string;
  priority: number;
  cooldownMinutes: number;
  messageMode: AutoReplyMessageModeApi;
  templateId: string | null;
  templateName: string | null;
  mediaAssetId: string | null;
  mediaCaption: string | null;
  response: string;
  openAiEnabled: boolean;
  openAiSettings: Prisma.JsonValue | null;
  active: boolean;
  responseCount: number;
  createdAt: string;
  updatedAt: string;
};

function deviceLabel(d: { name: string; phone: string | null }): string {
  return d.phone ? `${d.name} · ${d.phone}` : d.name;
}

function toPrismaTriggerType(api: AutoReplyTriggerTypeApi): AutoReplyTriggerType {
  switch (api) {
    case "exact":
      return AutoReplyTriggerType.EXACT;
    case "contains":
      return AutoReplyTriggerType.CONTAINS;
    case "starts_with":
      return AutoReplyTriggerType.STARTS_WITH;
    case "ends_with":
      return AutoReplyTriggerType.ENDS_WITH;
    case "regex":
      return AutoReplyTriggerType.REGEX;
    case "keyword":
    default:
      return AutoReplyTriggerType.KEYWORD;
  }
}

function fromPrismaTriggerType(t: AutoReplyTriggerType): AutoReplyTriggerTypeApi {
  switch (t) {
    case AutoReplyTriggerType.EXACT:
      return "exact";
    case AutoReplyTriggerType.CONTAINS:
      return "contains";
    case AutoReplyTriggerType.STARTS_WITH:
      return "starts_with";
    case AutoReplyTriggerType.ENDS_WITH:
      return "ends_with";
    case AutoReplyTriggerType.REGEX:
      return "regex";
    case AutoReplyTriggerType.KEYWORD:
    default:
      return "keyword";
  }
}

function fromPrismaMessageMode(m: AutoReplyMessageMode): AutoReplyMessageModeApi {
  switch (m) {
    case AutoReplyMessageMode.TEMPLATE:
      return "template";
    case AutoReplyMessageMode.MEDIA:
      return "media";
    case AutoReplyMessageMode.TEXT:
    default:
      return "text";
  }
}

function toPrismaMessageMode(api: AutoReplyMessageModeApi): AutoReplyMessageMode {
  switch (api) {
    case "template":
      return AutoReplyMessageMode.TEMPLATE;
    case "media":
      return AutoReplyMessageMode.MEDIA;
    case "text":
    default:
      return AutoReplyMessageMode.TEXT;
  }
}

function validateTriggers(
  triggerType: AutoReplyTriggerTypeApi,
  caseSensitive: boolean,
  raw: string
): void {
  const trimmed = raw.trim();
  if (triggerType === "regex") {
    const patterns = parseRegexPatterns(trimmed);
    if (patterns.length === 0) {
      throw new AppError(
        400,
        "Enter at least one regex pattern (one per line).",
        "VALIDATION"
      );
    }
    for (const p of patterns) {
      try {
        void new RegExp(p);
      } catch {
        throw new AppError(400, `Invalid regex: ${p.slice(0, 80)}`, "VALIDATION");
      }
    }
    return;
  }
  const tokens = caseSensitive
    ? parseTriggerTokens(trimmed)
    : parseAutoReplyKeywords(trimmed);
  if (tokens.length === 0) {
    throw new AppError(
      400,
      "Enter at least one trigger (use commas or new lines between values).",
      "VALIDATION"
    );
  }
}

function assertContentRules(input: {
  messageMode: AutoReplyMessageModeApi;
  templateId: string | null;
  mediaAssetId: string | null;
  response: string;
  openAiEnabled: boolean;
}): void {
  const hasText = input.response.trim().length > 0;
  if (input.openAiEnabled) {
    return;
  }
  if (input.messageMode === "template" && !input.templateId) {
    throw new AppError(400, "Template is required for template message mode", "VALIDATION");
  }
  if (input.messageMode === "media" && !input.mediaAssetId) {
    throw new AppError(400, "Media file is required for media message mode", "VALIDATION");
  }
  if (input.messageMode === "text" && !hasText) {
    throw new AppError(400, "Reply text is required for text mode", "VALIDATION");
  }
  if (input.messageMode === "template" && !input.templateId && !hasText) {
    throw new AppError(400, "Select a template or enable OpenAI / add fallback text", "VALIDATION");
  }
}

function toJson(row: {
  id: string;
  name: string;
  keyword: string;
  triggerType: AutoReplyTriggerType;
  caseSensitive: boolean;
  deviceId: string;
  priority: number;
  cooldownMinutes: number;
  messageMode: AutoReplyMessageMode;
  templateId: string | null;
  mediaAssetId: string | null;
  mediaCaption: string | null;
  response: string;
  openAiEnabled: boolean;
  openAiSettings: Prisma.JsonValue | null;
  active: boolean;
  responseCount: number;
  createdAt: Date;
  updatedAt: Date;
  device: { name: string; phone: string | null };
  template: { name: string } | null;
}): AutoReplyRuleJson {
  return {
    id: row.id,
    name: row.name,
    keyword: row.keyword,
    triggerType: fromPrismaTriggerType(row.triggerType),
    caseSensitive: row.caseSensitive,
    deviceId: row.deviceId,
    deviceLabel: deviceLabel(row.device),
    priority: row.priority,
    cooldownMinutes: row.cooldownMinutes,
    messageMode: fromPrismaMessageMode(row.messageMode),
    templateId: row.templateId,
    templateName: row.template?.name ?? null,
    mediaAssetId: row.mediaAssetId,
    mediaCaption: row.mediaCaption,
    response: row.response,
    openAiEnabled: row.openAiEnabled,
    openAiSettings: row.openAiSettings,
    active: row.active,
    responseCount: row.responseCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const include = {
  device: { select: { name: true, phone: true } },
  template: { select: { name: true } },
} as const;

export async function listAutoReplyRules(
  workspaceId: string
): Promise<AutoReplyRuleJson[]> {
  const rows = await prisma.autoReplyRule.findMany({
    where: { workspaceId },
    include,
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });
  return rows.map(toJson);
}

export type CreateAutoReplyRuleInput = {
  name: string;
  keyword: string;
  triggerType: AutoReplyTriggerTypeApi;
  caseSensitive: boolean;
  deviceId: string;
  priority: number;
  cooldownMinutes: number;
  messageMode: AutoReplyMessageModeApi;
  templateId?: string | null;
  mediaAssetId?: string | null;
  mediaCaption?: string | null;
  response: string;
  openAiEnabled: boolean;
  openAiSettings?: unknown;
  active: boolean;
};

export async function createAutoReplyRule(
  workspaceId: string,
  input: CreateAutoReplyRuleInput
): Promise<AutoReplyRuleJson> {
  const device = await prisma.device.findFirst({
    where: { id: input.deviceId, workspaceId },
  });
  if (!device) {
    throw new AppError(404, "Device not found", "NOT_FOUND");
  }

  let templateId: string | null = null;
  if (input.templateId?.trim()) {
    const tpl = await requireActiveTemplate(workspaceId, input.templateId.trim());
    templateId = tpl.id;
  }

  let mediaAssetId: string | null = null;
  if (input.mediaAssetId?.trim()) {
    const asset = await prisma.templateMediaAsset.findFirst({
      where: { id: input.mediaAssetId.trim(), workspaceId },
    });
    if (!asset) {
      throw new AppError(404, "Media file not found", "NOT_FOUND");
    }
    mediaAssetId = asset.id;
  }

  const name = input.name.trim();
  const keyword = input.keyword.trim();
  const response = input.response.trim();
  const mediaCaption =
    input.mediaCaption?.trim() === "" ? null : input.mediaCaption?.trim().slice(0, 4096) ?? null;

  if (!name) {
    throw new AppError(400, "Rule name is required", "VALIDATION");
  }

  validateTriggers(input.triggerType, input.caseSensitive, keyword);

  assertContentRules({
    messageMode: input.messageMode,
    templateId,
    mediaAssetId,
    response,
    openAiEnabled: input.openAiEnabled,
  });

  if (input.openAiEnabled) {
    const raw = input.openAiSettings;
    const key =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as { apiKey?: unknown }).apiKey
        : undefined;
    if (typeof key !== "string" || !key.trim()) {
      throw new AppError(
        400,
        "OpenAI settings with apiKey are required when AI is enabled",
        "VALIDATION"
      );
    }
  }

  const row = await prisma.autoReplyRule.create({
    data: {
      workspaceId,
      deviceId: input.deviceId,
      name: name.slice(0, 200),
      keyword: keyword.slice(0, 8000),
      triggerType: toPrismaTriggerType(input.triggerType),
      caseSensitive: input.caseSensitive,
      priority: Math.min(1_000_000, Math.max(0, input.priority)),
      cooldownMinutes: Math.min(10_080, Math.max(0, input.cooldownMinutes)),
      messageMode: toPrismaMessageMode(input.messageMode),
      templateId,
      mediaAssetId,
      mediaCaption,
      response: response.slice(0, 4096),
      openAiEnabled: input.openAiEnabled,
      openAiSettings:
        input.openAiSettings === undefined
          ? undefined
          : (input.openAiSettings as Prisma.InputJsonValue),
      active: input.active,
    },
    include,
  });
  return toJson(row);
}

export type UpdateAutoReplyRuleInput = Partial<CreateAutoReplyRuleInput>;

export async function updateAutoReplyRule(
  workspaceId: string,
  ruleId: string,
  input: UpdateAutoReplyRuleInput
): Promise<AutoReplyRuleJson> {
  const existing = await prisma.autoReplyRule.findFirst({
    where: { id: ruleId, workspaceId },
  });
  if (!existing) {
    throw new AppError(404, "Rule not found", "NOT_FOUND");
  }

  let deviceId = existing.deviceId;
  if (input.deviceId !== undefined) {
    const device = await prisma.device.findFirst({
      where: { id: input.deviceId, workspaceId },
    });
    if (!device) {
      throw new AppError(404, "Device not found", "NOT_FOUND");
    }
    deviceId = input.deviceId;
  }

  let templateId: string | null | undefined = undefined;
  if (input.templateId !== undefined) {
    if (input.templateId === null || input.templateId === "") {
      templateId = null;
    } else {
      const tpl = await requireActiveTemplate(
        workspaceId,
        input.templateId.trim()
      );
      templateId = tpl.id;
    }
  }

  let mediaAssetId: string | null | undefined = undefined;
  if (input.mediaAssetId !== undefined) {
    if (input.mediaAssetId === null || input.mediaAssetId === "") {
      mediaAssetId = null;
    } else {
      const asset = await prisma.templateMediaAsset.findFirst({
        where: { id: input.mediaAssetId.trim(), workspaceId },
      });
      if (!asset) {
        throw new AppError(404, "Media file not found", "NOT_FOUND");
      }
      mediaAssetId = asset.id;
    }
  }

  const data: Prisma.AutoReplyRuleUpdateInput = {
    device: { connect: { id: deviceId } },
  };

  if (input.name !== undefined) {
    const t = input.name.trim();
    if (!t) throw new AppError(400, "Rule name is required", "VALIDATION");
    data.name = t.slice(0, 200);
  }
  if (input.keyword !== undefined) {
    const t = input.keyword.trim();
    const tt = input.triggerType ?? fromPrismaTriggerType(existing.triggerType);
    const cs = input.caseSensitive ?? existing.caseSensitive;
    validateTriggers(tt, cs, t);
    data.keyword = t.slice(0, 8000);
  }
  if (input.triggerType !== undefined) {
    data.triggerType = toPrismaTriggerType(input.triggerType);
  }
  if (input.caseSensitive !== undefined) {
    data.caseSensitive = input.caseSensitive;
  }
  if (input.priority !== undefined) {
    data.priority = Math.min(1_000_000, Math.max(0, input.priority));
  }
  if (input.cooldownMinutes !== undefined) {
    data.cooldownMinutes = Math.min(10_080, Math.max(0, input.cooldownMinutes));
  }
  if (input.messageMode !== undefined) {
    data.messageMode = toPrismaMessageMode(input.messageMode);
  }
  if (templateId !== undefined) {
    data.template =
      templateId === null
        ? { disconnect: true }
        : { connect: { id: templateId } };
  }
  if (mediaAssetId !== undefined) {
    data.mediaAsset =
      mediaAssetId === null
        ? { disconnect: true }
        : { connect: { id: mediaAssetId } };
  }
  if (input.mediaCaption !== undefined) {
    data.mediaCaption =
      input.mediaCaption === null || input.mediaCaption.trim() === ""
        ? null
        : input.mediaCaption.trim().slice(0, 4096);
  }
  if (input.response !== undefined) {
    data.response = input.response.trim().slice(0, 4096);
  }
  if (input.openAiEnabled !== undefined) {
    data.openAiEnabled = input.openAiEnabled;
  }
  if (input.openAiSettings !== undefined) {
    data.openAiSettings =
      input.openAiSettings === null
        ? Prisma.JsonNull
        : (input.openAiSettings as Prisma.InputJsonValue);
  }
  if (input.active !== undefined) {
    data.active = input.active;
  }

  const merged = {
    messageMode: fromPrismaMessageMode(
      input.messageMode !== undefined
        ? toPrismaMessageMode(input.messageMode)
        : existing.messageMode
    ),
    templateId:
      templateId !== undefined ? templateId : existing.templateId,
    mediaAssetId:
      mediaAssetId !== undefined ? mediaAssetId : existing.mediaAssetId,
    response:
      input.response !== undefined
        ? input.response.trim()
        : existing.response,
    openAiEnabled:
      input.openAiEnabled !== undefined
        ? input.openAiEnabled
        : existing.openAiEnabled,
  };

  assertContentRules({
    messageMode: merged.messageMode,
    templateId: merged.templateId,
    mediaAssetId: merged.mediaAssetId,
    response: merged.response,
    openAiEnabled: merged.openAiEnabled,
  });

  if (merged.openAiEnabled) {
    const settings =
      input.openAiSettings !== undefined
        ? input.openAiSettings
        : existing.openAiSettings;
    if (
      settings === null ||
      (typeof settings === "object" &&
        settings !== null &&
        (typeof (settings as { apiKey?: unknown }).apiKey !== "string" ||
          !(settings as { apiKey: string }).apiKey.trim()))
    ) {
      throw new AppError(
        400,
        "OpenAI settings with apiKey are required when AI is enabled",
        "VALIDATION"
      );
    }
  }

  const row = await prisma.autoReplyRule.update({
    where: { id: ruleId },
    data,
    include,
  });
  return toJson(row);
}

export async function deleteAutoReplyRule(
  workspaceId: string,
  ruleId: string
): Promise<void> {
  const existing = await prisma.autoReplyRule.findFirst({
    where: { id: ruleId, workspaceId },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError(404, "Rule not found", "NOT_FOUND");
  }
  await prisma.autoReplyRule.delete({ where: { id: ruleId } });
}

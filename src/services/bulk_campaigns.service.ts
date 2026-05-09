import {
  BulkCampaignStatus,
  BulkDeviceMode,
  BulkScheduleType,
  BulkSelectionMode,
  BulkUniquenessMode,
  ContactStatus,
  DeviceStatus,
  OutboundKind,
  OutboundStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../env";
import { AppError } from "../lib/errors";
import { validateAndFormatPhone } from "../lib/phone";
import { e164ToWhatsAppJid } from "../lib/whatsapp-jid";
import {
  buildBulkTextCampaignContent,
  buildTemplateWhatsAppContent,
} from "./wa-outbound-content";
import { requireActiveTemplate } from "./templates.service";
import * as waSession from "./wa-device-session.service";
import {
  antiBlockApiFromRow,
  applyPhoneFilters,
  applySpintax,
  canSendAt,
  normalizeAntiBlock,
  randomDelayMs,
  shouldStopByFailLimit,
  sleepMs,
  toJsonValue,
  type BulkAntiBlockSettings,
} from "./bulk_campaign_safety.service";

const MAX_RECIPIENTS = 2000;
const OUTBOUND_CHUNK = 250;
const SCHEDULED_POLL_MS = 15_000;
let scheduledLoopStarted = false;
let scheduledLoopBusy = false;
/** WhatsApp anti-spam: minimum pause between bulk sends (seconds). */
const WHATSAPP_MIN_DELAY_SEC = 12;

function normalizeDelayRangeSec(
  minSec: number,
  maxSec: number
): { min: number; max: number } {
  let lo = Math.min(minSec, maxSec);
  let hi = Math.max(minSec, maxSec);
  lo = Math.max(WHATSAPP_MIN_DELAY_SEC, Math.min(3600, lo));
  hi = Math.max(lo, Math.min(3600, hi));
  return { min: lo, max: hi };
}

function parseDeviceMode(
  raw: string
): BulkDeviceMode {
  switch (raw) {
    case "single":
      return BulkDeviceMode.SINGLE;
    case "failover":
      return BulkDeviceMode.FAILOVER;
    default:
      return BulkDeviceMode.ROUND_ROBIN;
  }
}

function deviceModeApi(m: BulkDeviceMode): "single" | "failover" | "round_robin" {
  switch (m) {
    case BulkDeviceMode.SINGLE:
      return "single";
    case BulkDeviceMode.FAILOVER:
      return "failover";
    default:
      return "round_robin";
  }
}

export type CreateBulkCampaignPayload = {
  name: string;
  deviceIds: string[];
  /** Load distribution across selected devices. */
  deviceMode: "single" | "failover" | "round_robin";
  kind: "text" | "template";
  bodyText?: string;
  templateId?: string;
  selectionMode: "groups" | "all_verified" | "manual";
  groupIds?: string[];
  manualPhones?: string[];
  attachmentType?: string | null;
  /** Uploaded file id from POST /v1/templates/media */
  attachmentAssetId?: string | null;
  scheduleType: "immediate" | "scheduled";
  scheduledAt?: string | null;
  /** Random delay lower bound (seconds). Server enforces min 12s. */
  delayMinSec: number;
  /** Random delay upper bound (seconds). */
  delayMaxSec: number;
  maxRetries: number;
  antiBlock?: {
    enabled?: boolean;
    spintax?: boolean;
    verifyNumbers?: boolean;
    repliedOnly?: boolean;
    recent24hOnly?: boolean;
    uniquenessMode?: "none" | "campaign" | "workspace_window";
    batchPauseEvery?: number;
    batchPauseSec?: number;
    failLimitInRow?: number;
    activeHoursStart?: string | null;
    activeHoursEnd?: string | null;
    inactiveHoursStart?: string | null;
    inactiveHoursEnd?: string | null;
  };
};

export type BulkCampaignListItemJson = {
  id: string;
  name: string;
  status: "scheduled" | "completed" | "failed" | "pending" | "running";
  kind: "text" | "template";
  selectionMode: "groups" | "all_verified" | "manual";
  deviceMode: "single" | "failover" | "round_robin";
  scheduleType: "immediate" | "scheduled";
  scheduledAt: string | null;
  recipientCount: number;
  delayMinSec: number;
  delayMaxSec: number;
  maxRetries: number;
  attachmentType: string | null;
  attachmentAssetId: string | null;
  attachmentFileName: string | null;
  antiBlock: {
    enabled: boolean;
    spintax: boolean;
    verifyNumbers: boolean;
    repliedOnly: boolean;
    recent24hOnly: boolean;
    uniquenessMode: "none" | "campaign" | "workspace_window";
    batchPauseEvery: number;
    batchPauseSec: number;
    failLimitInRow: number;
    activeHoursStart: string | null;
    activeHoursEnd: string | null;
    inactiveHoursStart: string | null;
    inactiveHoursEnd: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type BulkCampaignCreateResultJson = {
  campaign: BulkCampaignListItemJson;
  dispatchedMessages: number;
  note?: string;
};

export type BulkCampaignDeviceRowJson = {
  id: string;
  name: string;
  phone: string | null;
  status: string;
};

export type BulkCampaignDeviceSendStatsJson = {
  deviceId: string;
  deviceName: string;
  phone: string | null;
  sent: number;
  failed: number;
  queued: number;
  simulated: number;
  total: number;
};

export type BulkCampaignOutboundStatsJson = {
  targetRecipients: number;
  totalOutboundRows: number;
  sent: number;
  failed: number;
  queued: number;
  simulated: number;
  /** Rows not yet finalized (still in queue). */
  pendingInQueue: number;
  /** Target minus rows created (e.g. scheduled job not started). */
  notDispatchedYet: number;
  /** Successful WhatsApp sends (same as sent). */
  delivered: number;
  /** Read/seen is not persisted on outbound rows yet. */
  readReceiptsTracked: false;
  seenCount: null;
};

export type BulkCampaignRecentMessageJson = {
  id: string;
  toPhone: string;
  status: string;
  deviceId: string;
  deviceName: string;
  devicePhone: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export type BulkCampaignDetailJson = {
  campaign: BulkCampaignListItemJson;
  template: { id: string; name: string; typeId: string } | null;
  messagePreview: string | null;
  devices: BulkCampaignDeviceRowJson[];
  deviceSendStats: BulkCampaignDeviceSendStatsJson[];
  stats: BulkCampaignOutboundStatsJson;
  recentMessages: BulkCampaignRecentMessageJson[];
};

function parseStoredDeviceIds(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

function outboundStatusApi(s: OutboundStatus): string {
  switch (s) {
    case OutboundStatus.SENT:
      return "sent";
    case OutboundStatus.FAILED:
      return "failed";
    case OutboundStatus.QUEUED:
      return "queued";
    case OutboundStatus.SIMULATED:
      return "simulated";
    default:
      return String(s).toLowerCase();
  }
}

export async function getBulkCampaignDetail(
  workspaceId: string,
  campaignId: string
): Promise<BulkCampaignDetailJson> {
  const campaign = await prisma.bulkCampaign.findFirst({
    where: { id: campaignId, workspaceId },
    include: {
      attachmentAsset: { select: { id: true, originalName: true } },
      template: { select: { id: true, name: true, typeId: true } },
    },
  });
  if (!campaign) {
    throw new AppError(404, "Campaign not found", "NOT_FOUND");
  }

  const storedIds = parseStoredDeviceIds(campaign.deviceIds);
  const uniqueDeviceIds = [...new Set(storedIds)];
  const deviceRows = await prisma.device.findMany({
    where: { workspaceId, id: { in: uniqueDeviceIds.length ? uniqueDeviceIds : [] } },
    select: { id: true, name: true, phone: true, status: true },
  });
  const deviceById = new Map(deviceRows.map((d) => [d.id, d]));
  const devices: BulkCampaignDeviceRowJson[] = uniqueDeviceIds.map((id) => {
    const d = deviceById.get(id);
    return {
      id,
      name: d?.name ?? "Unknown device",
      phone: d?.phone ?? null,
      status: d ? String(d.status) : "UNKNOWN",
    };
  });

  const statusGroups = await prisma.outboundMessage.groupBy({
    by: ["status"],
    where: { bulkCampaignId: campaignId, workspaceId },
    _count: { _all: true },
  });

  const countFor = (st: OutboundStatus) =>
    statusGroups.find((g) => g.status === st)?._count._all ?? 0;

  const sent = countFor(OutboundStatus.SENT);
  const failed = countFor(OutboundStatus.FAILED);
  const queued = countFor(OutboundStatus.QUEUED);
  const simulated = countFor(OutboundStatus.SIMULATED);
  const totalOutboundRows = sent + failed + queued + simulated;

  const targetRecipients = campaign.recipientCount;
  const notDispatchedYet = Math.max(0, targetRecipients - totalOutboundRows);

  const devStatusGroups = await prisma.outboundMessage.groupBy({
    by: ["deviceId", "status"],
    where: { bulkCampaignId: campaignId, workspaceId },
    _count: { _all: true },
  });

  const perDevice = new Map<
    string,
    { sent: number; failed: number; queued: number; simulated: number }
  >();
  for (const id of uniqueDeviceIds) {
    perDevice.set(id, { sent: 0, failed: 0, queued: 0, simulated: 0 });
  }
  for (const g of devStatusGroups) {
    const cur = perDevice.get(g.deviceId) ?? {
      sent: 0,
      failed: 0,
      queued: 0,
      simulated: 0,
    };
    const n = g._count._all;
    if (g.status === OutboundStatus.SENT) cur.sent += n;
    else if (g.status === OutboundStatus.FAILED) cur.failed += n;
    else if (g.status === OutboundStatus.QUEUED) cur.queued += n;
    else if (g.status === OutboundStatus.SIMULATED) cur.simulated += n;
    perDevice.set(g.deviceId, cur);
  }

  const deviceSendStats: BulkCampaignDeviceSendStatsJson[] = uniqueDeviceIds.map(
    (deviceId) => {
      const d = deviceById.get(deviceId);
      const s = perDevice.get(deviceId) ?? {
        sent: 0,
        failed: 0,
        queued: 0,
        simulated: 0,
      };
      const total = s.sent + s.failed + s.queued + s.simulated;
      return {
        deviceId,
        deviceName: d?.name ?? "Unknown device",
        phone: d?.phone ?? null,
        sent: s.sent,
        failed: s.failed,
        queued: s.queued,
        simulated: s.simulated,
        total,
      };
    }
  );

  const recent = await prisma.outboundMessage.findMany({
    where: { bulkCampaignId: campaignId, workspaceId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      device: { select: { name: true, phone: true } },
    },
  });

  const recentMessages: BulkCampaignRecentMessageJson[] = recent.map((r) => ({
    id: r.id,
    toPhone: r.toPhone,
    status: outboundStatusApi(r.status),
    deviceId: r.deviceId,
    deviceName: r.device.name,
    devicePhone: r.device.phone,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
  }));

  const messagePreview =
    campaign.kind === OutboundKind.TEXT
      ? (campaign.bodyText?.trim().slice(0, 500) ?? null)
      : null;

  const stats: BulkCampaignOutboundStatsJson = {
    targetRecipients,
    totalOutboundRows,
    sent,
    failed,
    queued,
    simulated,
    pendingInQueue: queued,
    notDispatchedYet,
    delivered: sent,
    readReceiptsTracked: false,
    seenCount: null,
  };

  return {
    campaign: toListItem({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      kind: campaign.kind,
      selectionMode: campaign.selectionMode,
      deviceMode: campaign.deviceMode,
      scheduleType: campaign.scheduleType,
      scheduledAt: campaign.scheduledAt,
      recipientCount: campaign.recipientCount,
      delayMinSec: campaign.delayMinSec,
      delayMaxSec: campaign.delayMaxSec,
      maxRetries: campaign.maxRetries,
      attachmentType: campaign.attachmentType,
      attachmentAssetId: campaign.attachmentAssetId,
      attachmentAsset: campaign.attachmentAsset,
      antiBlockEnabled: campaign.antiBlockEnabled,
      spintaxEnabled: campaign.spintaxEnabled,
      verifyNumbers: campaign.verifyNumbers,
      repliedOnly: campaign.repliedOnly,
      recent24hOnly: campaign.recent24hOnly,
      uniquenessMode: campaign.uniquenessMode,
      batchPauseEvery: campaign.batchPauseEvery,
      batchPauseSec: campaign.batchPauseSec,
      failLimitInRow: campaign.failLimitInRow,
      activeHoursStart: campaign.activeHoursStart,
      activeHoursEnd: campaign.activeHoursEnd,
      inactiveHoursStart: campaign.inactiveHoursStart,
      inactiveHoursEnd: campaign.inactiveHoursEnd,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
    }),
    template: campaign.template
      ? {
          id: campaign.template.id,
          name: campaign.template.name,
          typeId: campaign.template.typeId,
        }
      : null,
    messagePreview,
    devices,
    deviceSendStats,
    stats,
    recentMessages,
  };
}

function statusApi(s: BulkCampaignStatus): BulkCampaignListItemJson["status"] {
  switch (s) {
    case BulkCampaignStatus.FAILED:
      return "failed";
    case BulkCampaignStatus.COMPLETED:
      return "completed";
    default:
      return "scheduled";
  }
}

function selectionApi(m: BulkSelectionMode): BulkCampaignListItemJson["selectionMode"] {
  switch (m) {
    case BulkSelectionMode.ALL_VERIFIED:
      return "all_verified";
    case BulkSelectionMode.MANUAL:
      return "manual";
    default:
      return "groups";
  }
}

function scheduleApi(t: BulkScheduleType): BulkCampaignListItemJson["scheduleType"] {
  return t === BulkScheduleType.SCHEDULED ? "scheduled" : "immediate";
}

function toListItem(row: {
  id: string;
  name: string;
  status: BulkCampaignStatus;
  kind: OutboundKind;
  selectionMode: BulkSelectionMode;
  deviceMode: BulkDeviceMode;
  scheduleType: BulkScheduleType;
  scheduledAt: Date | null;
  recipientCount: number;
  delayMinSec: number;
  delayMaxSec: number;
  maxRetries: number;
  attachmentType: string | null;
  attachmentAssetId: string | null;
  attachmentAsset: { id: string; originalName: string } | null;
  antiBlockEnabled: boolean;
  spintaxEnabled: boolean;
  verifyNumbers: boolean;
  repliedOnly: boolean;
  recent24hOnly: boolean;
  uniquenessMode: BulkUniquenessMode;
  batchPauseEvery: number;
  batchPauseSec: number;
  failLimitInRow: number;
  activeHoursStart: string | null;
  activeHoursEnd: string | null;
  inactiveHoursStart: string | null;
  inactiveHoursEnd: string | null;
  createdAt: Date;
  updatedAt: Date;
}): BulkCampaignListItemJson {
  return {
    id: row.id,
    name: row.name,
    status: statusApi(row.status),
    kind: row.kind === OutboundKind.TEXT ? "text" : "template",
    selectionMode: selectionApi(row.selectionMode),
    deviceMode: deviceModeApi(row.deviceMode),
    scheduleType: scheduleApi(row.scheduleType),
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    recipientCount: row.recipientCount,
    delayMinSec: row.delayMinSec,
    delayMaxSec: row.delayMaxSec,
    maxRetries: row.maxRetries,
    attachmentType: row.attachmentType,
    attachmentAssetId: row.attachmentAssetId,
    attachmentFileName: row.attachmentAsset?.originalName ?? null,
    antiBlock: antiBlockApiFromRow(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function resolveRecipientPhones(
  workspaceId: string,
  mode: BulkSelectionMode,
  groupIds: string[] | undefined,
  manualPhones: string[] | undefined
): Promise<string[]> {
  const set = new Set<string>();

  if (mode === BulkSelectionMode.GROUPS) {
    if (!groupIds?.length) {
      throw new AppError(400, "Select at least one contact group", "VALIDATION");
    }
    const groups = await prisma.contactGroup.findMany({
      where: { id: { in: groupIds }, workspaceId },
      select: { id: true },
    });
    if (groups.length !== groupIds.length) {
      throw new AppError(400, "One or more groups were not found", "VALIDATION");
    }
    const rows = await prisma.contact.findMany({
      where: {
        groupId: { in: groupIds },
        status: ContactStatus.VERIFIED,
        group: { workspaceId },
      },
      select: { phone: true },
    });
    for (const r of rows) {
      set.add(r.phone);
    }
  } else if (mode === BulkSelectionMode.ALL_VERIFIED) {
    const rows = await prisma.contact.findMany({
      where: {
        status: ContactStatus.VERIFIED,
        group: { workspaceId },
      },
      select: { phone: true },
    });
    for (const r of rows) {
      set.add(r.phone);
    }
  } else {
    const lines = manualPhones ?? [];
    if (!lines.length) {
      throw new AppError(
        400,
        "Enter at least one phone number for manual selection",
        "VALIDATION"
      );
    }
    for (const line of lines) {
      const v = validateAndFormatPhone(line);
      if (v.valid) {
        set.add(v.e164);
      }
    }
  }

  const phones = [...set];
  if (phones.length === 0) {
    throw new AppError(
      400,
      "No valid recipients. For groups / all verified, ensure you have verified contacts.",
      "NO_RECIPIENTS"
    );
  }
  if (phones.length > MAX_RECIPIENTS) {
    throw new AppError(
      400,
      `Too many recipients (max ${MAX_RECIPIENTS} per campaign)`,
      "LIMIT_EXCEEDED"
    );
  }
  return phones;
}

async function assertDevices(
  workspaceId: string,
  deviceIds: string[]
): Promise<{ id: string }[]> {
  const devices = await prisma.device.findMany({
    where: { id: { in: deviceIds }, workspaceId },
  });
  if (devices.length !== deviceIds.length) {
    throw new AppError(400, "One or more devices were not found", "VALIDATION");
  }
  const notConnected = devices.filter((d) => d.status !== DeviceStatus.CONNECTED);
  if (notConnected.length > 0) {
    throw new AppError(
      400,
      "All selected devices must be connected before sending",
      "DEVICE_NOT_CONNECTED"
    );
  }
  return devices;
}

export async function listBulkCampaigns(
  workspaceId: string
): Promise<BulkCampaignListItemJson[]> {
  const rows = await prisma.bulkCampaign.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: {
      attachmentAsset: { select: { id: true, originalName: true } },
    },
  });
  return rows.map((r) =>
    toListItem({
      ...r,
      attachmentAssetId: r.attachmentAssetId,
    })
  );
}

export async function createBulkCampaign(
  workspaceId: string,
  payload: CreateBulkCampaignPayload
): Promise<BulkCampaignCreateResultJson> {
  const name = payload.name.trim();
  if (!name) {
    throw new AppError(400, "Campaign name is required", "VALIDATION");
  }

  const selectionMode =
    payload.selectionMode === "all_verified"
      ? BulkSelectionMode.ALL_VERIFIED
      : payload.selectionMode === "manual"
        ? BulkSelectionMode.MANUAL
        : BulkSelectionMode.GROUPS;

  const scheduleType =
    payload.scheduleType === "scheduled"
      ? BulkScheduleType.SCHEDULED
      : BulkScheduleType.IMMEDIATE;

  let scheduledAt: Date | null = null;
  if (scheduleType === BulkScheduleType.SCHEDULED) {
    if (!payload.scheduledAt?.trim()) {
      throw new AppError(400, "Scheduled time is required", "VALIDATION");
    }
    scheduledAt = new Date(payload.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new AppError(400, "Invalid scheduled time", "VALIDATION");
    }
  }

  const basePhones = await resolveRecipientPhones(
    workspaceId,
    selectionMode,
    payload.groupIds,
    payload.manualPhones
  );
  const antiBlock = normalizeAntiBlock(payload.antiBlock);
  const phones = await applyPhoneFilters(workspaceId, basePhones, antiBlock);
  if (phones.length === 0) {
    throw new AppError(
      400,
      "No recipients remain after anti-block filters",
      "NO_RECIPIENTS"
    );
  }

  await assertDevices(workspaceId, payload.deviceIds);

  const deviceModeEnum = parseDeviceMode(payload.deviceMode);
  if (deviceModeEnum === BulkDeviceMode.SINGLE && payload.deviceIds.length !== 1) {
    throw new AppError(
      400,
      "Single device mode requires exactly one selected device",
      "VALIDATION"
    );
  }

  const delayNorm = normalizeDelayRangeSec(
    payload.delayMinSec,
    payload.delayMaxSec
  );

  let templateId: string | null = null;
  let bodyText: string | null = null;
  let kind: OutboundKind;

  if (payload.kind === "text") {
    const text = payload.bodyText?.trim() ?? "";
    if (!text) {
      throw new AppError(400, "Message text is required", "VALIDATION");
    }
    if (text.length > 4096) {
      throw new AppError(400, "Message is too long (max 4096 characters)", "VALIDATION");
    }
    bodyText = text;
    kind = OutboundKind.TEXT;
  } else {
    if (!payload.templateId) {
      throw new AppError(400, "Template is required", "VALIDATION");
    }
    const tpl = await requireActiveTemplate(workspaceId, payload.templateId);
    templateId = tpl.id;
    kind = OutboundKind.TEMPLATE;
  }

  const deviceIdsJson = payload.deviceIds as unknown as Prisma.InputJsonValue;
  const recipientPhonesJson = toJsonValue(phones);

  const attachmentType =
    payload.attachmentType?.trim() === ""
      ? null
      : payload.attachmentType?.trim().slice(0, 32) ?? null;

  let attachmentAssetId: string | null = null;
  const rawAsset = payload.attachmentAssetId?.trim();
  if (rawAsset) {
    const asset = await prisma.templateMediaAsset.findFirst({
      where: { id: rawAsset, workspaceId },
    });
    if (!asset) {
      throw new AppError(404, "Attachment file not found", "NOT_FOUND");
    }
    attachmentAssetId = asset.id;
  }

  const initialStatus =
    scheduleType === BulkScheduleType.IMMEDIATE
      ? BulkCampaignStatus.PENDING
      : BulkCampaignStatus.SCHEDULED;

  const campaign = await prisma.bulkCampaign.create({
    data: {
      workspaceId,
      name: name.slice(0, 200),
      kind,
      bodyText,
      templateId,
      deviceIds: deviceIdsJson,
      selectionMode,
      ...(payload.groupIds && payload.groupIds.length > 0
        ? {
            groupIds: payload.groupIds as unknown as Prisma.InputJsonValue,
          }
        : {}),
      recipientPhones: recipientPhonesJson,
      recipientCount: phones.length,
      attachmentType,
      attachmentAssetId,
      scheduleType,
      scheduledAt,
      deviceMode: deviceModeEnum,
      delayMinSec: delayNorm.min,
      delayMaxSec: delayNorm.max,
      maxRetries: payload.maxRetries,
      antiBlockEnabled: antiBlock.enabled,
      spintaxEnabled: antiBlock.spintaxEnabled,
      verifyNumbers: antiBlock.verifyNumbers,
      repliedOnly: antiBlock.repliedOnly,
      recent24hOnly: antiBlock.recent24hOnly,
      uniquenessMode: antiBlock.uniquenessMode,
      batchPauseEvery: antiBlock.batchPauseEvery,
      batchPauseSec: antiBlock.batchPauseSec,
      failLimitInRow: antiBlock.failLimitInRow,
      activeHoursStart: antiBlock.activeHoursStart,
      activeHoursEnd: antiBlock.activeHoursEnd,
      inactiveHoursStart: antiBlock.inactiveHoursStart,
      inactiveHoursEnd: antiBlock.inactiveHoursEnd,
      status: initialStatus,
    },
  });

  // let dispatched = 0;
  // if (scheduleType === BulkScheduleType.IMMEDIATE) {
  //   dispatched = await executeCampaignDispatch({
  //     campaignId: campaign.id,
  //     workspaceId,
  //     phones,
  //     deviceIds: payload.deviceIds,
  //     deviceMode: deviceModeEnum,
  //     kind,
  //     bodyText,
  //     templateId,
  //     attachmentType,
  //     attachmentAssetId,
  //     delayMinSec: delayNorm.min,
  //     delayMaxSec: delayNorm.max,
  //     maxRetries: Math.max(0, payload.maxRetries),
  //     antiBlock,
  //   });
  //   await prisma.bulkCampaign.update({
  //     where: { id: campaign.id },
  //     data: { status: BulkCampaignStatus.COMPLETED },
  //   });
  // }

  let dispatched = 0;

if (scheduleType === BulkScheduleType.IMMEDIATE) {
  // set pending first
  await prisma.bulkCampaign.update({
    where: { id: campaign.id },
    data: {
      status: BulkCampaignStatus.PENDING,
    },
  });

  // background processing
  setImmediate(async () => {
    try {
      await prisma.bulkCampaign.update({
        where: { id: campaign.id },
        data: {
          status: BulkCampaignStatus.RUNNING,
        },
      });

      const total = await executeCampaignDispatch({
        campaignId: campaign.id,
        workspaceId,
        phones,
        deviceIds: payload.deviceIds,
        deviceMode: deviceModeEnum,
        kind,
        bodyText,
        templateId,
        attachmentType,
        attachmentAssetId,
        delayMinSec: delayNorm.min,
        delayMaxSec: delayNorm.max,
        maxRetries: Math.max(0, payload.maxRetries),
        antiBlock,
      });

      await prisma.bulkCampaign.update({
        where: { id: campaign.id },
        data: {
          status: BulkCampaignStatus.COMPLETED,
        },
      });

      console.log(
        `Campaign ${campaign.id} completed with ${total} messages`
      );
    } catch (error) {
      console.error("Campaign execution failed:", error);

      await prisma.bulkCampaign.update({
        where: { id: campaign.id },
        data: {
          status: BulkCampaignStatus.FAILED,
        },
      });
    }
  });
}

  const refreshed = await prisma.bulkCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    include: {
      attachmentAsset: { select: { id: true, originalName: true } },
    },
  });

  const note =
    scheduleType === BulkScheduleType.SCHEDULED
      ? "Campaign saved as scheduled. A background worker can read scheduled campaigns and enqueue sends when you connect delivery."
      : env.WHATSAPP_BRIDGE_ENABLED
        ? "Immediate campaign: WhatsApp sends were attempted per recipient. Check outbound rows for any failures."
        : "Bridge is off: messages recorded as simulated per recipient. Set WHATSAPP_BRIDGE_ENABLED=true and use connected devices for real delivery.";

  return {
    campaign: toListItem({
      ...refreshed,
      attachmentAssetId: refreshed.attachmentAssetId,
    }),
    dispatchedMessages: dispatched,
    note,
  };
}

type ExecuteCampaignArgs = {
  campaignId: string;
  workspaceId: string;
  phones: string[];
  deviceIds: string[];
  deviceMode: BulkDeviceMode;
  kind: OutboundKind;
  bodyText: string | null;
  templateId: string | null;
  attachmentType: string | null;
  attachmentAssetId: string | null;
  delayMinSec: number;
  delayMaxSec: number;
  maxRetries: number;
  antiBlock: BulkAntiBlockSettings;
};

async function executeCampaignDispatch(args: ExecuteCampaignArgs): Promise<number> {
  const {
    campaignId,
    workspaceId,
    phones,
    deviceIds,
    deviceMode,
    kind,
    bodyText,
    templateId,
    attachmentType,
    attachmentAssetId,
    delayMinSec,
    delayMaxSec,
    maxRetries,
    antiBlock,
  } = args;
  let dispatched = 0;
  let consecutiveFailures = 0;

  async function waitUntilSendAllowed(): Promise<void> {
    while (antiBlock.enabled && !canSendAt(new Date(), antiBlock)) {
      await sleepMs(30_000);
    }
  }

  const templateRow =
    kind === OutboundKind.TEMPLATE && templateId
      ? await prisma.messageTemplate.findFirst({
          where: { id: templateId, workspaceId },
        })
      : null;
  if (kind === OutboundKind.TEMPLATE && !templateRow) {
    throw new AppError(404, "Template not found", "NOT_FOUND");
  }

  if (!env.WHATSAPP_BRIDGE_ENABLED) {
    for (let i = 0; i < phones.length; i += OUTBOUND_CHUNK) {
      const slice = phones.slice(i, i + OUTBOUND_CHUNK);
      const rows: Prisma.OutboundMessageCreateManyInput[] = slice.map((toPhone, j) => {
        const globalIdx = i + j;
        const devId =
          deviceMode === BulkDeviceMode.ROUND_ROBIN
            ? deviceIds[globalIdx % deviceIds.length]!
            : deviceIds[0]!;
        return {
          workspaceId,
          deviceId: devId,
          toPhone,
          kind,
          bodyText,
          templateId,
          bulkCampaignId: campaignId,
          status: OutboundStatus.SIMULATED,
          providerRef: "bulk:demo:no_provider",
          errorMessage: antiBlock.enabled
            ? "Simulated mode: anti-block send-time checks are not executed."
            : null,
        };
      });
      await prisma.outboundMessage.createMany({ data: rows });
      dispatched += rows.length;
    }
    return dispatched;
  }

  for (let i = 0; i < phones.length; i++) {
    await waitUntilSendAllowed();
    if (shouldStopByFailLimit(consecutiveFailures, antiBlock)) {
      break;
    }

    const toPhone = phones[i]!;
    const primaryDeviceId =
      deviceMode === BulkDeviceMode.ROUND_ROBIN
        ? deviceIds[i % deviceIds.length]!
        : deviceIds[0]!;

    const personalizedText =
      kind === OutboundKind.TEXT
        ? antiBlock.enabled && antiBlock.spintaxEnabled
          ? applySpintax(bodyText ?? "")
          : bodyText ?? ""
        : null;

    const row = await prisma.outboundMessage.create({
      data: {
        workspaceId,
        deviceId: primaryDeviceId,
        toPhone,
        kind,
        bodyText: personalizedText ?? bodyText,
        templateId,
        bulkCampaignId: campaignId,
        status: OutboundStatus.QUEUED,
      },
    });

    try {
      let jid: string;
      try {
        jid = e164ToWhatsAppJid(toPhone);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Invalid phone";
        throw new Error(msg);
      }

      const outgoing =
        kind === OutboundKind.TEXT
          ? await buildBulkTextCampaignContent(
              workspaceId,
              personalizedText ?? "",
              attachmentType,
              attachmentAssetId
            )
          : await buildTemplateWhatsAppContent(workspaceId, templateRow!);

      const trySend = async (devId: string) => {
        const sock = await waSession.waitForOpenWaSocket(devId, workspaceId);
        if (!sock) {
          throw new Error("WhatsApp session offline — open Devices and reconnect.");
        }
        return sock.sendMessage(jid, outgoing);
      };

      let usedDeviceId = primaryDeviceId;
      let waMsg: Awaited<ReturnType<typeof trySend>> | null = null;
      let attempts = 0;
      let lastErr: Error | null = null;
      const retries = Math.max(0, maxRetries);
      while (attempts <= retries && waMsg === null) {
        attempts += 1;
        if (deviceMode === BulkDeviceMode.FAILOVER) {
          for (const devId of deviceIds) {
            try {
              waMsg = await trySend(devId);
              usedDeviceId = devId;
              break;
            } catch (e) {
              lastErr = e instanceof Error ? e : new Error(String(e));
            }
          }
        } else {
          try {
            waMsg = await trySend(primaryDeviceId);
          } catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
          }
        }
      }
      if (!waMsg) {
        throw lastErr ?? new Error("All send attempts failed");
      }

      const key = waMsg.key;
      const providerRef = key?.id ? `${key.remoteJid ?? jid}:${key.id}` : "baileys:bulk";
      const summaryText =
        kind === OutboundKind.TEXT
          ? (personalizedText ?? "").trim()
          : templateRow!.body?.trim() || templateRow!.name.trim() || "(template)";

      await prisma.outboundMessage.update({
        where: { id: row.id },
        data: {
          deviceId: usedDeviceId,
          status: OutboundStatus.SENT,
          providerRef,
          ...(kind === OutboundKind.TEMPLATE ? { bodyText: summaryText.slice(0, 4096) } : {}),
        },
      });
      consecutiveFailures = 0;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await prisma.outboundMessage.update({
        where: { id: row.id },
        data: {
          status: OutboundStatus.FAILED,
          errorMessage: msg.slice(0, 500),
        },
      });
      consecutiveFailures += 1;
    }

    dispatched += 1;
    if (antiBlock.enabled && dispatched % antiBlock.batchPauseEvery === 0) {
      await sleepMs(antiBlock.batchPauseSec * 1000);
    } else if (i < phones.length - 1) {
      await sleepMs(randomDelayMs(delayMinSec, delayMaxSec));
    }
  }

  return dispatched;
}

function parseStoredPhones(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

export async function runScheduledCampaignsOnce(): Promise<number> {
  if (scheduledLoopBusy) return 0;
  scheduledLoopBusy = true;
  try {
    const now = new Date();
    const due = await prisma.bulkCampaign.findMany({
      where: {
        status: BulkCampaignStatus.SCHEDULED,
        scheduleType: BulkScheduleType.SCHEDULED,
        scheduledAt: { lte: now },
      },
      orderBy: { scheduledAt: "asc" },
      take: 5,
    });

    let processed = 0;
    for (const campaign of due) {
      const phones = await applyPhoneFilters(
        campaign.workspaceId,
        parseStoredPhones(campaign.recipientPhones),
        {
          enabled: campaign.antiBlockEnabled,
          spintaxEnabled: campaign.spintaxEnabled,
          verifyNumbers: campaign.verifyNumbers,
          repliedOnly: campaign.repliedOnly,
          recent24hOnly: campaign.recent24hOnly,
          uniquenessMode: campaign.uniquenessMode,
          batchPauseEvery: campaign.batchPauseEvery,
          batchPauseSec: campaign.batchPauseSec,
          failLimitInRow: campaign.failLimitInRow,
          activeHoursStart: campaign.activeHoursStart,
          activeHoursEnd: campaign.activeHoursEnd,
          inactiveHoursStart: campaign.inactiveHoursStart,
          inactiveHoursEnd: campaign.inactiveHoursEnd,
        }
      );

      await executeCampaignDispatch({
        campaignId: campaign.id,
        workspaceId: campaign.workspaceId,
        phones,
        deviceIds: parseStoredDeviceIds(campaign.deviceIds),
        deviceMode: campaign.deviceMode,
        kind: campaign.kind,
        bodyText: campaign.bodyText,
        templateId: campaign.templateId,
        attachmentType: campaign.attachmentType,
        attachmentAssetId: campaign.attachmentAssetId,
        delayMinSec: campaign.delayMinSec,
        delayMaxSec: campaign.delayMaxSec,
        maxRetries: campaign.maxRetries,
        antiBlock: {
          enabled: campaign.antiBlockEnabled,
          spintaxEnabled: campaign.spintaxEnabled,
          verifyNumbers: campaign.verifyNumbers,
          repliedOnly: campaign.repliedOnly,
          recent24hOnly: campaign.recent24hOnly,
          uniquenessMode: campaign.uniquenessMode,
          batchPauseEvery: campaign.batchPauseEvery,
          batchPauseSec: campaign.batchPauseSec,
          failLimitInRow: campaign.failLimitInRow,
          activeHoursStart: campaign.activeHoursStart,
          activeHoursEnd: campaign.activeHoursEnd,
          inactiveHoursStart: campaign.inactiveHoursStart,
          inactiveHoursEnd: campaign.inactiveHoursEnd,
        },
      });
      await prisma.bulkCampaign.update({
        where: { id: campaign.id },
        data: { status: BulkCampaignStatus.COMPLETED },
      });
      processed += 1;
    }
    return processed;
  } catch (err) {
    console.error("[bulk-campaigns] scheduled worker error", err);
    return 0;
  } finally {
    scheduledLoopBusy = false;
  }
}

export function startBulkCampaignScheduledWorker(): void {
  if (scheduledLoopStarted) return;
  scheduledLoopStarted = true;
  setInterval(() => {
    void runScheduledCampaignsOnce();
  }, SCHEDULED_POLL_MS);
}

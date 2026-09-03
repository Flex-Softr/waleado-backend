import {
  BulkCampaign,
  BulkCampaignRecipientStatus,
  BulkCampaignStatus,
  BulkDeviceMode,
  BulkScheduleType,
  BulkSelectionMode,
  BulkUniquenessMode,
  ContactStatus,
  DeviceStatus,
  NotificationAudience,
  NotificationType,
  OutboundKind,
  OutboundStatus,
  Prisma,
} from "@prisma/client";
import * as XLSX from "xlsx";
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
  filterVerifiedFromContacts,
  normalizeAntiBlock,
  randomDelayMs,
  shouldStopByFailLimit,
  sleepMs,
  toJsonValue,
  type BulkAntiBlockSettings,
} from "./bulk_campaign_safety.service";
import {
  DeviceDailyCapExceededError,
  WA_DEVICE_BULK_MIN_GAP_MS,
  WA_DEVICE_DAILY_SEND_CAP,
  withDeviceOutboundGate,
} from "../lib/wa-device-outbound-gate";
import { maxBulkMessageContentsForPlan } from "../lib/plan-limits";
import { enforceSslCommerzPeriodExpiry } from "./billing.service";
import {
  generateAiRewriteVariants,
  normalizeBodyTexts,
  parseStoredBodyTexts,
  pickBodyTextForRecipient,
  type BulkAiRewriteInput,
} from "./bulk_message_variants.service";
import { createNotification } from "./notifications.service";

const MAX_RECIPIENTS = 2000;
const OUTBOUND_CHUNK = 250;
const SCHEDULED_POLL_MS = 15_000;
const FAILOVER_DEVICE_GAP_MS = 5_000;
let scheduledLoopStarted = false;
let scheduledInterval: NodeJS.Timeout | null = null;
let isShuttingDown = false;
const activeCampaignIds = new Set<string>();
/** WhatsApp anti-spam: minimum pause between bulk sends (seconds). */
const WHATSAPP_MIN_DELAY_SEC = Math.ceil(WA_DEVICE_BULK_MIN_GAP_MS / 1000);

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
  /** @deprecated Prefer bodyTexts; kept for backward compatibility. */
  bodyText?: string;
  /** Custom message contents (plan-capped; AI rewrites append to this pool). */
  bodyTexts?: string[];
  templateId?: string;
  selectionMode: "groups" | "all_verified" | "manual";
  groupIds?: string[];
  manualPhones?: string[];
  attachmentType?: string | null;
  /** Uploaded file id from POST /v1/templates/media */
  attachmentAssetId?: string | null;
  scheduleType: "immediate" | "scheduled";
  scheduledAt?: string | null;
  /** Random delay lower bound (seconds). Server enforces min 15s. */
  delayMinSec: number;
  /** Random delay upper bound (seconds). */
  delayMaxSec: number;
  maxRetries: number;
  /** Generate AI rewrite variants at create time (TEXT only). */
  aiRewrite?: BulkAiRewriteInput;
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
    timezone?: string | null;
  };
};

export type BulkCampaignListItemJson = {
  id: string;
  name: string;
  status: "scheduled" | "completed" | "failed" | "pending" | "running" | "paused";
  kind: "text" | "template";
  selectionMode: "groups" | "all_verified" | "manual";
  deviceMode: "single" | "failover" | "round_robin";
  scheduleType: "immediate" | "scheduled";
  scheduledAt: string | null;
  timezone: string | null;
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
    timezone: string | null;
  };
  progress: {
    sent: number;
    failed: number;
    pending: number;
    sending: number;
    replied: number;
    total: number;
    percent: number;
    etaSeconds: number | null;
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
  delivered: number;
  seen: number;
  replied: number;
  noReply: number;
  /** Rows not yet finalized (still in queue). */
  pendingInQueue: number;
  /** Target minus rows created (e.g. scheduled job not started). */
  notDispatchedYet: number;
  readReceiptsTracked: true;
  seenCount: number;
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

export type BulkCampaignRecipientJson = {
  id: string;
  phone: string;
  status: "pending" | "queued" | "sending" | "sent" | "failed" | "simulated" | "skipped" | "canceled";
  deviceId: string | null;
  deviceName: string | null;
  attempts: number;
  lastError: string | null;
  queuedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  seenAt: string | null;
  repliedAt: string | null;
  lastReplyAt: string | null;
  lastReplyText: string | null;
  failedAt: string | null;
  createdAt: string;
};

export type BulkCampaignReportResult = {
  filename: string;
  contentType: string;
  body: Buffer;
};

export type BulkCampaignRecipientStatusApi = BulkCampaignRecipientJson["status"];
export type BulkCampaignRecipientAudienceApi =
  | "failed"
  | "replied"
  | "no_reply"
  | "seen_no_reply";

export type BulkCampaignDetailJson = {
  campaign: BulkCampaignListItemJson;
  template: { id: string; name: string; typeId: string } | null;
  messagePreview: string | null;
  /** Final TEXT message pool (custom + AI). Empty/null for template campaigns. */
  bodyTexts: string[] | null;
  devices: BulkCampaignDeviceRowJson[];
  deviceSendStats: BulkCampaignDeviceSendStatsJson[];
  stats: BulkCampaignOutboundStatsJson;
  recentMessages: BulkCampaignRecentMessageJson[];
  recentRecipients: BulkCampaignRecipientJson[];
};

function recipientStatusApi(
  s: BulkCampaignRecipientStatus
): BulkCampaignRecipientJson["status"] {
  switch (s) {
    case BulkCampaignRecipientStatus.QUEUED:
      return "queued";
    case BulkCampaignRecipientStatus.SENDING:
      return "sending";
    case BulkCampaignRecipientStatus.SENT:
      return "sent";
    case BulkCampaignRecipientStatus.FAILED:
      return "failed";
    case BulkCampaignRecipientStatus.SIMULATED:
      return "simulated";
    case BulkCampaignRecipientStatus.SKIPPED:
      return "skipped";
    case BulkCampaignRecipientStatus.CANCELED:
      return "canceled";
    case BulkCampaignRecipientStatus.PENDING:
    default:
      return "pending";
  }
}

function recipientStatusFromApi(
  status: BulkCampaignRecipientStatusApi
): BulkCampaignRecipientStatus {
  switch (status) {
    case "queued":
      return BulkCampaignRecipientStatus.QUEUED;
    case "sending":
      return BulkCampaignRecipientStatus.SENDING;
    case "sent":
      return BulkCampaignRecipientStatus.SENT;
    case "failed":
      return BulkCampaignRecipientStatus.FAILED;
    case "simulated":
      return BulkCampaignRecipientStatus.SIMULATED;
    case "skipped":
      return BulkCampaignRecipientStatus.SKIPPED;
    case "canceled":
      return BulkCampaignRecipientStatus.CANCELED;
    case "pending":
    default:
      return BulkCampaignRecipientStatus.PENDING;
  }
}

function parseStoredDeviceIds(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

function assignedDeviceForRecipient(
  index: number,
  deviceIds: string[],
  deviceMode: BulkDeviceMode
): string {
  if (deviceMode === BulkDeviceMode.ROUND_ROBIN) {
    return deviceIds[index % deviceIds.length]!;
  }
  return deviceIds[0]!;
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

  const recipientStatusGroups = await prisma.bulkCampaignRecipient.groupBy({
    by: ["status"],
    where: { campaignId, workspaceId },
    _count: { _all: true },
  });
  const recipientSnapshotCount = recipientStatusGroups.reduce(
    (acc, group) => acc + group._count._all,
    0
  );
  const recipientCountFor = (st: BulkCampaignRecipientStatus) =>
    recipientStatusGroups.find((g) => g.status === st)?._count._all ?? 0;

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

  const recentRecipientRows = await prisma.bulkCampaignRecipient.findMany({
    where: { campaignId, workspaceId },
    orderBy: { createdAt: "asc" },
    take: 100,
    include: {
      device: { select: { name: true } },
    },
  });

  const recentRecipients: BulkCampaignRecipientJson[] = recentRecipientRows.map(
    (r) => ({
      id: r.id,
      phone: r.phone,
      status: recipientStatusApi(r.status),
      deviceId: r.deviceId,
      deviceName: r.device?.name ?? null,
      attempts: r.attempts,
      lastError: r.lastError,
      queuedAt: r.queuedAt?.toISOString() ?? null,
      sentAt: r.sentAt?.toISOString() ?? null,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      seenAt: r.seenAt?.toISOString() ?? null,
      repliedAt: r.repliedAt?.toISOString() ?? null,
      lastReplyAt: r.lastReplyAt?.toISOString() ?? null,
      lastReplyText: r.lastReplyText,
      failedAt: r.failedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })
  );

  const bodyTextsPool =
    campaign.kind === OutboundKind.TEXT
      ? parseStoredBodyTexts(campaign.bodyTexts, campaign.bodyText)
      : [];
  const messagePreview =
    campaign.kind === OutboundKind.TEXT
      ? (bodyTextsPool[0]?.slice(0, 500) ??
          campaign.bodyText?.trim().slice(0, 500) ??
          null)
      : null;

  const snapshotSent = recipientCountFor(BulkCampaignRecipientStatus.SENT);
  const snapshotFailed = recipientCountFor(BulkCampaignRecipientStatus.FAILED);
  const snapshotQueued =
    recipientCountFor(BulkCampaignRecipientStatus.QUEUED) +
    recipientCountFor(BulkCampaignRecipientStatus.SENDING);
  const snapshotSimulated = recipientCountFor(
    BulkCampaignRecipientStatus.SIMULATED
  );
  const [deliveredCount, seenCount, repliedCount] = await Promise.all([
    prisma.bulkCampaignRecipient.count({
      where: { campaignId, workspaceId, deliveredAt: { not: null } },
    }),
    prisma.bulkCampaignRecipient.count({
      where: { campaignId, workspaceId, seenAt: { not: null } },
    }),
    prisma.bulkCampaignRecipient.count({
      where: { campaignId, workspaceId, repliedAt: { not: null } },
    }),
  ]);
  const successfulRecipients = recipientSnapshotCount
    ? snapshotSent + snapshotSimulated
    : sent + simulated;
  const stats: BulkCampaignOutboundStatsJson = {
    targetRecipients,
    totalOutboundRows,
    sent: recipientSnapshotCount ? snapshotSent : sent,
    failed: recipientSnapshotCount ? snapshotFailed : failed,
    queued: recipientSnapshotCount ? snapshotQueued : queued,
    simulated: recipientSnapshotCount ? snapshotSimulated : simulated,
    pendingInQueue: recipientSnapshotCount ? snapshotQueued : queued,
    notDispatchedYet: recipientSnapshotCount
      ? recipientCountFor(BulkCampaignRecipientStatus.PENDING)
      : notDispatchedYet,
    delivered: deliveredCount,
    seen: seenCount,
    replied: repliedCount,
    noReply: Math.max(0, successfulRecipients - repliedCount),
    readReceiptsTracked: true,
    seenCount,
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
      timezone: campaign.timezone,
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
    bodyTexts:
      campaign.kind === OutboundKind.TEXT
        ? bodyTextsPool.length > 0
          ? bodyTextsPool
          : null
        : null,
    devices,
    deviceSendStats,
    stats,
    recentMessages,
    recentRecipients,
  };
}

export async function exportBulkCampaignReport(
  workspaceId: string,
  campaignId: string,
  format: "csv" | "xlsx"
): Promise<BulkCampaignReportResult> {
  const campaign = await prisma.bulkCampaign.findFirst({
    where: { id: campaignId, workspaceId },
    select: { id: true, name: true },
  });
  if (!campaign) {
    throw new AppError(404, "Campaign not found", "NOT_FOUND");
  }

  const recipients = await prisma.bulkCampaignRecipient.findMany({
    where: { campaignId, workspaceId },
    orderBy: { createdAt: "asc" },
    include: {
      device: { select: { name: true, phone: true } },
    },
  });

  const records =
    recipients.length > 0
      ? recipients.map((r) => ({
          Phone: r.phone,
          Status: recipientStatusApi(r.status),
          Device: r.device
            ? r.device.phone
              ? `${r.device.name} (${r.device.phone})`
              : r.device.name
            : "",
          Attempts: r.attempts,
          Error: r.lastError ?? "",
          QueuedAt: r.queuedAt?.toISOString() ?? "",
          SentAt: r.sentAt?.toISOString() ?? "",
          DeliveredAt: r.deliveredAt?.toISOString() ?? "",
          SeenAt: r.seenAt?.toISOString() ?? "",
          RepliedAt: r.repliedAt?.toISOString() ?? "",
          LastReply: r.lastReplyText ?? "",
          FailedAt: r.failedAt?.toISOString() ?? "",
        }))
      : (
          await prisma.outboundMessage.findMany({
            where: { bulkCampaignId: campaignId, workspaceId },
            orderBy: { createdAt: "asc" },
            include: { device: { select: { name: true, phone: true } } },
          })
        ).map((r) => ({
          Phone: r.toPhone,
          Status: outboundStatusApi(r.status),
          Device: r.device.phone
            ? `${r.device.name} (${r.device.phone})`
            : r.device.name,
          Attempts: r.status === OutboundStatus.QUEUED ? 0 : 1,
          Error: r.errorMessage ?? "",
          QueuedAt: r.createdAt.toISOString(),
          SentAt: r.status === OutboundStatus.SENT ? r.createdAt.toISOString() : "",
          DeliveredAt: "",
          SeenAt: "",
          RepliedAt: "",
          LastReply: "",
          FailedAt:
            r.status === OutboundStatus.FAILED ? r.createdAt.toISOString() : "",
        }));

  const filename = `${slugifyFilename(campaign.name)}-report.${format}`;
  if (format === "csv") {
    return {
      filename,
      contentType: "text/csv; charset=utf-8",
      body: Buffer.from(recordsToCsv(records), "utf8"),
    };
  }

  const worksheet = XLSX.utils.json_to_sheet(records, {
    header: [
      "Phone",
      "Status",
      "Device",
      "Attempts",
      "Error",
      "QueuedAt",
      "SentAt",
      "DeliveredAt",
      "SeenAt",
      "RepliedAt",
      "LastReply",
      "FailedAt",
    ],
  });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Bulk Report");
  return {
    filename,
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer,
  };
}

export async function listBulkCampaignRecipients(
  workspaceId: string,
  campaignId: string,
  input: {
    status?: BulkCampaignRecipientStatusApi;
    q?: string;
    page?: number;
    pageSize?: number;
  }
): Promise<{
  recipients: BulkCampaignRecipientJson[];
  page: number;
  pageSize: number;
  total: number;
}> {
  const campaign = await prisma.bulkCampaign.findFirst({
    where: { id: campaignId, workspaceId },
    select: { id: true },
  });
  if (!campaign) {
    throw new AppError(404, "Campaign not found", "NOT_FOUND");
  }

  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize ?? 50)));
  const where: Prisma.BulkCampaignRecipientWhereInput = {
    campaignId,
    workspaceId,
    ...(input.status ? { status: recipientStatusFromApi(input.status) } : {}),
    ...(input.q?.trim()
      ? { phone: { contains: input.q.trim(), mode: "insensitive" } }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.bulkCampaignRecipient.count({ where }),
    prisma.bulkCampaignRecipient.findMany({
      where,
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        device: { select: { name: true } },
      },
    }),
  ]);

  return {
    recipients: rows.map((r) => ({
      id: r.id,
      phone: r.phone,
      status: recipientStatusApi(r.status),
      deviceId: r.deviceId,
      deviceName: r.device?.name ?? null,
      attempts: r.attempts,
      lastError: r.lastError,
      queuedAt: r.queuedAt?.toISOString() ?? null,
      sentAt: r.sentAt?.toISOString() ?? null,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      seenAt: r.seenAt?.toISOString() ?? null,
      repliedAt: r.repliedAt?.toISOString() ?? null,
      lastReplyAt: r.lastReplyAt?.toISOString() ?? null,
      lastReplyText: r.lastReplyText,
      failedAt: r.failedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    page,
    pageSize,
    total,
  };
}

async function phonesForRecipientSelection(
  workspaceId: string,
  campaignId: string,
  input: {
    statuses?: BulkCampaignRecipientStatusApi[];
    audience?: BulkCampaignRecipientAudienceApi;
  }
): Promise<string[]> {
  const campaign = await prisma.bulkCampaign.findFirst({
    where: { id: campaignId, workspaceId },
    select: { id: true },
  });
  if (!campaign) {
    throw new AppError(404, "Campaign not found", "NOT_FOUND");
  }
  let where: Prisma.BulkCampaignRecipientWhereInput = {
    workspaceId,
    campaignId,
  };
  if (input.audience === "failed") {
    where = { ...where, status: BulkCampaignRecipientStatus.FAILED };
  } else if (input.audience === "replied") {
    where = { ...where, repliedAt: { not: null } };
  } else if (input.audience === "seen_no_reply") {
    where = { ...where, seenAt: { not: null }, repliedAt: null };
  } else if (input.audience === "no_reply") {
    where = {
      ...where,
      status: {
        in: [
          BulkCampaignRecipientStatus.SENT,
          BulkCampaignRecipientStatus.SIMULATED,
        ],
      },
      repliedAt: null,
    };
  } else {
    const statusEnums = (input.statuses ?? ["failed"]).map(recipientStatusFromApi);
    where = { ...where, status: { in: statusEnums } };
  }
  const rows = await prisma.bulkCampaignRecipient.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: { phone: true },
  });
  return [...new Set(rows.map((r) => r.phone))];
}

export async function createRetryCampaignFromRecipients(
  workspaceId: string,
  campaignId: string,
  input: {
    statuses: BulkCampaignRecipientStatusApi[];
    name?: string;
    deviceIds?: string[];
    deviceMode?: "single" | "failover" | "round_robin";
    delayMinSec?: number;
    delayMaxSec?: number;
    maxRetries?: number;
    audience?: BulkCampaignRecipientAudienceApi;
  }
): Promise<BulkCampaignCreateResultJson> {
  const campaign = await prisma.bulkCampaign.findFirst({
    where: { id: campaignId, workspaceId },
  });
  if (!campaign) {
    throw new AppError(404, "Campaign not found", "NOT_FOUND");
  }
  const statuses: BulkCampaignRecipientStatusApi[] =
    input.statuses.length > 0 ? input.statuses : ["failed"];
  const phones = await phonesForRecipientSelection(workspaceId, campaignId, {
    statuses,
    audience: input.audience,
  });
  if (phones.length === 0) {
    throw new AppError(400, "No recipients match the selected statuses", "NO_RECIPIENTS");
  }

  const deviceIds = input.deviceIds?.length
    ? input.deviceIds
    : parseStoredDeviceIds(campaign.deviceIds);

  const retryBodyTexts = parseStoredBodyTexts(
    campaign.bodyTexts,
    campaign.bodyText
  );

  return createBulkCampaign(workspaceId, {
    name:
      input.name?.trim() ||
      `Retry ${input.audience ?? statuses.join(", ")} - ${campaign.name}`.slice(0, 200),
    deviceIds,
    deviceMode: input.deviceMode ?? deviceModeApi(campaign.deviceMode),
    kind: campaign.kind === OutboundKind.TEXT ? "text" : "template",
    bodyText: retryBodyTexts[0] ?? campaign.bodyText ?? undefined,
    bodyTexts:
      campaign.kind === OutboundKind.TEXT && retryBodyTexts.length > 0
        ? retryBodyTexts
        : undefined,
    templateId: campaign.templateId ?? undefined,
    selectionMode: "manual",
    manualPhones: phones,
    attachmentType: campaign.attachmentType,
    attachmentAssetId: campaign.attachmentAssetId,
    scheduleType: "immediate",
    delayMinSec: input.delayMinSec ?? campaign.delayMinSec,
    delayMaxSec: input.delayMaxSec ?? campaign.delayMaxSec,
    maxRetries: input.maxRetries ?? campaign.maxRetries,
    antiBlock: antiBlockApiFromRow(campaign),
  });
}

export async function createContactGroupFromCampaignRecipients(
  workspaceId: string,
  campaignId: string,
  input: {
    statuses: BulkCampaignRecipientStatusApi[];
    audience?: BulkCampaignRecipientAudienceApi;
    name: string;
  }
): Promise<{ group: { id: string; name: string; total: number }; skipped: number }> {
  const name = input.name.trim();
  if (!name) {
    throw new AppError(400, "Group name is required", "VALIDATION");
  }
  const statuses: BulkCampaignRecipientStatusApi[] =
    input.statuses.length > 0 ? input.statuses : ["failed"];
  const phones = await phonesForRecipientSelection(workspaceId, campaignId, {
    statuses,
    audience: input.audience,
  });
  if (phones.length === 0) {
    throw new AppError(400, "No recipients match the selected statuses", "NO_RECIPIENTS");
  }

  const group = await prisma.contactGroup.create({
    data: { workspaceId, name: name.slice(0, 200) },
  });
  const result = await prisma.contact.createMany({
    data: phones.map((phone) => ({
      groupId: group.id,
      name: phone,
      phone,
      status: ContactStatus.UNVERIFIED,
    })),
    skipDuplicates: true,
  });
  return {
    group: { id: group.id, name: group.name, total: result.count },
    skipped: phones.length - result.count,
  };
}

function slugifyFilename(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "bulk-campaign"
  );
}

function recordsToCsv(records: Record<string, string | number>[]): string {
  const headers = [
    "Phone",
    "Status",
    "Device",
    "Attempts",
    "Error",
    "QueuedAt",
    "SentAt",
    "DeliveredAt",
    "SeenAt",
    "RepliedAt",
    "LastReply",
    "FailedAt",
  ];
  return [headers, ...records.map((record) => headers.map((h) => record[h] ?? ""))]
    .map((row) => row.map((value) => escapeCsvCell(String(value))).join(","))
    .join("\n");
}

function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r?\n/g, " ");
  return /[",\n]/.test(normalized)
    ? `"${normalized.replace(/"/g, '""')}"`
    : normalized;
}

function statusApi(s: BulkCampaignStatus): BulkCampaignListItemJson["status"] {
  switch (s) {
    case BulkCampaignStatus.FAILED:
      return "failed";
    case BulkCampaignStatus.COMPLETED:
      return "completed";
    case BulkCampaignStatus.PENDING:
      return "pending";
    case BulkCampaignStatus.RUNNING:
      return "running";
    case BulkCampaignStatus.PAUSED:
      return "paused";
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
  timezone: string | null;
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
  progress?: BulkCampaignListItemJson["progress"];
  createdAt: Date;
  updatedAt: Date;
}): BulkCampaignListItemJson {
  const emptyProgress: BulkCampaignListItemJson["progress"] = {
    sent: 0,
    failed: 0,
    pending: row.recipientCount,
    sending: 0,
    replied: 0,
    total: row.recipientCount,
    percent: 0,
    etaSeconds: null,
  };
  return {
    id: row.id,
    name: row.name,
    status: statusApi(row.status),
    kind: row.kind === OutboundKind.TEXT ? "text" : "template",
    selectionMode: selectionApi(row.selectionMode),
    deviceMode: deviceModeApi(row.deviceMode),
    scheduleType: scheduleApi(row.scheduleType),
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    timezone: row.timezone,
    recipientCount: row.recipientCount,
    delayMinSec: row.delayMinSec,
    delayMaxSec: row.delayMaxSec,
    maxRetries: row.maxRetries,
    attachmentType: row.attachmentType,
    attachmentAssetId: row.attachmentAssetId,
    attachmentFileName: row.attachmentAsset?.originalName ?? null,
    antiBlock: antiBlockApiFromRow(row),
    progress: row.progress ?? emptyProgress,
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
    // Manual lists are still restricted to verified contacts in this workspace.
    const verified = await prisma.contact.findMany({
      where: {
        phone: { in: [...set] },
        status: ContactStatus.VERIFIED,
        group: { workspaceId },
      },
      select: { phone: true },
    });
    set.clear();
    for (const r of verified) {
      set.add(r.phone);
    }
  }

  const phones = [...set];
  if (phones.length === 0) {
    throw new AppError(
      400,
      "No verified recipients. Only contacts with status VERIFIED can be included in bulk campaigns.",
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
  const ids = rows.map((r) => r.id);
  const [statusGroups, repliedGroups] = ids.length
    ? await Promise.all([
        prisma.bulkCampaignRecipient.groupBy({
          by: ["campaignId", "status"],
          where: { workspaceId, campaignId: { in: ids } },
          _count: { _all: true },
        }),
        prisma.bulkCampaignRecipient.groupBy({
          by: ["campaignId"],
          where: {
            workspaceId,
            campaignId: { in: ids },
            repliedAt: { not: null },
          },
          _count: { _all: true },
        }),
      ])
    : [[], []] as const;

  const progressByCampaign = new Map<string, BulkCampaignListItemJson["progress"]>();
  for (const row of rows) {
    const countStatus = (status: BulkCampaignRecipientStatus) =>
      statusGroups.find((g) => g.campaignId === row.id && g.status === status)
        ?._count._all ?? 0;
    const sent =
      countStatus(BulkCampaignRecipientStatus.SENT) +
      countStatus(BulkCampaignRecipientStatus.SIMULATED);
    const failed = countStatus(BulkCampaignRecipientStatus.FAILED);
    const pending = countStatus(BulkCampaignRecipientStatus.PENDING);
    const sending = countStatus(BulkCampaignRecipientStatus.SENDING);
    const replied =
      repliedGroups.find((g) => g.campaignId === row.id)?._count._all ?? 0;
    const processed = sent + failed;
    const total = row.recipientCount;
    const avgDelay = Math.round((row.delayMinSec + row.delayMaxSec) / 2);
    const remaining = pending + sending;
    const batchPauseExtra =
      row.batchPauseEvery > 0
        ? Math.floor(Math.max(0, remaining - 1) / row.batchPauseEvery) *
          row.batchPauseSec
        : 0;
    const etaSeconds =
      row.status === BulkCampaignStatus.RUNNING ||
      row.status === BulkCampaignStatus.PENDING
        ? remaining * avgDelay + batchPauseExtra
        : null;
    progressByCampaign.set(row.id, {
      sent,
      failed,
      pending,
      sending,
      replied,
      total,
      percent: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
      etaSeconds,
    });
  }

  return rows.map((r) =>
    toListItem({
      ...r,
      attachmentAssetId: r.attachmentAssetId,
      progress: progressByCampaign.get(r.id),
    })
  );
}

async function findCampaignForAction(workspaceId: string, campaignId: string) {
  const campaign = await prisma.bulkCampaign.findFirst({
    where: { id: campaignId, workspaceId },
    include: {
      attachmentAsset: { select: { id: true, originalName: true } },
    },
  });
  if (!campaign) {
    throw new AppError(404, "Campaign not found", "NOT_FOUND");
  }
  return campaign;
}

export async function pauseBulkCampaign(
  workspaceId: string,
  campaignId: string
): Promise<BulkCampaignListItemJson> {
  const campaign = await findCampaignForAction(workspaceId, campaignId);
  if (
    campaign.status === BulkCampaignStatus.COMPLETED ||
    campaign.status === BulkCampaignStatus.FAILED
  ) {
    throw new AppError(400, "Completed or failed campaigns cannot be paused", "VALIDATION");
  }
  if (campaign.status === BulkCampaignStatus.PAUSED) {
    return toListItem({ ...campaign, attachmentAssetId: campaign.attachmentAssetId });
  }
  const updated = await prisma.bulkCampaign.update({
    where: { id: campaign.id },
    data: { status: BulkCampaignStatus.PAUSED },
    include: {
      attachmentAsset: { select: { id: true, originalName: true } },
    },
  });
  return toListItem({ ...updated, attachmentAssetId: updated.attachmentAssetId });
}

export async function resumeBulkCampaign(
  workspaceId: string,
  campaignId: string
): Promise<BulkCampaignListItemJson> {
  const campaign = await findCampaignForAction(workspaceId, campaignId);
  if (campaign.status !== BulkCampaignStatus.PAUSED) {
    return toListItem({ ...campaign, attachmentAssetId: campaign.attachmentAssetId });
  }

  const now = new Date();
  const nextStatus =
    campaign.scheduleType === BulkScheduleType.SCHEDULED &&
    campaign.scheduledAt &&
    campaign.scheduledAt > now
      ? BulkCampaignStatus.SCHEDULED
      : BulkCampaignStatus.PENDING;

  const updated = await prisma.bulkCampaign.update({
    where: { id: campaign.id },
    data: { status: nextStatus },
    include: {
      attachmentAsset: { select: { id: true, originalName: true } },
    },
  });
  return toListItem({ ...updated, attachmentAssetId: updated.attachmentAssetId });
}

export async function deleteBulkCampaign(
  workspaceId: string,
  campaignId: string
): Promise<void> {
  const campaign = await prisma.bulkCampaign.findFirst({
    where: { id: campaignId, workspaceId },
    select: { id: true },
  });
  if (!campaign) {
    throw new AppError(404, "Campaign not found", "NOT_FOUND");
  }
  await prisma.bulkCampaign.delete({ where: { id: campaign.id } });
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
      "No verified recipients remain after filters. Only VERIFIED contacts can receive bulk messages.",
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
  let bodyTexts: string[] | null = null;
  let kind: OutboundKind;

  if (payload.kind === "text") {
    const customTexts = normalizeBodyTexts({
      bodyText: payload.bodyText,
      bodyTexts: payload.bodyTexts,
    });
    if (customTexts.length === 0) {
      throw new AppError(400, "Message text is required", "VALIDATION");
    }

    await enforceSslCommerzPeriodExpiry(workspaceId);
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: true },
    });
    if (!workspace) {
      throw new AppError(404, "Workspace not found", "NOT_FOUND");
    }
    const maxContents = maxBulkMessageContentsForPlan(workspace.plan);
    const aiEnabled = payload.aiRewrite?.enabled === true;
    const aiCount = aiEnabled
      ? Math.floor(Number(payload.aiRewrite?.count))
      : 0;
    if (aiEnabled && (!Number.isFinite(aiCount) || aiCount < 1)) {
      throw new AppError(
        400,
        "AI rewrite count must be a positive integer when AI rewrite is enabled",
        "VALIDATION"
      );
    }
    if (aiEnabled && !payload.aiRewrite?.credentialId?.trim()) {
      throw new AppError(
        400,
        "AI credentialId is required when AI rewrite is enabled",
        "VALIDATION"
      );
    }
    if (customTexts.length + Math.max(0, aiCount) > maxContents) {
      throw new AppError(
        403,
        `Your plan allows up to ${maxContents} message content(s) per bulk campaign (custom + AI). Upgrade billing to add more.`,
        "PLAN_BULK_MESSAGE_CONTENT_LIMIT"
      );
    }

    let pool = [...customTexts];
    if (aiEnabled && aiCount > 0) {
      const variants = await generateAiRewriteVariants(
        workspaceId,
        customTexts[0]!,
        {
          enabled: true,
          count: aiCount,
          credentialId: payload.aiRewrite!.credentialId,
          model: payload.aiRewrite!.model,
          systemPrompt: payload.aiRewrite!.systemPrompt,
          temperature: payload.aiRewrite!.temperature,
          maxTokens: payload.aiRewrite!.maxTokens,
        }
      );
      if (variants.length < aiCount) {
        throw new AppError(
          502,
          `AI rewrite returned ${variants.length} variant(s); expected ${aiCount}`,
          "AI_REWRITE_INSUFFICIENT"
        );
      }
      pool = [...customTexts, ...variants];
    }

    bodyTexts = pool;
    bodyText = pool[0] ?? null;
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
      bodyTexts:
        bodyTexts && bodyTexts.length > 0
          ? (bodyTexts as unknown as Prisma.InputJsonValue)
          : undefined,
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
      verifyNumbers: true,
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
      timezone: antiBlock.timezone,
      status: initialStatus,
    },
  });

  await prisma.bulkCampaignRecipient.createMany({
    data: phones.map((phone, index) => ({
      workspaceId,
      campaignId: campaign.id,
      phone,
      deviceId: assignedDeviceForRecipient(index, payload.deviceIds, deviceModeEnum),
      status: BulkCampaignRecipientStatus.PENDING,
    })),
    skipDuplicates: true,
  });

  let dispatched = 0;

  if (scheduleType === BulkScheduleType.IMMEDIATE) {
    // Background processing — claim PENDING → RUNNING then dispatch.
    setImmediate(async () => {
      try {
        const claimed = await prisma.bulkCampaign.updateMany({
          where: { id: campaign.id, workspaceId, status: BulkCampaignStatus.PENDING },
          data: {
            status: BulkCampaignStatus.RUNNING,
          },
        });
        if (claimed.count === 0) return;

        const result = await executeCampaignDispatch({
          campaignId: campaign.id,
          workspaceId,
          phones,
          deviceIds: payload.deviceIds,
          deviceMode: deviceModeEnum,
          kind,
          bodyText,
          bodyTexts,
          templateId,
          attachmentType,
          attachmentAssetId,
          delayMinSec: delayNorm.min,
          delayMaxSec: delayNorm.max,
          maxRetries: Math.max(0, payload.maxRetries),
          antiBlock,
        });

        const pendingLeft = await countPendingCampaignRecipients(workspaceId, campaign.id);
        await prisma.bulkCampaign.updateMany({
          where: { id: campaign.id, workspaceId, status: { not: BulkCampaignStatus.PAUSED } },
          data: {
            status:
              result.stoppedByFailLimit ||
              result.stoppedByDailyCap ||
              pendingLeft > 0
                ? BulkCampaignStatus.PAUSED
                : BulkCampaignStatus.COMPLETED,
          },
        });

        console.log(
          `Campaign ${campaign.id} dispatched ${result.dispatched} message(s)`
        );
      } catch (error) {
        console.error("Campaign execution failed:", error);

        await prisma.bulkCampaign.updateMany({
          where: { id: campaign.id, workspaceId },
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
      ? "Campaign saved as scheduled. The background worker will start sending when the scheduled time is due."
      : env.WHATSAPP_BRIDGE_ENABLED
        ? "Immediate campaign queued and sending in the background. Track progress on the campaign detail page."
        : "Bridge is off: messages will be recorded as simulated. Set WHATSAPP_BRIDGE_ENABLED=true and use connected devices for real delivery.";

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
  bodyTexts?: string[] | null;
  templateId: string | null;
  attachmentType: string | null;
  attachmentAssetId: string | null;
  delayMinSec: number;
  delayMaxSec: number;
  maxRetries: number;
  antiBlock: BulkAntiBlockSettings;
};

async function countPendingCampaignRecipients(
  workspaceId: string,
  campaignId: string
): Promise<number> {
  return prisma.bulkCampaignRecipient.count({
    where: {
      workspaceId,
      campaignId,
      status: BulkCampaignRecipientStatus.PENDING,
    },
  });
}

type ExecuteCampaignResult = {
  dispatched: number;
  stoppedByFailLimit: boolean;
  stoppedByDailyCap: boolean;
};

async function markFilteredOutRecipientsSkipped(
  workspaceId: string,
  campaignId: string,
  keepPhones: string[]
): Promise<void> {
  const keep = new Set(keepPhones);
  const pending = await prisma.bulkCampaignRecipient.findMany({
    where: {
      workspaceId,
      campaignId,
      status: BulkCampaignRecipientStatus.PENDING,
    },
    select: { id: true, phone: true },
  });
  const skipIds = pending.filter((r) => !keep.has(r.phone)).map((r) => r.id);
  if (skipIds.length === 0) return;
  await prisma.bulkCampaignRecipient.updateMany({
    where: { id: { in: skipIds } },
    data: {
      status: BulkCampaignRecipientStatus.SKIPPED,
      lastError:
        "Skipped: not a VERIFIED contact in this workspace (or removed by campaign filters)",
    },
  });
}

/**
 * After a process restart, RUNNING campaigns and SENDING recipients are orphaned
 * because dispatch is in-process. Reset them so the scheduled worker can resume.
 */
export async function recoverInterruptedBulkCampaigns(): Promise<{
  campaigns: number;
  recipients: number;
}> {
  const recipients = await prisma.bulkCampaignRecipient.updateMany({
    where: { status: BulkCampaignRecipientStatus.SENDING },
    data: {
      status: BulkCampaignRecipientStatus.PENDING,
      lastError: "Recovered after server restart — will retry",
    },
  });
  const campaigns = await prisma.bulkCampaign.updateMany({
    where: { status: BulkCampaignStatus.RUNNING },
    data: { status: BulkCampaignStatus.PENDING },
  });
  if (campaigns.count > 0 || recipients.count > 0) {
    console.log(
      `[bulk-campaigns] recovered ${campaigns.count} running campaign(s), ${recipients.count} sending recipient(s)`
    );
  }
  return { campaigns: campaigns.count, recipients: recipients.count };
}

async function executeCampaignDispatch(args: ExecuteCampaignArgs): Promise<ExecuteCampaignResult> {
  const {
    campaignId,
    workspaceId,
    phones,
    deviceIds,
    deviceMode,
    kind,
    bodyText,
    bodyTexts: bodyTextsArg,
    templateId,
    attachmentType,
    attachmentAssetId,
    delayMinSec,
    delayMaxSec,
    maxRetries,
    antiBlock,
  } = args;
  // Always resolve the pool from DB so we never drop custom variants if args were stale.
  let messagePool: string[] = [];
  if (kind === OutboundKind.TEXT) {
    const stored = await prisma.bulkCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      select: { bodyTexts: true, bodyText: true },
    });
    messagePool = parseStoredBodyTexts(
      stored?.bodyTexts ?? bodyTextsArg ?? null,
      stored?.bodyText ?? bodyText
    );
    if (messagePool.length === 0) {
      messagePool = parseStoredBodyTexts(bodyTextsArg ?? null, bodyText);
    }
  }
  /** Randomize which variant is used first, then rotate evenly across recipients. */
  const variantRotationOffset =
    messagePool.length > 1 ? Math.floor(Math.random() * messagePool.length) : 0;
  let dispatched = 0;
  let consecutiveFailures = 0;
  let stoppedByDailyCap = false;

  // Final gate: only VERIFIED contacts may be sent; others become SKIPPED.
  const verifiedPhones = await filterVerifiedFromContacts(workspaceId, phones);
  await markFilteredOutRecipientsSkipped(workspaceId, campaignId, verifiedPhones);

  const recipientRows = await prisma.bulkCampaignRecipient.findMany({
    where: {
      campaignId,
      workspaceId,
      phone: { in: verifiedPhones },
      status: BulkCampaignRecipientStatus.PENDING,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, phone: true, attempts: true },
  });
  const pendingRecipients = recipientRows;

  async function campaignIsAvailable(): Promise<boolean> {
    const row = await prisma.bulkCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      select: { status: true },
    });
    return Boolean(row);
  }

  /**
   * Returns false when the campaign was deleted or paused so the global scheduled
   * worker is never blocked waiting on a single paused campaign.
   * Resume sets status back to PENDING/SCHEDULED for the next worker tick.
   */
  async function waitWhilePaused(): Promise<boolean> {
    if (isShuttingDown) return false;
    const row = await prisma.bulkCampaign.findFirst({
      where: { id: campaignId, workspaceId },
      select: { status: true },
    });
    if (!row) return false;
    if (row.status === BulkCampaignStatus.PAUSED) return false;
    if (row.status === BulkCampaignStatus.PENDING) {
      await prisma.bulkCampaign.updateMany({
        where: { id: campaignId, workspaceId, status: BulkCampaignStatus.PENDING },
        data: { status: BulkCampaignStatus.RUNNING },
      });
    }
    return true;
  }

  async function waitUntilSendAllowed(): Promise<boolean> {
    while (antiBlock.enabled && !canSendAt(new Date(), antiBlock)) {
      if (isShuttingDown) return false;
      const available = await waitWhilePaused();
      if (!available) return false;
      const slept = await sleepWithCampaignChecks(30_000);
      if (!slept) return false;
    }
    return true;
  }

  async function sleepWithCampaignChecks(ms: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, ms);
    while (Date.now() < deadline) {
      if (isShuttingDown) return false;
      const available = await waitWhilePaused();
      if (!available) return false;
      const remaining = deadline - Date.now();
      await sleepMs(Math.min(2_000, Math.max(0, remaining)));
    }
    return true;
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
    for (let i = 0; i < pendingRecipients.length; i += OUTBOUND_CHUNK) {
      const available = await waitWhilePaused();
      if (!available) return { dispatched, stoppedByFailLimit: false, stoppedByDailyCap: false };
      const slice = pendingRecipients.slice(i, i + OUTBOUND_CHUNK);
      const rows: Prisma.OutboundMessageCreateManyInput[] = slice.map((recipient, j) => {
        const globalIdx = i + j;
        const devId = assignedDeviceForRecipient(globalIdx, deviceIds, deviceMode);
        const picked =
          kind === OutboundKind.TEXT
            ? pickBodyTextForRecipient(
                messagePool,
                globalIdx,
                variantRotationOffset
              )
            : "";
        const simulatedText =
          kind === OutboundKind.TEXT
            ? antiBlock.enabled && antiBlock.spintaxEnabled
              ? applySpintax(picked)
              : picked
            : bodyText;
        return {
          workspaceId,
          deviceId: devId,
          toPhone: recipient.phone,
          kind,
          bodyText: simulatedText,
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
      await prisma.bulkCampaignRecipient.updateMany({
        where: { id: { in: slice.map((recipient) => recipient.id) }, status: BulkCampaignRecipientStatus.PENDING },
        data: {
          status: BulkCampaignRecipientStatus.SIMULATED,
          attempts: { increment: 1 },
          queuedAt: new Date(),
          sentAt: new Date(),
          lastError: antiBlock.enabled
            ? "Simulated mode: anti-block send-time checks are not executed."
            : null,
        },
      });
      dispatched += rows.length;
    }
    return { dispatched, stoppedByFailLimit: false, stoppedByDailyCap: false };
  }

  for (let i = 0; i < pendingRecipients.length; i++) {
    const available = await waitWhilePaused();
    if (!available) return { dispatched, stoppedByFailLimit: false, stoppedByDailyCap };
    const sendTimeAllowed = await waitUntilSendAllowed();
    if (!sendTimeAllowed || !(await campaignIsAvailable())) {
      return { dispatched, stoppedByFailLimit: false, stoppedByDailyCap };
    }
    if (shouldStopByFailLimit(consecutiveFailures, antiBlock)) {
      return { dispatched, stoppedByFailLimit: true, stoppedByDailyCap };
    }

    const recipient = pendingRecipients[i]!;
    const toPhone = recipient.phone;
    const primaryDeviceId = assignedDeviceForRecipient(i, deviceIds, deviceMode);
    const claimed = await prisma.bulkCampaignRecipient.updateMany({
      where: {
        id: recipient.id,
        workspaceId,
        campaignId,
        status: BulkCampaignRecipientStatus.PENDING,
      },
      data: {
        status: BulkCampaignRecipientStatus.SENDING,
        deviceId: primaryDeviceId,
        queuedAt: new Date(),
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    if (claimed.count === 0) {
      continue;
    }

    const pickedText =
      kind === OutboundKind.TEXT
        ? pickBodyTextForRecipient(messagePool, i, variantRotationOffset)
        : "";
    const personalizedText =
      kind === OutboundKind.TEXT
        ? antiBlock.enabled && antiBlock.spintaxEnabled
          ? applySpintax(pickedText)
          : pickedText
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
    await prisma.bulkCampaignRecipient.update({
      where: { id: recipient.id },
      data: { outboundMessageId: row.id },
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
        return withDeviceOutboundGate(
          devId,
          {
            minGapMs: WA_DEVICE_BULK_MIN_GAP_MS,
            enforceDailyCap: true,
            dailyCap: WA_DEVICE_DAILY_SEND_CAP,
          },
          async () => {
            const sock = await waSession.waitForOpenWaSocket(devId, workspaceId);
            if (!sock) {
              throw new Error("WhatsApp session offline — open Devices and reconnect.");
            }
            return sock.sendMessage(jid, outgoing);
          }
        );
      };

      let usedDeviceId = primaryDeviceId;
      let waMsg: Awaited<ReturnType<typeof trySend>> | null = null;
      let attempts = 0;
      let lastErr: Error | null = null;
      const retries = Math.max(0, maxRetries);
      while (attempts <= retries && waMsg === null) {
        attempts += 1;
        if (attempts > 1) {
          const backoffMs = Math.min(30_000, 5_000 * (attempts - 1));
          const slept = await sleepWithCampaignChecks(backoffMs);
          if (!slept) return { dispatched, stoppedByFailLimit: false, stoppedByDailyCap };
        }
        if (deviceMode === BulkDeviceMode.FAILOVER) {
          for (let d = 0; d < deviceIds.length; d++) {
            const devId = deviceIds[d]!;
            try {
              waMsg = await trySend(devId);
              usedDeviceId = devId;
              break;
            } catch (e) {
              if (e instanceof DeviceDailyCapExceededError) {
                lastErr = e;
                continue;
              }
              lastErr = e instanceof Error ? e : new Error(String(e));
              if (d < deviceIds.length - 1) {
                const slept = await sleepWithCampaignChecks(FAILOVER_DEVICE_GAP_MS);
                if (!slept) return { dispatched, stoppedByFailLimit: false, stoppedByDailyCap };
              }
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
        if (lastErr instanceof DeviceDailyCapExceededError) {
          stoppedByDailyCap = true;
          await prisma.outboundMessage.update({
            where: { id: row.id },
            data: {
              status: OutboundStatus.FAILED,
              errorMessage: lastErr.message.slice(0, 500),
            },
          });
          await prisma.bulkCampaignRecipient.update({
            where: { id: recipient.id },
            data: {
              status: BulkCampaignRecipientStatus.PENDING,
              lastError: lastErr.message.slice(0, 500),
            },
          });
          return { dispatched, stoppedByFailLimit: false, stoppedByDailyCap: true };
        }
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
      await prisma.bulkCampaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: BulkCampaignRecipientStatus.SENT,
          deviceId: usedDeviceId,
          sentAt: new Date(),
          lastError: null,
        },
      });
      consecutiveFailures = 0;
    } catch (e) {
      if (e instanceof DeviceDailyCapExceededError) {
        stoppedByDailyCap = true;
        await prisma.outboundMessage.update({
          where: { id: row.id },
          data: {
            status: OutboundStatus.FAILED,
            errorMessage: e.message.slice(0, 500),
          },
        });
        await prisma.bulkCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: BulkCampaignRecipientStatus.PENDING,
            lastError: e.message.slice(0, 500),
          },
        });
        return { dispatched, stoppedByFailLimit: false, stoppedByDailyCap: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      await prisma.outboundMessage.update({
        where: { id: row.id },
        data: {
          status: OutboundStatus.FAILED,
          errorMessage: msg.slice(0, 500),
        },
      });
      await prisma.bulkCampaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: BulkCampaignRecipientStatus.FAILED,
          failedAt: new Date(),
          lastError: msg.slice(0, 500),
        },
      });
      consecutiveFailures += 1;
    }

    dispatched += 1;

    // Always apply inter-message delay; batch pause is additive (never replaces the delay).
    if (i < pendingRecipients.length - 1) {
      let pauseMs = randomDelayMs(delayMinSec, delayMaxSec);
      if (dispatched % antiBlock.batchPauseEvery === 0) {
        pauseMs += antiBlock.batchPauseSec * 1000;
      }
      const slept = await sleepWithCampaignChecks(pauseMs);
      if (!slept) return { dispatched, stoppedByFailLimit: false, stoppedByDailyCap };
    }
  }

  return { dispatched, stoppedByFailLimit: false, stoppedByDailyCap };
}

function parseStoredPhones(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string");
}

async function processSingleCampaign(campaign: BulkCampaign): Promise<void> {
  try {
    const phones = await applyPhoneFilters(
      campaign.workspaceId,
      parseStoredPhones(campaign.recipientPhones),
      {
        enabled: campaign.antiBlockEnabled,
        spintaxEnabled: campaign.spintaxEnabled,
        verifyNumbers: true,
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
        timezone: campaign.timezone,
      }
    );

    const result = await executeCampaignDispatch({
      campaignId: campaign.id,
      workspaceId: campaign.workspaceId,
      phones,
      deviceIds: parseStoredDeviceIds(campaign.deviceIds),
      deviceMode: campaign.deviceMode,
      kind: campaign.kind,
      bodyText: campaign.bodyText,
      bodyTexts: parseStoredBodyTexts(campaign.bodyTexts, campaign.bodyText),
      templateId: campaign.templateId,
      attachmentType: campaign.attachmentType,
      attachmentAssetId: campaign.attachmentAssetId,
      delayMinSec: campaign.delayMinSec,
      delayMaxSec: campaign.delayMaxSec,
      maxRetries: campaign.maxRetries,
      antiBlock: {
        enabled: campaign.antiBlockEnabled,
        spintaxEnabled: campaign.spintaxEnabled,
        verifyNumbers: true,
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
        timezone: campaign.timezone,
      },
    });

    if (isShuttingDown) {
      // Revert to PENDING so next server run resumes automatically
      await prisma.bulkCampaign.updateMany({
        where: { id: campaign.id, status: BulkCampaignStatus.RUNNING },
        data: { status: BulkCampaignStatus.PENDING },
      });
      return;
    }

    const pendingLeft = await countPendingCampaignRecipients(
      campaign.workspaceId,
      campaign.id
    );

    const finalStatus =
      result.stoppedByFailLimit ||
      result.stoppedByDailyCap ||
      pendingLeft > 0
        ? BulkCampaignStatus.PAUSED
        : BulkCampaignStatus.COMPLETED;

    await prisma.bulkCampaign.updateMany({
      where: { id: campaign.id, status: { not: BulkCampaignStatus.PAUSED } },
      data: { status: finalStatus },
    });

    if (finalStatus === BulkCampaignStatus.COMPLETED) {
      await createNotification({
        audience: NotificationAudience.CUSTOMER,
        workspaceId: campaign.workspaceId,
        type: NotificationType.CAMPAIGN_COMPLETED,
        title: `Campaign Completed: ${campaign.name}`,
        message: `All messages processed. ${result.dispatched} message(s) dispatched successfully.`,
        link: `/bulk-messages/${campaign.id}`,
        metadata: {
          campaignId: campaign.id,
          campaignName: campaign.name,
          dispatched: result.dispatched,
        },
      });
    } else if (result.stoppedByDailyCap) {
      await createNotification({
        audience: NotificationAudience.CUSTOMER,
        workspaceId: campaign.workspaceId,
        type: NotificationType.CAMPAIGN_PAUSED,
        title: `Campaign Paused (Daily Cap): ${campaign.name}`,
        message: `Paused automatically: daily device message ceiling reached. Resume tomorrow to protect your WhatsApp account.`,
        link: `/bulk-messages/${campaign.id}`,
        metadata: { campaignId: campaign.id, reason: "DAILY_CAP" },
      });
    } else if (result.stoppedByFailLimit) {
      await createNotification({
        audience: NotificationAudience.CUSTOMER,
        workspaceId: campaign.workspaceId,
        type: NotificationType.CAMPAIGN_PAUSED,
        title: `Campaign Paused (Fail Limit): ${campaign.name}`,
        message: `Paused automatically: consecutive send errors reached the anti-block safety threshold.`,
        link: `/bulk-messages/${campaign.id}`,
        metadata: { campaignId: campaign.id, reason: "FAIL_LIMIT" },
      });
    }
  } catch (err) {
    console.error(
      `[bulk-campaigns] unexpected error executing campaign ${campaign.id}:`,
      err
    );
    await prisma.bulkCampaign
      .updateMany({
        where: { id: campaign.id, status: BulkCampaignStatus.RUNNING },
        data: { status: BulkCampaignStatus.PAUSED },
      })
      .catch(() => {});
  }
}

export async function runScheduledCampaignsOnce(): Promise<number> {
  if (isShuttingDown) return 0;
  const maxConcurrent = env.BULK_CAMPAIGN_MAX_CONCURRENT ?? 5;
  if (activeCampaignIds.size >= maxConcurrent) return 0;

  const availableSlots = maxConcurrent - activeCampaignIds.size;
  try {
    const now = new Date();
    const excludeIds = Array.from(activeCampaignIds);
    const due = await prisma.bulkCampaign.findMany({
      where: {
        ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
        OR: [
          {
            status: BulkCampaignStatus.SCHEDULED,
            scheduleType: BulkScheduleType.SCHEDULED,
            scheduledAt: { lte: now },
          },
          {
            status: BulkCampaignStatus.PENDING,
          },
        ],
      },
      orderBy: { scheduledAt: "asc" },
      take: availableSlots,
    });

    let started = 0;
    for (const campaign of due) {
      if (activeCampaignIds.size >= maxConcurrent) break;
      if (activeCampaignIds.has(campaign.id)) continue;

      const claimed = await prisma.bulkCampaign.updateMany({
        where: {
          id: campaign.id,
          status: {
            in: [BulkCampaignStatus.SCHEDULED, BulkCampaignStatus.PENDING],
          },
        },
        data: { status: BulkCampaignStatus.RUNNING },
      });
      if (claimed.count === 0) continue;

      activeCampaignIds.add(campaign.id);
      started += 1;
      console.log(
        `[bulk-campaigns] started campaign "${campaign.name}" (${campaign.id}) [active: ${activeCampaignIds.size}/${maxConcurrent}]`
      );

      void (async () => {
        try {
          await processSingleCampaign(campaign);
        } finally {
          activeCampaignIds.delete(campaign.id);
          console.log(
            `[bulk-campaigns] finished campaign "${campaign.name}" (${campaign.id}) [active: ${activeCampaignIds.size}/${maxConcurrent}]`
          );
        }
      })();
    }
    return started;
  } catch (err) {
    console.error("[bulk-campaigns] scheduled worker error", err);
    return 0;
  }
}

export function startBulkCampaignScheduledWorker(): void {
  if (scheduledLoopStarted) return;
  scheduledLoopStarted = true;
  isShuttingDown = false;
  void recoverInterruptedBulkCampaigns().then(() => {
    void runScheduledCampaignsOnce();
  });
  scheduledInterval = setInterval(() => {
    void runScheduledCampaignsOnce();
  }, SCHEDULED_POLL_MS);
}

export async function stopBulkCampaignScheduledWorker(
  timeoutMs = 5000
): Promise<void> {
  isShuttingDown = true;
  if (scheduledInterval) {
    clearInterval(scheduledInterval);
    scheduledInterval = null;
  }
  const deadline = Date.now() + timeoutMs;
  while (activeCampaignIds.size > 0 && Date.now() < deadline) {
    await sleepMs(150);
  }
  if (activeCampaignIds.size > 0) {
    console.warn(
      `[bulk-campaigns] shutdown timeout reached with ${activeCampaignIds.size} active campaign(s) remaining`
    );
  }
}

"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBulkCampaignDetail = getBulkCampaignDetail;
exports.listBulkCampaigns = listBulkCampaigns;
exports.createBulkCampaign = createBulkCampaign;
exports.runScheduledCampaignsOnce = runScheduledCampaignsOnce;
exports.startBulkCampaignScheduledWorker = startBulkCampaignScheduledWorker;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const env_1 = require("../env");
const errors_1 = require("../lib/errors");
const phone_1 = require("../lib/phone");
const whatsapp_jid_1 = require("../lib/whatsapp-jid");
const wa_outbound_content_1 = require("./wa-outbound-content");
const templates_service_1 = require("./templates.service");
const waSession = __importStar(require("./wa-device-session.service"));
const bulk_campaign_safety_service_1 = require("./bulk_campaign_safety.service");
const MAX_RECIPIENTS = 2000;
const OUTBOUND_CHUNK = 250;
const SCHEDULED_POLL_MS = 15_000;
let scheduledLoopStarted = false;
let scheduledLoopBusy = false;
/** WhatsApp anti-spam: minimum pause between bulk sends (seconds). */
const WHATSAPP_MIN_DELAY_SEC = 12;
function normalizeDelayRangeSec(minSec, maxSec) {
    let lo = Math.min(minSec, maxSec);
    let hi = Math.max(minSec, maxSec);
    lo = Math.max(WHATSAPP_MIN_DELAY_SEC, Math.min(3600, lo));
    hi = Math.max(lo, Math.min(3600, hi));
    return { min: lo, max: hi };
}
function parseDeviceMode(raw) {
    switch (raw) {
        case "single":
            return client_1.BulkDeviceMode.SINGLE;
        case "failover":
            return client_1.BulkDeviceMode.FAILOVER;
        default:
            return client_1.BulkDeviceMode.ROUND_ROBIN;
    }
}
function deviceModeApi(m) {
    switch (m) {
        case client_1.BulkDeviceMode.SINGLE:
            return "single";
        case client_1.BulkDeviceMode.FAILOVER:
            return "failover";
        default:
            return "round_robin";
    }
}
function parseStoredDeviceIds(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((x) => typeof x === "string");
}
function outboundStatusApi(s) {
    switch (s) {
        case client_1.OutboundStatus.SENT:
            return "sent";
        case client_1.OutboundStatus.FAILED:
            return "failed";
        case client_1.OutboundStatus.QUEUED:
            return "queued";
        case client_1.OutboundStatus.SIMULATED:
            return "simulated";
        default:
            return String(s).toLowerCase();
    }
}
async function getBulkCampaignDetail(workspaceId, campaignId) {
    const campaign = await prisma_1.prisma.bulkCampaign.findFirst({
        where: { id: campaignId, workspaceId },
        include: {
            attachmentAsset: { select: { id: true, originalName: true } },
            template: { select: { id: true, name: true, typeId: true } },
        },
    });
    if (!campaign) {
        throw new errors_1.AppError(404, "Campaign not found", "NOT_FOUND");
    }
    const storedIds = parseStoredDeviceIds(campaign.deviceIds);
    const uniqueDeviceIds = [...new Set(storedIds)];
    const deviceRows = await prisma_1.prisma.device.findMany({
        where: { workspaceId, id: { in: uniqueDeviceIds.length ? uniqueDeviceIds : [] } },
        select: { id: true, name: true, phone: true, status: true },
    });
    const deviceById = new Map(deviceRows.map((d) => [d.id, d]));
    const devices = uniqueDeviceIds.map((id) => {
        const d = deviceById.get(id);
        return {
            id,
            name: d?.name ?? "Unknown device",
            phone: d?.phone ?? null,
            status: d ? String(d.status) : "UNKNOWN",
        };
    });
    const statusGroups = await prisma_1.prisma.outboundMessage.groupBy({
        by: ["status"],
        where: { bulkCampaignId: campaignId, workspaceId },
        _count: { _all: true },
    });
    const countFor = (st) => statusGroups.find((g) => g.status === st)?._count._all ?? 0;
    const sent = countFor(client_1.OutboundStatus.SENT);
    const failed = countFor(client_1.OutboundStatus.FAILED);
    const queued = countFor(client_1.OutboundStatus.QUEUED);
    const simulated = countFor(client_1.OutboundStatus.SIMULATED);
    const totalOutboundRows = sent + failed + queued + simulated;
    const targetRecipients = campaign.recipientCount;
    const notDispatchedYet = Math.max(0, targetRecipients - totalOutboundRows);
    const devStatusGroups = await prisma_1.prisma.outboundMessage.groupBy({
        by: ["deviceId", "status"],
        where: { bulkCampaignId: campaignId, workspaceId },
        _count: { _all: true },
    });
    const perDevice = new Map();
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
        if (g.status === client_1.OutboundStatus.SENT)
            cur.sent += n;
        else if (g.status === client_1.OutboundStatus.FAILED)
            cur.failed += n;
        else if (g.status === client_1.OutboundStatus.QUEUED)
            cur.queued += n;
        else if (g.status === client_1.OutboundStatus.SIMULATED)
            cur.simulated += n;
        perDevice.set(g.deviceId, cur);
    }
    const deviceSendStats = uniqueDeviceIds.map((deviceId) => {
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
    });
    const recent = await prisma_1.prisma.outboundMessage.findMany({
        where: { bulkCampaignId: campaignId, workspaceId },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
            device: { select: { name: true, phone: true } },
        },
    });
    const recentMessages = recent.map((r) => ({
        id: r.id,
        toPhone: r.toPhone,
        status: outboundStatusApi(r.status),
        deviceId: r.deviceId,
        deviceName: r.device.name,
        devicePhone: r.device.phone,
        errorMessage: r.errorMessage,
        createdAt: r.createdAt.toISOString(),
    }));
    const messagePreview = campaign.kind === client_1.OutboundKind.TEXT
        ? (campaign.bodyText?.trim().slice(0, 500) ?? null)
        : null;
    const stats = {
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
function statusApi(s) {
    switch (s) {
        case client_1.BulkCampaignStatus.FAILED:
            return "failed";
        case client_1.BulkCampaignStatus.COMPLETED:
            return "completed";
        default:
            return "scheduled";
    }
}
function selectionApi(m) {
    switch (m) {
        case client_1.BulkSelectionMode.ALL_VERIFIED:
            return "all_verified";
        case client_1.BulkSelectionMode.MANUAL:
            return "manual";
        default:
            return "groups";
    }
}
function scheduleApi(t) {
    return t === client_1.BulkScheduleType.SCHEDULED ? "scheduled" : "immediate";
}
function toListItem(row) {
    return {
        id: row.id,
        name: row.name,
        status: statusApi(row.status),
        kind: row.kind === client_1.OutboundKind.TEXT ? "text" : "template",
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
        antiBlock: (0, bulk_campaign_safety_service_1.antiBlockApiFromRow)(row),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
async function resolveRecipientPhones(workspaceId, mode, groupIds, manualPhones) {
    const set = new Set();
    if (mode === client_1.BulkSelectionMode.GROUPS) {
        if (!groupIds?.length) {
            throw new errors_1.AppError(400, "Select at least one contact group", "VALIDATION");
        }
        const groups = await prisma_1.prisma.contactGroup.findMany({
            where: { id: { in: groupIds }, workspaceId },
            select: { id: true },
        });
        if (groups.length !== groupIds.length) {
            throw new errors_1.AppError(400, "One or more groups were not found", "VALIDATION");
        }
        const rows = await prisma_1.prisma.contact.findMany({
            where: {
                groupId: { in: groupIds },
                status: client_1.ContactStatus.VERIFIED,
                group: { workspaceId },
            },
            select: { phone: true },
        });
        for (const r of rows) {
            set.add(r.phone);
        }
    }
    else if (mode === client_1.BulkSelectionMode.ALL_VERIFIED) {
        const rows = await prisma_1.prisma.contact.findMany({
            where: {
                status: client_1.ContactStatus.VERIFIED,
                group: { workspaceId },
            },
            select: { phone: true },
        });
        for (const r of rows) {
            set.add(r.phone);
        }
    }
    else {
        const lines = manualPhones ?? [];
        if (!lines.length) {
            throw new errors_1.AppError(400, "Enter at least one phone number for manual selection", "VALIDATION");
        }
        for (const line of lines) {
            const v = (0, phone_1.validateAndFormatPhone)(line);
            if (v.valid) {
                set.add(v.e164);
            }
        }
    }
    const phones = [...set];
    if (phones.length === 0) {
        throw new errors_1.AppError(400, "No valid recipients. For groups / all verified, ensure you have verified contacts.", "NO_RECIPIENTS");
    }
    if (phones.length > MAX_RECIPIENTS) {
        throw new errors_1.AppError(400, `Too many recipients (max ${MAX_RECIPIENTS} per campaign)`, "LIMIT_EXCEEDED");
    }
    return phones;
}
async function assertDevices(workspaceId, deviceIds) {
    const devices = await prisma_1.prisma.device.findMany({
        where: { id: { in: deviceIds }, workspaceId },
    });
    if (devices.length !== deviceIds.length) {
        throw new errors_1.AppError(400, "One or more devices were not found", "VALIDATION");
    }
    const notConnected = devices.filter((d) => d.status !== client_1.DeviceStatus.CONNECTED);
    if (notConnected.length > 0) {
        throw new errors_1.AppError(400, "All selected devices must be connected before sending", "DEVICE_NOT_CONNECTED");
    }
    return devices;
}
async function listBulkCampaigns(workspaceId) {
    const rows = await prisma_1.prisma.bulkCampaign.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
        include: {
            attachmentAsset: { select: { id: true, originalName: true } },
        },
    });
    return rows.map((r) => toListItem({
        ...r,
        attachmentAssetId: r.attachmentAssetId,
    }));
}
async function createBulkCampaign(workspaceId, payload) {
    const name = payload.name.trim();
    if (!name) {
        throw new errors_1.AppError(400, "Campaign name is required", "VALIDATION");
    }
    const selectionMode = payload.selectionMode === "all_verified"
        ? client_1.BulkSelectionMode.ALL_VERIFIED
        : payload.selectionMode === "manual"
            ? client_1.BulkSelectionMode.MANUAL
            : client_1.BulkSelectionMode.GROUPS;
    const scheduleType = payload.scheduleType === "scheduled"
        ? client_1.BulkScheduleType.SCHEDULED
        : client_1.BulkScheduleType.IMMEDIATE;
    let scheduledAt = null;
    if (scheduleType === client_1.BulkScheduleType.SCHEDULED) {
        if (!payload.scheduledAt?.trim()) {
            throw new errors_1.AppError(400, "Scheduled time is required", "VALIDATION");
        }
        scheduledAt = new Date(payload.scheduledAt);
        if (Number.isNaN(scheduledAt.getTime())) {
            throw new errors_1.AppError(400, "Invalid scheduled time", "VALIDATION");
        }
    }
    const basePhones = await resolveRecipientPhones(workspaceId, selectionMode, payload.groupIds, payload.manualPhones);
    const antiBlock = (0, bulk_campaign_safety_service_1.normalizeAntiBlock)(payload.antiBlock);
    const phones = await (0, bulk_campaign_safety_service_1.applyPhoneFilters)(workspaceId, basePhones, antiBlock);
    if (phones.length === 0) {
        throw new errors_1.AppError(400, "No recipients remain after anti-block filters", "NO_RECIPIENTS");
    }
    await assertDevices(workspaceId, payload.deviceIds);
    const deviceModeEnum = parseDeviceMode(payload.deviceMode);
    if (deviceModeEnum === client_1.BulkDeviceMode.SINGLE && payload.deviceIds.length !== 1) {
        throw new errors_1.AppError(400, "Single device mode requires exactly one selected device", "VALIDATION");
    }
    const delayNorm = normalizeDelayRangeSec(payload.delayMinSec, payload.delayMaxSec);
    let templateId = null;
    let bodyText = null;
    let kind;
    if (payload.kind === "text") {
        const text = payload.bodyText?.trim() ?? "";
        if (!text) {
            throw new errors_1.AppError(400, "Message text is required", "VALIDATION");
        }
        if (text.length > 4096) {
            throw new errors_1.AppError(400, "Message is too long (max 4096 characters)", "VALIDATION");
        }
        bodyText = text;
        kind = client_1.OutboundKind.TEXT;
    }
    else {
        if (!payload.templateId) {
            throw new errors_1.AppError(400, "Template is required", "VALIDATION");
        }
        const tpl = await (0, templates_service_1.requireActiveTemplate)(workspaceId, payload.templateId);
        templateId = tpl.id;
        kind = client_1.OutboundKind.TEMPLATE;
    }
    const deviceIdsJson = payload.deviceIds;
    const recipientPhonesJson = (0, bulk_campaign_safety_service_1.toJsonValue)(phones);
    const attachmentType = payload.attachmentType?.trim() === ""
        ? null
        : payload.attachmentType?.trim().slice(0, 32) ?? null;
    let attachmentAssetId = null;
    const rawAsset = payload.attachmentAssetId?.trim();
    if (rawAsset) {
        const asset = await prisma_1.prisma.templateMediaAsset.findFirst({
            where: { id: rawAsset, workspaceId },
        });
        if (!asset) {
            throw new errors_1.AppError(404, "Attachment file not found", "NOT_FOUND");
        }
        attachmentAssetId = asset.id;
    }
    const initialStatus = scheduleType === client_1.BulkScheduleType.IMMEDIATE
        ? client_1.BulkCampaignStatus.COMPLETED
        : client_1.BulkCampaignStatus.SCHEDULED;
    const campaign = await prisma_1.prisma.bulkCampaign.create({
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
                    groupIds: payload.groupIds,
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
    let dispatched = 0;
    if (scheduleType === client_1.BulkScheduleType.IMMEDIATE) {
        dispatched = await executeCampaignDispatch({
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
        await prisma_1.prisma.bulkCampaign.update({
            where: { id: campaign.id },
            data: { status: client_1.BulkCampaignStatus.COMPLETED },
        });
    }
    const refreshed = await prisma_1.prisma.bulkCampaign.findUniqueOrThrow({
        where: { id: campaign.id },
        include: {
            attachmentAsset: { select: { id: true, originalName: true } },
        },
    });
    const note = scheduleType === client_1.BulkScheduleType.SCHEDULED
        ? "Campaign saved as scheduled. A background worker can read scheduled campaigns and enqueue sends when you connect delivery."
        : env_1.env.WHATSAPP_BRIDGE_ENABLED
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
async function executeCampaignDispatch(args) {
    const { campaignId, workspaceId, phones, deviceIds, deviceMode, kind, bodyText, templateId, attachmentType, attachmentAssetId, delayMinSec, delayMaxSec, maxRetries, antiBlock, } = args;
    let dispatched = 0;
    let consecutiveFailures = 0;
    async function waitUntilSendAllowed() {
        while (antiBlock.enabled && !(0, bulk_campaign_safety_service_1.canSendAt)(new Date(), antiBlock)) {
            await (0, bulk_campaign_safety_service_1.sleepMs)(30_000);
        }
    }
    const templateRow = kind === client_1.OutboundKind.TEMPLATE && templateId
        ? await prisma_1.prisma.messageTemplate.findFirst({
            where: { id: templateId, workspaceId },
        })
        : null;
    if (kind === client_1.OutboundKind.TEMPLATE && !templateRow) {
        throw new errors_1.AppError(404, "Template not found", "NOT_FOUND");
    }
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        for (let i = 0; i < phones.length; i += OUTBOUND_CHUNK) {
            const slice = phones.slice(i, i + OUTBOUND_CHUNK);
            const rows = slice.map((toPhone, j) => {
                const globalIdx = i + j;
                const devId = deviceMode === client_1.BulkDeviceMode.ROUND_ROBIN
                    ? deviceIds[globalIdx % deviceIds.length]
                    : deviceIds[0];
                return {
                    workspaceId,
                    deviceId: devId,
                    toPhone,
                    kind,
                    bodyText,
                    templateId,
                    bulkCampaignId: campaignId,
                    status: client_1.OutboundStatus.SIMULATED,
                    providerRef: "bulk:demo:no_provider",
                    errorMessage: antiBlock.enabled
                        ? "Simulated mode: anti-block send-time checks are not executed."
                        : null,
                };
            });
            await prisma_1.prisma.outboundMessage.createMany({ data: rows });
            dispatched += rows.length;
        }
        return dispatched;
    }
    for (let i = 0; i < phones.length; i++) {
        await waitUntilSendAllowed();
        if ((0, bulk_campaign_safety_service_1.shouldStopByFailLimit)(consecutiveFailures, antiBlock)) {
            break;
        }
        const toPhone = phones[i];
        const primaryDeviceId = deviceMode === client_1.BulkDeviceMode.ROUND_ROBIN
            ? deviceIds[i % deviceIds.length]
            : deviceIds[0];
        const personalizedText = kind === client_1.OutboundKind.TEXT
            ? antiBlock.enabled && antiBlock.spintaxEnabled
                ? (0, bulk_campaign_safety_service_1.applySpintax)(bodyText ?? "")
                : bodyText ?? ""
            : null;
        const row = await prisma_1.prisma.outboundMessage.create({
            data: {
                workspaceId,
                deviceId: primaryDeviceId,
                toPhone,
                kind,
                bodyText: personalizedText ?? bodyText,
                templateId,
                bulkCampaignId: campaignId,
                status: client_1.OutboundStatus.QUEUED,
            },
        });
        try {
            let jid;
            try {
                jid = (0, whatsapp_jid_1.e164ToWhatsAppJid)(toPhone);
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : "Invalid phone";
                throw new Error(msg);
            }
            const outgoing = kind === client_1.OutboundKind.TEXT
                ? await (0, wa_outbound_content_1.buildBulkTextCampaignContent)(workspaceId, personalizedText ?? "", attachmentType, attachmentAssetId)
                : await (0, wa_outbound_content_1.buildTemplateWhatsAppContent)(workspaceId, templateRow);
            const trySend = async (devId) => {
                const sock = await waSession.waitForOpenWaSocket(devId, workspaceId);
                if (!sock) {
                    throw new Error("WhatsApp session offline — open Devices and reconnect.");
                }
                return sock.sendMessage(jid, outgoing);
            };
            let usedDeviceId = primaryDeviceId;
            let waMsg = null;
            let attempts = 0;
            let lastErr = null;
            const retries = Math.max(0, maxRetries);
            while (attempts <= retries && waMsg === null) {
                attempts += 1;
                if (deviceMode === client_1.BulkDeviceMode.FAILOVER) {
                    for (const devId of deviceIds) {
                        try {
                            waMsg = await trySend(devId);
                            usedDeviceId = devId;
                            break;
                        }
                        catch (e) {
                            lastErr = e instanceof Error ? e : new Error(String(e));
                        }
                    }
                }
                else {
                    try {
                        waMsg = await trySend(primaryDeviceId);
                    }
                    catch (e) {
                        lastErr = e instanceof Error ? e : new Error(String(e));
                    }
                }
            }
            if (!waMsg) {
                throw lastErr ?? new Error("All send attempts failed");
            }
            const key = waMsg.key;
            const providerRef = key?.id ? `${key.remoteJid ?? jid}:${key.id}` : "baileys:bulk";
            const summaryText = kind === client_1.OutboundKind.TEXT
                ? (personalizedText ?? "").trim()
                : templateRow.body?.trim() || templateRow.name.trim() || "(template)";
            await prisma_1.prisma.outboundMessage.update({
                where: { id: row.id },
                data: {
                    deviceId: usedDeviceId,
                    status: client_1.OutboundStatus.SENT,
                    providerRef,
                    ...(kind === client_1.OutboundKind.TEMPLATE ? { bodyText: summaryText.slice(0, 4096) } : {}),
                },
            });
            consecutiveFailures = 0;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await prisma_1.prisma.outboundMessage.update({
                where: { id: row.id },
                data: {
                    status: client_1.OutboundStatus.FAILED,
                    errorMessage: msg.slice(0, 500),
                },
            });
            consecutiveFailures += 1;
        }
        dispatched += 1;
        if (antiBlock.enabled && dispatched % antiBlock.batchPauseEvery === 0) {
            await (0, bulk_campaign_safety_service_1.sleepMs)(antiBlock.batchPauseSec * 1000);
        }
        else if (i < phones.length - 1) {
            await (0, bulk_campaign_safety_service_1.sleepMs)((0, bulk_campaign_safety_service_1.randomDelayMs)(delayMinSec, delayMaxSec));
        }
    }
    return dispatched;
}
function parseStoredPhones(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((x) => typeof x === "string");
}
async function runScheduledCampaignsOnce() {
    if (scheduledLoopBusy)
        return 0;
    scheduledLoopBusy = true;
    try {
        const now = new Date();
        const due = await prisma_1.prisma.bulkCampaign.findMany({
            where: {
                status: client_1.BulkCampaignStatus.SCHEDULED,
                scheduleType: client_1.BulkScheduleType.SCHEDULED,
                scheduledAt: { lte: now },
            },
            orderBy: { scheduledAt: "asc" },
            take: 5,
        });
        let processed = 0;
        for (const campaign of due) {
            const phones = await (0, bulk_campaign_safety_service_1.applyPhoneFilters)(campaign.workspaceId, parseStoredPhones(campaign.recipientPhones), {
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
            });
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
            await prisma_1.prisma.bulkCampaign.update({
                where: { id: campaign.id },
                data: { status: client_1.BulkCampaignStatus.COMPLETED },
            });
            processed += 1;
        }
        return processed;
    }
    catch (err) {
        console.error("[bulk-campaigns] scheduled worker error", err);
        return 0;
    }
    finally {
        scheduledLoopBusy = false;
    }
}
function startBulkCampaignScheduledWorker() {
    if (scheduledLoopStarted)
        return;
    scheduledLoopStarted = true;
    setInterval(() => {
        void runScheduledCampaignsOnce();
    }, SCHEDULED_POLL_MS);
}

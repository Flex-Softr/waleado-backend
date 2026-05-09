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
exports.syncThreadsFromOutbound = syncThreadsFromOutbound;
exports.listLiveChatThreads = listLiveChatThreads;
exports.createLiveChatThread = createLiveChatThread;
exports.updateLiveChatThread = updateLiveChatThread;
exports.listLiveChatMessages = listLiveChatMessages;
exports.sendLiveChatMessage = sendLiveChatMessage;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const errors_1 = require("../lib/errors");
const phone_1 = require("../lib/phone");
const whatsapp_jid_1 = require("../lib/whatsapp-jid");
const messaging = __importStar(require("./messaging.service"));
const waSession = __importStar(require("./wa-device-session.service"));
const template_media_assets_service_1 = require("./template-media-assets.service");
const live_chat_message_codec_1 = require("./live_chat_message_codec");
const live_chat_media_sign_service_1 = require("./live_chat_media_sign.service");
function outboundStatusToApi(s) {
    switch (s) {
        case client_1.OutboundStatus.SENT:
            return "sent";
        case client_1.OutboundStatus.FAILED:
            return "failed";
        case client_1.OutboundStatus.SIMULATED:
            return "simulated";
        default:
            return "queued";
    }
}
function previewFromOutbound(o) {
    const t = o.bodyText?.trim();
    if (t)
        return t.slice(0, 200);
    return o.kind === client_1.OutboundKind.TEMPLATE ? "[Template]" : "Message";
}
function threadToJson(t) {
    const label = t.peerLabel.trim();
    return {
        id: t.id,
        deviceId: t.deviceId,
        deviceName: t.device.name,
        peerPhone: t.peerPhone,
        peerLabel: t.peerLabel,
        displayTitle: label || t.peerPhone,
        lastPreview: t.lastPreview,
        lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
    };
}
function normalizePhoneForMatch(phone) {
    const digits = phone.replace(/\D+/g, "");
    return digits.startsWith("00") ? digits.slice(2) : digits;
}
async function syncThreadsFromOutbound(workspaceId, deviceId) {
    const device = await prisma_1.prisma.device.findFirst({
        where: { id: deviceId, workspaceId },
    });
    if (!device) {
        throw new errors_1.AppError(404, "Device not found", "NOT_FOUND");
    }
    const groups = await prisma_1.prisma.outboundMessage.groupBy({
        by: ["toPhone"],
        where: { workspaceId, deviceId },
    });
    for (const g of groups) {
        const last = await prisma_1.prisma.outboundMessage.findFirst({
            where: { workspaceId, deviceId, toPhone: g.toPhone },
            orderBy: { createdAt: "desc" },
        });
        if (!last)
            continue;
        const preview = previewFromOutbound(last);
        const existing = await prisma_1.prisma.liveChatThread.findUnique({
            where: {
                workspaceId_deviceId_peerPhone: {
                    workspaceId,
                    deviceId,
                    peerPhone: g.toPhone,
                },
            },
        });
        if (!existing) {
            await prisma_1.prisma.liveChatThread.create({
                data: {
                    workspaceId,
                    deviceId,
                    peerPhone: g.toPhone,
                    lastPreview: preview,
                    lastMessageAt: last.createdAt,
                },
            });
            continue;
        }
        const shouldBump = !existing.lastMessageAt || last.createdAt > existing.lastMessageAt;
        if (shouldBump) {
            await prisma_1.prisma.liveChatThread.update({
                where: { id: existing.id },
                data: { lastPreview: preview, lastMessageAt: last.createdAt },
            });
        }
    }
}
async function listLiveChatThreads(workspaceId, deviceId) {
    await syncThreadsFromOutbound(workspaceId, deviceId);
    const rows = await prisma_1.prisma.liveChatThread.findMany({
        where: { workspaceId, deviceId },
        include: { device: { select: { name: true } } },
        orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    });
    if (rows.length === 0)
        return [];
    const peerPhones = [...new Set(rows.map((r) => r.peerPhone))];
    const savedContacts = await prisma_1.prisma.contact.findMany({
        where: {
            group: { workspaceId },
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        select: { phone: true, name: true },
    });
    const savedNameByPhone = new Map();
    for (const c of savedContacts) {
        const normalized = normalizePhoneForMatch(c.phone);
        const name = c.name.trim();
        if (!normalized || !name || savedNameByPhone.has(normalized))
            continue;
        savedNameByPhone.set(normalized, name);
    }
    return rows.map((row) => {
        const json = threadToJson(row);
        const normalizedPeer = normalizePhoneForMatch(row.peerPhone);
        let savedName = savedNameByPhone.get(normalizedPeer);
        if (!savedName && normalizedPeer) {
            let bestLen = -1;
            for (const [savedPhone, candidateName] of savedNameByPhone) {
                if (normalizedPeer.endsWith(savedPhone) ||
                    savedPhone.endsWith(normalizedPeer)) {
                    if (savedPhone.length > bestLen) {
                        bestLen = savedPhone.length;
                        savedName = candidateName;
                    }
                }
            }
        }
        if (!savedName)
            return json;
        return {
            ...json,
            displayTitle: savedName,
        };
    });
}
async function createLiveChatThread(workspaceId, input) {
    const phone = (0, phone_1.validateAndFormatPhone)(input.peerPhone);
    if (!phone.valid) {
        throw new errors_1.AppError(400, phone.message, "INVALID_PHONE");
    }
    const device = await prisma_1.prisma.device.findFirst({
        where: { id: input.deviceId, workspaceId },
    });
    if (!device) {
        throw new errors_1.AppError(404, "Device not found", "NOT_FOUND");
    }
    const label = (input.peerLabel ?? "").trim().slice(0, 200);
    const existing = await prisma_1.prisma.liveChatThread.findUnique({
        where: {
            workspaceId_deviceId_peerPhone: {
                workspaceId,
                deviceId: input.deviceId,
                peerPhone: phone.e164,
            },
        },
        include: { device: { select: { name: true } } },
    });
    if (existing) {
        if (label.length > 0) {
            const updated = await prisma_1.prisma.liveChatThread.update({
                where: { id: existing.id },
                data: { peerLabel: label },
                include: { device: { select: { name: true } } },
            });
            return threadToJson(updated);
        }
        return threadToJson(existing);
    }
    const row = await prisma_1.prisma.liveChatThread.create({
        data: {
            workspaceId,
            deviceId: input.deviceId,
            peerPhone: phone.e164,
            peerLabel: label,
        },
        include: { device: { select: { name: true } } },
    });
    return threadToJson(row);
}
async function updateLiveChatThread(workspaceId, threadId, input) {
    const thread = await prisma_1.prisma.liveChatThread.findFirst({
        where: { id: threadId, workspaceId },
        include: { device: { select: { name: true } } },
    });
    if (!thread) {
        throw new errors_1.AppError(404, "Thread not found", "NOT_FOUND");
    }
    if (input.peerLabel === undefined) {
        return threadToJson(thread);
    }
    const label = input.peerLabel.trim().slice(0, 200);
    const updated = await prisma_1.prisma.liveChatThread.update({
        where: { id: threadId },
        data: { peerLabel: label },
        include: { device: { select: { name: true } } },
    });
    return threadToJson(updated);
}
async function listLiveChatMessages(workspaceId, threadId, opts) {
    const thread = await prisma_1.prisma.liveChatThread.findFirst({
        where: { id: threadId, workspaceId },
    });
    if (!thread) {
        throw new errors_1.AppError(404, "Thread not found", "NOT_FOUND");
    }
    const limit = Math.max(1, Math.min(100, opts?.limit ?? 50));
    const liveMsgs = await prisma_1.prisma.liveChatMessage.findMany({
        where: {
            threadId,
            ...(opts?.cursor
                ? { createdAt: { lt: new Date(opts.cursor) } }
                : {}),
        },
        orderBy: { createdAt: "asc" },
        take: limit,
    });
    const outboundMsgs = await prisma_1.prisma.outboundMessage.findMany({
        where: {
            workspaceId,
            deviceId: thread.deviceId,
            toPhone: thread.peerPhone,
        },
        orderBy: { createdAt: "asc" },
    });
    const linkedOutboundIds = new Set(liveMsgs.map((m) => m.outboundMessageId).filter(Boolean));
    const outboundById = new Map(outboundMsgs.map((o) => [o.id, o]));
    const rows = [];
    for (const m of liveMsgs) {
        const linked = m.outboundMessageId
            ? outboundById.get(m.outboundMessageId)
            : undefined;
        rows.push({
            id: m.id,
            direction: m.direction === client_1.LiveChatMessageDirection.INBOUND ? "inbound" : "outbound",
            bodyText: (0, live_chat_message_codec_1.decodeLiveChatBodyText)(m.bodyText).text,
            createdAt: m.createdAt.toISOString(),
            ...(() => {
                const decoded = (0, live_chat_message_codec_1.decodeLiveChatBodyText)(m.bodyText);
                const assetId = decoded.meta.assetId;
                return {
                    kind: decoded.meta.kind,
                    assetId,
                    mediaUrl: assetId
                        ? (() => {
                            const tok = (0, live_chat_media_sign_service_1.createLiveChatMediaToken)({
                                workspaceId,
                                assetId,
                            });
                            return `/v1/live-chat/media/${assetId}?wid=${encodeURIComponent(workspaceId)}&exp=${tok.exp}&sig=${tok.sig}`;
                        })()
                        : undefined,
                    mimeType: decoded.meta.mimeType,
                    fileName: decoded.meta.fileName,
                };
            })(),
            ...(linked
                ? { deliveryStatus: outboundStatusToApi(linked.status) }
                : {}),
        });
    }
    for (const o of outboundMsgs) {
        if (linkedOutboundIds.has(o.id))
            continue;
        rows.push({
            id: `ob:${o.id}`,
            direction: "outbound",
            bodyText: o.bodyText?.trim() || previewFromOutbound(o),
            createdAt: o.createdAt.toISOString(),
            deliveryStatus: outboundStatusToApi(o.status),
        });
    }
    rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return {
        messages: rows,
        nextCursor: liveMsgs.length === limit
            ? liveMsgs[liveMsgs.length - 1]?.createdAt.toISOString() ?? null
            : null,
    };
}
async function sendLiveChatMessage(workspaceId, threadId, input) {
    const text = (input.bodyText ?? "").trim();
    const mediaAssetId = input.mediaAssetId?.trim() || null;
    if (!text && !mediaAssetId) {
        throw new errors_1.AppError(400, "Message text or media is required", "VALIDATION");
    }
    if (text.length > 4096) {
        throw new errors_1.AppError(400, "Message is too long (max 4096 characters)", "VALIDATION");
    }
    const thread = await prisma_1.prisma.liveChatThread.findFirst({
        where: { id: threadId, workspaceId },
    });
    if (!thread) {
        throw new errors_1.AppError(404, "Thread not found", "NOT_FOUND");
    }
    if (!mediaAssetId) {
        const outbound = await messaging.sendSingleMessage(workspaceId, {
            deviceId: thread.deviceId,
            toPhone: thread.peerPhone,
            kind: "text",
            bodyText: text,
        });
        const created = await prisma_1.prisma.liveChatMessage.create({
            data: {
                threadId: thread.id,
                direction: client_1.LiveChatMessageDirection.OUTBOUND,
                bodyText: text,
                outboundMessageId: outbound.id,
            },
        });
        await prisma_1.prisma.liveChatThread.update({
            where: { id: thread.id },
            data: {
                lastPreview: text.slice(0, 200),
                lastMessageAt: new Date(),
            },
        });
        return {
            message: {
                id: created.id,
                direction: "outbound",
                bodyText: created.bodyText,
                createdAt: created.createdAt.toISOString(),
                deliveryStatus: outbound.status,
            },
            outbound,
        };
    }
    const device = await prisma_1.prisma.device.findFirst({
        where: { id: thread.deviceId, workspaceId },
    });
    if (!device) {
        throw new errors_1.AppError(404, "Device not found", "NOT_FOUND");
    }
    if (device.status !== client_1.DeviceStatus.CONNECTED) {
        throw new errors_1.AppError(400, "Device is not connected", "DEVICE_NOT_CONNECTED");
    }
    const sock = await waSession.waitForOpenWaSocket(device.id, workspaceId);
    if (!sock) {
        throw new errors_1.AppError(503, "WhatsApp session is offline", "WA_SESSION_OFFLINE");
    }
    const media = await (0, template_media_assets_service_1.getAssetFilePath)(workspaceId, mediaAssetId);
    if (!media) {
        throw new errors_1.AppError(404, "Uploaded media not found", "NOT_FOUND");
    }
    const fs = await Promise.resolve().then(() => __importStar(require("fs/promises")));
    const data = await fs.readFile(media.absolutePath);
    const mime = media.mimeType.toLowerCase();
    const waPayload = mime.startsWith("image/")
        ? { image: data, caption: text || undefined, mimetype: media.mimeType }
        : mime.startsWith("video/")
            ? { video: data, caption: text || undefined, mimetype: media.mimeType }
            : mime.startsWith("audio/")
                ? {
                    audio: data,
                    // Send as true WhatsApp voice note (PTT).
                    ptt: true,
                    mimetype: mime.includes("ogg") || mime.includes("opus")
                        ? "audio/ogg; codecs=opus"
                        : media.mimeType,
                }
                : {
                    document: data,
                    fileName: media.originalName,
                    mimetype: media.mimeType,
                    caption: text || undefined,
                };
    const jid = (0, whatsapp_jid_1.e164ToWhatsAppJid)(thread.peerPhone);
    const row = await prisma_1.prisma.outboundMessage.create({
        data: {
            workspaceId,
            deviceId: device.id,
            toPhone: thread.peerPhone,
            kind: client_1.OutboundKind.TEXT,
            bodyText: text || media.originalName,
            status: client_1.OutboundStatus.QUEUED,
        },
    });
    try {
        const sent = await sock.sendMessage(jid, waPayload);
        const providerRef = sent?.key?.id
            ? `${sent.key.remoteJid ?? jid}:${sent.key.id}`
            : "baileys";
        await prisma_1.prisma.outboundMessage.update({
            where: { id: row.id },
            data: {
                status: client_1.OutboundStatus.SENT,
                providerRef,
            },
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : "WhatsApp send failed";
        await prisma_1.prisma.outboundMessage.update({
            where: { id: row.id },
            data: {
                status: client_1.OutboundStatus.FAILED,
                errorMessage: msg.slice(0, 500),
            },
        });
        throw new errors_1.AppError(502, `WhatsApp could not send media: ${msg}`, "WHATSAPP_SEND_FAILED");
    }
    const kind = mime.startsWith("image/")
        ? "image"
        : mime.startsWith("video/")
            ? "video"
            : mime.startsWith("audio/")
                ? "audio"
                : "document";
    const storedText = (0, live_chat_message_codec_1.encodeLiveChatBodyText)(text, {
        kind,
        assetId: mediaAssetId,
        mimeType: media.mimeType,
        fileName: media.originalName,
    });
    const created = await prisma_1.prisma.liveChatMessage.create({
        data: {
            threadId: thread.id,
            direction: client_1.LiveChatMessageDirection.OUTBOUND,
            bodyText: storedText,
            outboundMessageId: row.id,
        },
    });
    await prisma_1.prisma.liveChatThread.update({
        where: { id: thread.id },
        data: {
            lastPreview: text || `[${kind}] ${media.originalName}`,
            lastMessageAt: new Date(),
        },
    });
    return {
        message: {
            id: created.id,
            direction: "outbound",
            bodyText: text,
            kind,
            assetId: mediaAssetId,
            mediaUrl: (() => {
                const tok = (0, live_chat_media_sign_service_1.createLiveChatMediaToken)({ workspaceId, assetId: mediaAssetId });
                return `/v1/live-chat/media/${mediaAssetId}?wid=${encodeURIComponent(workspaceId)}&exp=${tok.exp}&sig=${tok.sig}`;
            })(),
            mimeType: media.mimeType,
            fileName: media.originalName,
            createdAt: created.createdAt.toISOString(),
            deliveryStatus: "sent",
        },
        outbound: {
            id: row.id,
            status: "sent",
            kind: "text",
            toPhone: row.toPhone,
            deviceId: row.deviceId,
            templateId: null,
            bodyText: row.bodyText,
            createdAt: row.createdAt.toISOString(),
            note: `Sent media from device “${device.name}”.`,
        },
    };
}

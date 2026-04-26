"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestInboundLiveChatMessages = ingestInboundLiveChatMessages;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const template_media_assets_service_1 = require("./template-media-assets.service");
const live_chat_message_codec_1 = require("./live_chat_message_codec");
const PROCESSED_INBOUND_TTL_MS = 10 * 60 * 1000;
const processedInboundMessageKeys = new Map();
function pruneProcessedInbound(now) {
    for (const [k, t] of processedInboundMessageKeys) {
        if (now - t > PROCESSED_INBOUND_TTL_MS) {
            processedInboundMessageKeys.delete(k);
        }
    }
}
function claimInboundMessage(deviceId, m, now) {
    const id = m.key.id;
    const remote = m.key.remoteJid;
    if (!id || !remote)
        return true;
    pruneProcessedInbound(now);
    const participant = m.key.participant ?? "";
    const key = `${deviceId}|${remote}|${participant}|${id}`;
    if (processedInboundMessageKeys.has(key))
        return false;
    processedInboundMessageKeys.set(key, now);
    return true;
}
function destinationJidForInbound(m) {
    const primary = m.key.remoteJid;
    if (!primary || primary === "status@broadcast")
        return null;
    const alt = m.key.remoteJidAlt;
    if (typeof alt === "string" &&
        alt.length > 0 &&
        primary.endsWith("@lid")) {
        return alt;
    }
    return primary;
}
function phoneFromJid(jid) {
    const m = jid.match(/^(\d+)@/);
    return m ? `+${m[1]}` : null;
}
function waTimestampToDate(ts) {
    if (typeof ts === "number" && Number.isFinite(ts)) {
        const sec = ts > 1_000_000_000_000 ? Math.floor(ts / 1000) : ts;
        return new Date(sec * 1000);
    }
    if (typeof ts === "object" && ts !== null) {
        const o = ts;
        if (typeof o.toNumber === "function") {
            const n = o.toNumber();
            if (Number.isFinite(n))
                return new Date(n * 1000);
        }
        else if (typeof o.low === "number" && Number.isFinite(o.low)) {
            return new Date(o.low * 1000);
        }
    }
    return new Date();
}
function textFromExtractedContent(inner) {
    if (!inner || typeof inner !== "object")
        return "";
    const i = inner;
    if (typeof i.conversation === "string" && i.conversation.trim()) {
        return i.conversation.trim();
    }
    const ext = i.extendedTextMessage;
    if (ext && typeof ext.text === "string" && ext.text.trim()) {
        return ext.text.trim();
    }
    const btn = i.buttonsResponseMessage;
    if (btn) {
        if (typeof btn.selectedDisplayText === "string" &&
            btn.selectedDisplayText.trim()) {
            return btn.selectedDisplayText.trim();
        }
        if (typeof btn.selectedButtonId === "string" &&
            btn.selectedButtonId.trim()) {
            return btn.selectedButtonId.trim();
        }
    }
    const list = i.listResponseMessage;
    if (list) {
        if (typeof list.title === "string" && list.title.trim()) {
            return list.title.trim();
        }
        if (typeof list.description === "string" && list.description.trim()) {
            return list.description.trim();
        }
    }
    return "";
}
function inboundTextFromMessage(m, extractMessageContent) {
    const raw = m.message;
    if (!raw)
        return "";
    const inner = extractMessageContent(raw);
    const fromInner = textFromExtractedContent(inner);
    if (fromInner)
        return fromInner;
    const fromRaw = textFromExtractedContent(raw);
    if (fromRaw)
        return fromRaw;
    return "Message";
}
async function ingestInboundLiveChatMessages(workspaceId, deviceId, messages, extractMessageContent, downloadMedia) {
    if (!messages.length)
        return;
    const now = Date.now();
    for (const m of messages) {
        if (!m.message || m.key.fromMe)
            continue;
        if (!claimInboundMessage(deviceId, m, now))
            continue;
        const jid = destinationJidForInbound(m);
        if (!jid)
            continue;
        const peerPhone = phoneFromJid(jid);
        if (!peerPhone)
            continue;
        const extracted = extractMessageContent(m.message) ?? m.message;
        const raw = extracted;
        let bodyText = inboundTextFromMessage(m, extractMessageContent);
        let meta;
        const media = raw?.imageMessage
            ? { kind: "image", msg: raw.imageMessage }
            : raw?.videoMessage
                ? { kind: "video", msg: raw.videoMessage }
                : raw?.audioMessage
                    ? { kind: "audio", msg: raw.audioMessage }
                    : raw?.documentMessage
                        ? {
                            kind: "document",
                            msg: raw.documentMessage,
                        }
                        : raw?.stickerMessage
                            ? {
                                kind: "sticker",
                                msg: raw.stickerMessage,
                            }
                            : null;
        if (media) {
            const detectedMimeType = (typeof media.msg?.mimetype === "string" && media.msg.mimetype) ||
                "application/octet-stream";
            const caption = typeof media.msg?.caption === "string" ? media.msg.caption.trim() : "";
            const detectedFileName = typeof media.msg?.fileName === "string"
                ? media.msg.fileName
                : `${media.kind}-${Date.now()}`;
            bodyText = caption || `[${media.kind}] ${detectedFileName}`;
            meta = {
                kind: media.kind,
                mimeType: detectedMimeType,
                fileName: detectedFileName,
                caption: caption || undefined,
            };
            if (downloadMedia) {
                try {
                    const buffer = await downloadMedia(m);
                    if (buffer && buffer.byteLength > 0) {
                        const saved = await (0, template_media_assets_service_1.recordTemplateMediaBuffer)(workspaceId, {
                            buffer,
                            mimeType: detectedMimeType,
                            originalName: detectedFileName,
                        });
                        meta.assetId = saved.id;
                    }
                }
                catch (err) {
                    console.warn("[live-chat] inbound media download failed", err);
                }
            }
        }
        else if (raw?.locationMessage && typeof raw.locationMessage === "object") {
            const loc = raw.locationMessage;
            const lat = typeof loc.degreesLatitude === "number" ? loc.degreesLatitude : 0;
            const lng = typeof loc.degreesLongitude === "number" ? loc.degreesLongitude : 0;
            bodyText = bodyText || `Location: ${lat}, ${lng}`;
            meta = { kind: "location", lat, lng };
        }
        else if (raw?.contactMessage && typeof raw.contactMessage === "object") {
            const contact = raw.contactMessage;
            const displayName = typeof contact.displayName === "string" ? contact.displayName : "Contact";
            const vcard = typeof contact.vcard === "string" ? contact.vcard : undefined;
            bodyText = `Contact: ${displayName}`;
            meta = { kind: "contact", vcard };
        }
        const storedBody = (0, live_chat_message_codec_1.encodeLiveChatBodyText)(bodyText, meta);
        const createdAt = waTimestampToDate(m.messageTimestamp);
        const preview = bodyText.slice(0, 200);
        const thread = await prisma_1.prisma.liveChatThread.upsert({
            where: {
                workspaceId_deviceId_peerPhone: {
                    workspaceId,
                    deviceId,
                    peerPhone,
                },
            },
            update: {
                lastPreview: preview,
                lastMessageAt: createdAt,
            },
            create: {
                workspaceId,
                deviceId,
                peerPhone,
                lastPreview: preview,
                lastMessageAt: createdAt,
            },
        });
        await prisma_1.prisma.liveChatMessage.create({
            data: {
                threadId: thread.id,
                direction: client_1.LiveChatMessageDirection.INBOUND,
                bodyText: storedBody,
                createdAt,
            },
        });
    }
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatchChatbotFlowForInbound = dispatchChatbotFlowForInbound;
const prisma_1 = require("../lib/prisma");
const auto_reply_keywords_1 = require("../lib/auto-reply-keywords");
const wa_outbound_content_1 = require("./wa-outbound-content");
const PROCESSED_TTL_MS = 120_000;
const processedInboundKeys = new Map();
const cooldownUntilByKey = new Map();
function pruneProcessedMap(now) {
    for (const [k, t] of processedInboundKeys) {
        if (now - t > PROCESSED_TTL_MS)
            processedInboundKeys.delete(k);
    }
}
function claimMessage(m, now) {
    const remote = m.key.remoteJid;
    const id = m.key.id;
    if (!remote || !id)
        return true;
    pruneProcessedMap(now);
    const participant = m.key.participant ?? "";
    const key = `${remote}|${participant}|${String(id)}`;
    if (processedInboundKeys.has(key))
        return false;
    processedInboundKeys.set(key, now);
    return true;
}
function waMessageTimestampSeconds(ts) {
    if (ts == null)
        return null;
    if (typeof ts === "number" && Number.isFinite(ts))
        return ts;
    if (typeof ts === "object" && ts !== null) {
        const o = ts;
        if (typeof o.toNumber === "function") {
            const n = o.toNumber();
            return Number.isFinite(n) ? n : null;
        }
        if (typeof o.low === "number" && Number.isFinite(o.low))
            return o.low;
    }
    const n = Number(ts);
    return Number.isFinite(n) ? n : null;
}
function shouldProcessUpsertType(m, upsertType) {
    if (upsertType === "notify")
        return true;
    const raw = waMessageTimestampSeconds(m.messageTimestamp);
    if (raw == null || raw === 0)
        return false;
    const sec = raw > 1_000_000_000_000 ? Math.floor(raw / 1000) : raw;
    const msgMs = sec * 1000;
    const ageMs = Date.now() - msgMs;
    const maxAgeMs = 24 * 60 * 60 * 1000;
    return ageMs >= -120_000 && ageMs <= maxAgeMs;
}
function destinationJid(m) {
    const primary = m.key.remoteJid;
    if (!primary || primary === "status@broadcast")
        return null;
    const alt = m.key.remoteJidAlt;
    if (typeof alt === "string" && alt.length > 0 && primary.endsWith("@lid")) {
        return alt;
    }
    return primary;
}
function textFromExtractedContent(inner) {
    if (!inner || typeof inner !== "object")
        return "";
    const i = inner;
    if (typeof i.conversation === "string" && i.conversation.trim()) {
        return i.conversation;
    }
    const ext = i.extendedTextMessage;
    if (ext && typeof ext.text === "string" && ext.text.trim()) {
        return ext.text;
    }
    return "";
}
function inboundTextFromMessage(m, extractMessageContent) {
    const raw = m.message;
    if (!raw)
        return "";
    const inner = extractMessageContent(raw);
    const fromInner = textFromExtractedContent(inner);
    if (fromInner.trim())
        return fromInner.trim();
    return textFromExtractedContent(raw).trim();
}
function jsonObjectOrNull(v) {
    if (!v || typeof v !== "object" || Array.isArray(v))
        return null;
    return v;
}
function templateIdFromNode(node) {
    const p = jsonObjectOrNull(node.payload);
    if (!p)
        return null;
    return typeof p.templateId === "string" ? p.templateId : null;
}
function messageBodyFromNode(node) {
    const p = jsonObjectOrNull(node.payload);
    if (!p)
        return "";
    return typeof p.messageBody === "string" ? p.messageBody.trim() : "";
}
async function sendMessageNode(workspaceId, sock, toJid, node) {
    const p = jsonObjectOrNull(node.payload);
    const formType = p && p.messageFormType === "template" ? "template" : "text";
    if (formType === "template") {
        const tid = templateIdFromNode(node);
        if (!tid)
            return false;
        const tpl = await prisma_1.prisma.messageTemplate.findFirst({
            where: { id: tid, workspaceId, active: true },
            select: {
                typeId: true,
                body: true,
                name: true,
                media: true,
                footer: true,
            },
        });
        if (!tpl)
            return false;
        const content = await (0, wa_outbound_content_1.buildTemplateWhatsAppContent)(workspaceId, tpl);
        await sock.sendMessage(toJid, content);
        return true;
    }
    const text = messageBodyFromNode(node);
    if (!text)
        return false;
    await sock.sendMessage(toJid, { text });
    return true;
}
function firstTriggeredFlow(flows, inboundText) {
    for (const flow of flows) {
        const matched = (0, auto_reply_keywords_1.matchAutoReplyTriggers)(inboundText, {
            triggerType: "CONTAINS",
            caseSensitive: false,
            rawKeywordField: flow.triggerKeywords,
        });
        if (matched)
            return { flow, matchedKeyword: matched };
    }
    return null;
}
async function dispatchChatbotFlowForInbound(deviceId, workspaceId, sock, messages, extractMessageContent, upsertType) {
    if (messages.length === 0)
        return;
    const flows = await prisma_1.prisma.chatbotFlow.findMany({
        where: { workspaceId, deviceId, active: true },
        include: {
            nodes: {
                orderBy: { sortOrder: "asc" },
            },
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
    if (flows.length === 0)
        return;
    const now = Date.now();
    for (const m of messages) {
        if (!m.message || m.key.fromMe)
            continue;
        if (!shouldProcessUpsertType(m, upsertType))
            continue;
        if (!claimMessage(m, now))
            continue;
        const remoteJid = destinationJid(m);
        if (!remoteJid)
            continue;
        const inboundText = inboundTextFromMessage(m, extractMessageContent);
        if (!inboundText)
            continue;
        const selected = firstTriggeredFlow(flows, inboundText);
        if (!selected)
            continue;
        const { flow, matchedKeyword } = selected;
        const participant = m.key.participant ?? "";
        const cooldownKey = `${deviceId}:${flow.id}:${remoteJid}:${participant}:${matchedKeyword}`;
        if (flow.cooldownMinutes > 0) {
            const until = cooldownUntilByKey.get(cooldownKey) ?? 0;
            if (now < until)
                continue;
        }
        let sentAny = false;
        for (const node of flow.nodes) {
            if (node.kind !== "MESSAGE")
                continue;
            try {
                const sent = await sendMessageNode(workspaceId, sock, remoteJid, node);
                sentAny = sentAny || sent;
            }
            catch (err) {
                console.error("[chatbot] message node send failed", err);
            }
        }
        if (!sentAny)
            continue;
        if (flow.cooldownMinutes > 0) {
            cooldownUntilByKey.set(cooldownKey, now + flow.cooldownMinutes * 60_000);
        }
        await prisma_1.prisma.chatbotFlow.update({
            where: { id: flow.id },
            data: { conversationCount: { increment: 1 } },
        });
    }
}

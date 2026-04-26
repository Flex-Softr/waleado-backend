"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatchAutoRepliesForInbound = dispatchAutoRepliesForInbound;
const auto_reply_keywords_1 = require("../lib/auto-reply-keywords");
const prisma_1 = require("../lib/prisma");
const env_1 = require("../env");
const openai_auto_reply_service_1 = require("./openai_auto_reply.service");
const wa_outbound_content_1 = require("./wa-outbound-content");
/**
 * Cooldown is per matched trigger phrase (not only per rule), so one rule with
 * keywords "hi,hello,help" can reply to "hi" and later to "hello" without the
 * second being blocked by the first.
 * Key: `${deviceId}:${ruleId}:${remoteJid}:${participant}:${trigger}`
 */
const cooldownUntilByKey = new Map();
/** Avoid double replies when Baileys emits the same message on `notify` and `append`. */
const PROCESSED_TTL_MS = 120_000;
const processedMessageKeys = new Map();
function pruneProcessedMap(now) {
    for (const [k, t] of processedMessageKeys) {
        if (now - t > PROCESSED_TTL_MS)
            processedMessageKeys.delete(k);
    }
}
/** Returns false if this key was already processed recently. */
function claimMessageForAutoReply(m, now) {
    const r = m.key.remoteJid;
    const id = m.key.id;
    if (!r || id == null || id === "")
        return true;
    pruneProcessedMap(now);
    const p = m.key.participant ?? "";
    const key = `${r}|${p}|${String(id)}`;
    if (processedMessageKeys.has(key))
        return false;
    processedMessageKeys.set(key, now);
    return true;
}
/** Baileys may set `messageTimestamp` as a number or a protobuf Long (`toNumber` / `low`). */
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
/**
 * `append` is used for offline / buffered delivery (`node.attrs.offline` in Baileys).
 * `notify` is always treated as live. For `append`, require a parseable timestamp and
 * a generous max age so delayed delivery still auto-replies.
 */
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
/** Prefer @s.whatsapp.net JID when WhatsApp uses @lid for the primary remoteJid. */
function destinationJid(m) {
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
    const btn = i.buttonsResponseMessage;
    if (btn) {
        const d = btn.selectedDisplayText;
        if (typeof d === "string" && d.trim())
            return d;
        const bid = btn.selectedButtonId;
        if (typeof bid === "string" && bid.trim())
            return bid;
    }
    const list = i.listResponseMessage;
    if (list) {
        if (typeof list.title === "string" && list.title.trim())
            return list.title;
        if (typeof list.description === "string" && list.description.trim()) {
            return list.description;
        }
        const sel = list.singleSelectReply;
        const rowId = sel?.selectedRowId;
        if (typeof rowId === "string" && rowId.trim())
            return rowId;
    }
    const inter = i.interactiveResponseMessage;
    if (inter) {
        const body = inter.body;
        const bt = body?.text;
        if (typeof bt === "string" && bt.trim())
            return bt;
    }
    for (const key of [
        "imageMessage",
        "videoMessage",
        "documentMessage",
    ]) {
        const media = i[key];
        if (media?.caption && typeof media.caption === "string" && media.caption.trim()) {
            return media.caption;
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
    if (fromInner.trim())
        return fromInner.trim();
    return textFromExtractedContent(raw).trim();
}
function plainTextFromTemplate(tpl) {
    const body = (tpl.body ?? "").trim();
    const name = tpl.name.trim();
    const base = body || name;
    const foot = (tpl.footer ?? "").trim();
    if (base && foot)
        return `${base}\n\n${foot}`;
    if (base)
        return base;
    return foot;
}
function replyBodyForRule(rule) {
    if (rule.templateId && rule.template) {
        const fromTpl = plainTextFromTemplate(rule.template);
        if (fromTpl.length > 0)
            return fromTpl;
    }
    return rule.response.trim();
}
function parseOpenAiJson(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return null;
    const o = raw;
    const apiKey = typeof o.apiKey === "string" ? o.apiKey : "";
    if (!apiKey.trim())
        return null;
    return {
        apiKey,
        model: typeof o.model === "string" ? o.model : undefined,
        baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : undefined,
        systemPrompt: typeof o.systemPrompt === "string" ? o.systemPrompt : undefined,
        temperature: typeof o.temperature === "number" ? o.temperature : undefined,
        maxTokens: typeof o.maxTokens === "number" ? o.maxTokens : null,
    };
}
async function buildAutoReplyPayload(workspaceId, rule, inboundText) {
    if (rule.openAiEnabled && rule.openAiSettings) {
        const parsed = parseOpenAiJson(rule.openAiSettings);
        if (parsed?.apiKey) {
            try {
                const aiText = await (0, openai_auto_reply_service_1.generateOpenAiReply)(parsed, inboundText);
                return { text: aiText };
            }
            catch (e) {
                console.error("[auto-reply] OpenAI failed, using fallback", e);
            }
        }
    }
    const mode = rule.messageMode;
    if (mode === "TEMPLATE" && rule.template) {
        try {
            return await (0, wa_outbound_content_1.buildTemplateWhatsAppContent)(workspaceId, rule.template);
        }
        catch (e) {
            console.error("[auto-reply] template send build failed", e);
        }
    }
    if (mode === "MEDIA" && rule.mediaAssetId) {
        try {
            return await (0, wa_outbound_content_1.buildAutoReplyMediaContent)(workspaceId, rule.mediaAssetId, rule.mediaCaption);
        }
        catch (e) {
            console.error("[auto-reply] media build failed", e);
        }
    }
    const txt = replyBodyForRule(rule);
    if (!txt)
        return null;
    return { text: txt };
}
/** Rules must be sorted by priority asc then createdAt; first matching rule wins. */
function selectRuleToExecute(rules, inboundText) {
    function triggerSpecificity(t) {
        switch (t) {
            case "EXACT":
                return 60;
            case "KEYWORD":
                return 50;
            case "STARTS_WITH":
            case "ENDS_WITH":
                return 40;
            case "REGEX":
                return 30;
            case "CONTAINS":
            default:
                return 20;
        }
    }
    let currentPriority = null;
    let best = null;
    for (const rule of rules) {
        if (currentPriority === null)
            currentPriority = rule.priority;
        if (rule.priority !== currentPriority) {
            return best ? { rule: best.rule, matchedKeyword: best.matchedKeyword } : null;
        }
        const triggerType = rule.triggerType;
        const matched = (0, auto_reply_keywords_1.matchAutoReplyTriggers)(inboundText, {
            triggerType,
            caseSensitive: rule.caseSensitive,
            rawKeywordField: rule.keyword,
        });
        if (!matched)
            continue;
        const score = triggerSpecificity(triggerType) * 10_000 + matched.length;
        if (!best || score > best.score) {
            best = { rule, matchedKeyword: matched, score };
        }
    }
    return best ? { rule: best.rule, matchedKeyword: best.matchedKeyword } : null;
}
/**
 * Loads active rules for this device (ordered by priority), finds the first rule whose
 * keyword list matches the inbound text, applies cooldown per matched keyword, sends.
 */
async function dispatchAutoRepliesForInbound(deviceId, workspaceId, sock, messages, extractMessageContent, upsertType) {
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED || messages.length === 0) {
        return;
    }
    const rules = await prisma_1.prisma.autoReplyRule.findMany({
        where: { workspaceId, deviceId, active: true },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        include: {
            template: true,
        },
    });
    if (rules.length === 0) {
        return;
    }
    const now = Date.now();
    for (const m of messages) {
        if (!m.message || m.key.fromMe)
            continue;
        if (!shouldProcessUpsertType(m, upsertType))
            continue;
        if (!claimMessageForAutoReply(m, now))
            continue;
        const remoteJid = destinationJid(m);
        if (!remoteJid)
            continue;
        const text = inboundTextFromMessage(m, extractMessageContent);
        if (!text)
            continue;
        const participant = m.key.participant ?? "";
        const selected = selectRuleToExecute(rules, text);
        if (!selected)
            continue;
        const { rule, matchedKeyword } = selected;
        const cooldownKey = `${deviceId}:${rule.id}:${remoteJid}:${participant}:${matchedKeyword}`;
        if (rule.cooldownMinutes > 0) {
            const until = cooldownUntilByKey.get(cooldownKey) ?? 0;
            if (now < until)
                continue;
        }
        const payload = await buildAutoReplyPayload(workspaceId, rule, text);
        if (!payload)
            continue;
        try {
            await sock.sendMessage(remoteJid, payload);
            if (rule.cooldownMinutes > 0) {
                cooldownUntilByKey.set(cooldownKey, now + rule.cooldownMinutes * 60_000);
            }
            await prisma_1.prisma.autoReplyRule.update({
                where: { id: rule.id },
                data: { responseCount: { increment: 1 } },
            });
        }
        catch (e) {
            console.error("[auto-reply] sendMessage failed", e);
        }
    }
}

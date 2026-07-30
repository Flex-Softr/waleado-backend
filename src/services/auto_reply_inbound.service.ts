import type { AutoReplyRule, MessageTemplate } from "@prisma/client";
import type { AnyMessageContent } from "@whiskeysockets/baileys";
import type { proto, WASocket, WAMessage } from "@whiskeysockets/baileys";
import {
  matchAutoReplyTriggers,
  type AutoReplyTriggerTypeName,
} from "../lib/auto-reply-keywords";
import { prisma } from "../lib/prisma";
import { env } from "../env";
import {
  WA_DEVICE_INTERACTIVE_MIN_GAP_MS,
  withDeviceOutboundGate,
} from "../lib/wa-device-outbound-gate";
import { generateOpenAiReply } from "./openai_auto_reply.service";
import { resolveAiSettingsToOpenAiInput } from "./ai_credential_resolve.service";
import {
  buildAutoReplyMediaContent,
  buildTemplateWhatsAppContent,
} from "./wa-outbound-content";

/**
 * Cooldown is per matched trigger phrase (not only per rule), so one rule with
 * keywords "hi,hello,help" can reply to "hi" and later to "hello" without the
 * second being blocked by the first.
 * Key: `${deviceId}:${ruleId}:${remoteJid}:${participant}:${trigger}`
 */
const cooldownUntilByKey = new Map<string, number>();

/** Avoid double replies when Baileys emits the same message on `notify` and `append`. */
const PROCESSED_TTL_MS = 120_000;
const processedMessageKeys = new Map<string, number>();

function pruneProcessedMap(now: number): void {
  for (const [k, t] of processedMessageKeys) {
    if (now - t > PROCESSED_TTL_MS) processedMessageKeys.delete(k);
  }
}

/** Returns false if this key was already processed recently. */
function claimMessageForAutoReply(m: WAMessage, now: number): boolean {
  const r = m.key.remoteJid;
  const id = m.key.id;
  if (!r || id == null || id === "") return true;
  pruneProcessedMap(now);
  const p = m.key.participant ?? "";
  const key = `${r}|${p}|${String(id)}`;
  if (processedMessageKeys.has(key)) return false;
  processedMessageKeys.set(key, now);
  return true;
}

/** Baileys may set `messageTimestamp` as a number or a protobuf Long (`toNumber` / `low`). */
function waMessageTimestampSeconds(ts: unknown): number | null {
  if (ts == null) return null;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "object" && ts !== null) {
    const o = ts as { toNumber?: () => number; low?: number };
    if (typeof o.toNumber === "function") {
      const n = o.toNumber();
      return Number.isFinite(n) ? n : null;
    }
    if (typeof o.low === "number" && Number.isFinite(o.low)) return o.low;
  }
  const n = Number(ts);
  return Number.isFinite(n) ? n : null;
}

/**
 * `append` is used for offline / buffered delivery (`node.attrs.offline` in Baileys).
 * `notify` is always treated as live. For `append`, require a parseable timestamp and
 * a generous max age so delayed delivery still auto-replies.
 */
function shouldProcessUpsertType(
  m: WAMessage,
  upsertType: "notify" | "append"
): boolean {
  if (upsertType === "notify") return true;
  const raw = waMessageTimestampSeconds(m.messageTimestamp);
  if (raw == null || raw === 0) return false;
  const sec = raw > 1_000_000_000_000 ? Math.floor(raw / 1000) : raw;
  const msgMs = sec * 1000;
  const ageMs = Date.now() - msgMs;
  const maxAgeMs = 24 * 60 * 60 * 1000;
  return ageMs >= -120_000 && ageMs <= maxAgeMs;
}

/** Prefer @s.whatsapp.net JID when WhatsApp uses @lid for the primary remoteJid. */
function destinationJid(m: WAMessage): string | null {
  const primary = m.key.remoteJid;
  if (!primary || primary === "status@broadcast") return null;
  const alt = m.key.remoteJidAlt;
  if (
    typeof alt === "string" &&
    alt.length > 0 &&
    primary.endsWith("@lid")
  ) {
    return alt;
  }
  return primary;
}

function textFromExtractedContent(inner: object | null | undefined): string {
  if (!inner || typeof inner !== "object") return "";
  const i = inner as Record<string, unknown>;

  if (typeof i.conversation === "string" && i.conversation.trim()) {
    return i.conversation;
  }

  const ext = i.extendedTextMessage as Record<string, unknown> | undefined;
  if (ext && typeof ext.text === "string" && ext.text.trim()) {
    return ext.text;
  }

  const btn = i.buttonsResponseMessage as Record<string, unknown> | undefined;
  if (btn) {
    const d = btn.selectedDisplayText;
    if (typeof d === "string" && d.trim()) return d;
    const bid = btn.selectedButtonId;
    if (typeof bid === "string" && bid.trim()) return bid;
  }

  const list = i.listResponseMessage as Record<string, unknown> | undefined;
  if (list) {
    if (typeof list.title === "string" && list.title.trim()) return list.title;
    if (typeof list.description === "string" && list.description.trim()) {
      return list.description;
    }
    const sel = list.singleSelectReply as Record<string, unknown> | undefined;
    const rowId = sel?.selectedRowId;
    if (typeof rowId === "string" && rowId.trim()) return rowId;
  }

  const inter = i.interactiveResponseMessage as Record<string, unknown> | undefined;
  if (inter) {
    const body = inter.body as Record<string, unknown> | undefined;
    const bt = body?.text;
    if (typeof bt === "string" && bt.trim()) return bt;
  }

  for (const key of [
    "imageMessage",
    "videoMessage",
    "documentMessage",
  ] as const) {
    const media = i[key] as { caption?: string } | undefined;
    if (media?.caption && typeof media.caption === "string" && media.caption.trim()) {
      return media.caption;
    }
  }

  return "";
}

function inboundTextFromMessage(
  m: WAMessage,
  extractMessageContent: (
    content: proto.IMessage | null | undefined
  ) => proto.IMessage | undefined
): string {
  const raw = m.message;
  if (!raw) return "";
  const inner = extractMessageContent(raw);
  const fromInner = textFromExtractedContent(inner as object | null | undefined);
  if (fromInner.trim()) return fromInner.trim();
  return textFromExtractedContent(raw as object).trim();
}

function plainTextFromTemplate(tpl: {
  body: string | null;
  name: string;
  footer: string | null;
}): string {
  const body = (tpl.body ?? "").trim();
  const name = tpl.name.trim();
  const base = body || name;
  const foot = (tpl.footer ?? "").trim();
  if (base && foot) return `${base}\n\n${foot}`;
  if (base) return base;
  return foot;
}

function replyBodyForRule(rule: {
  response: string;
  templateId: string | null;
  template: {
    body: string | null;
    name: string;
    footer: string | null;
  } | null;
}): string {
  if (rule.templateId && rule.template) {
    const fromTpl = plainTextFromTemplate(rule.template);
    if (fromTpl.length > 0) return fromTpl;
  }
  return rule.response.trim();
}

type AutoReplyRuleRow = AutoReplyRule & {
  template: MessageTemplate | null;
};

async function buildAutoReplyPayload(
  workspaceId: string,
  rule: AutoReplyRuleRow,
  inboundText: string
): Promise<AnyMessageContent | null> {
  if (rule.openAiEnabled && rule.openAiSettings) {
    const resolved = await resolveAiSettingsToOpenAiInput(
      workspaceId,
      rule.openAiSettings
    );
    if (resolved?.apiKey) {
      try {
        const aiText = await generateOpenAiReply(resolved, inboundText);
        return { text: aiText };
      } catch (e) {
        console.error(
          "[auto-reply] AI reply failed, using fallback",
          e instanceof Error ? e.message : e
        );
      }
    } else {
      console.error(
        "[auto-reply] AI enabled but credentials could not be resolved; using fallback"
      );
    }
  }

  const mode = rule.messageMode;
  if (mode === "TEMPLATE" && rule.template) {
    try {
      return await buildTemplateWhatsAppContent(workspaceId, rule.template);
    } catch (e) {
      console.error("[auto-reply] template send build failed", e);
    }
  }
  if (mode === "MEDIA" && rule.mediaAssetId) {
    try {
      return await buildAutoReplyMediaContent(
        workspaceId,
        rule.mediaAssetId,
        rule.mediaCaption
      );
    } catch (e) {
      console.error("[auto-reply] media build failed", e);
    }
  }

  const txt = replyBodyForRule(rule);
  if (!txt) return null;
  return { text: txt };
}

/** Rules must be sorted by priority asc then createdAt; first matching rule wins. */
function selectRuleToExecute(
  rules: AutoReplyRuleRow[],
  inboundText: string
): { rule: AutoReplyRuleRow; matchedKeyword: string } | null {
  function triggerSpecificity(t: AutoReplyTriggerTypeName): number {
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

  let currentPriority: number | null = null;
  let best:
    | {
        rule: AutoReplyRuleRow;
        matchedKeyword: string;
        score: number;
      }
    | null = null;

  for (const rule of rules) {
    if (currentPriority === null) currentPriority = rule.priority;
    if (rule.priority !== currentPriority) {
      // Lowest-number priority group wins, but only if that group has a match.
      // If no rule matched in this group, continue to the next priority.
      if (best) {
        return { rule: best.rule, matchedKeyword: best.matchedKeyword };
      }
      currentPriority = rule.priority;
    }
    const triggerType = rule.triggerType as AutoReplyTriggerTypeName;
    const matched = matchAutoReplyTriggers(inboundText, {
      triggerType,
      caseSensitive: rule.caseSensitive,
      rawKeywordField: rule.keyword,
    });
    if (!matched) continue;
    const score = triggerSpecificity(triggerType) * 10_000 + matched.length;
    if (!best || score > best.score) {
      best = { rule, matchedKeyword: matched, score };
    }
  }
  return best ? { rule: best.rule, matchedKeyword: best.matchedKeyword } : null;
}

export type MessageUpsertKind = "notify" | "append";

/**
 * Loads active rules for this device (ordered by priority), finds the first rule whose
 * keyword list matches the inbound text, applies cooldown per matched keyword, sends.
 */
export async function dispatchAutoRepliesForInbound(
  deviceId: string,
  workspaceId: string,
  sock: WASocket,
  messages: WAMessage[],
  extractMessageContent: (
    content: proto.IMessage | null | undefined
  ) => proto.IMessage | undefined,
  upsertType: MessageUpsertKind
): Promise<void> {
  if (!env.WHATSAPP_BRIDGE_ENABLED || messages.length === 0) {
    return;
  }

  const rules = await prisma.autoReplyRule.findMany({
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
    if (!m.message || m.key.fromMe) continue;
    if (!shouldProcessUpsertType(m, upsertType)) continue;
    if (!claimMessageForAutoReply(m, now)) continue;

    const remoteJid = destinationJid(m);
    if (!remoteJid) continue;

    const text = inboundTextFromMessage(m, extractMessageContent);
    if (!text) continue;

    const participant = m.key.participant ?? "";

    const selected = selectRuleToExecute(rules, text);
    if (!selected) continue;

    const { rule, matchedKeyword } = selected;

    const cooldownKey = `${deviceId}:${rule.id}:${remoteJid}:${participant}:${matchedKeyword}`;
    if (rule.cooldownMinutes > 0) {
      const until = cooldownUntilByKey.get(cooldownKey) ?? 0;
      if (now < until) continue;
    }

    const payload = await buildAutoReplyPayload(workspaceId, rule, text);
    if (!payload) continue;

    try {
      await withDeviceOutboundGate(
        deviceId,
        { minGapMs: WA_DEVICE_INTERACTIVE_MIN_GAP_MS },
        () => sock.sendMessage(remoteJid, payload)
      );
      if (rule.cooldownMinutes > 0) {
        cooldownUntilByKey.set(
          cooldownKey,
          now + rule.cooldownMinutes * 60_000
        );
      }
      await prisma.autoReplyRule.update({
        where: { id: rule.id },
        data: { responseCount: { increment: 1 } },
      });
    } catch (e) {
      console.error("[auto-reply] sendMessage failed", e);
    }
  }
}

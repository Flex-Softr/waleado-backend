import type { ChatbotFlow, ChatbotFlowNode, MessageTemplate, Prisma } from "@prisma/client";
import type { proto, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { prisma } from "../lib/prisma";
import { matchAutoReplyTriggers } from "../lib/auto-reply-keywords";
import { buildTemplateWhatsAppContent } from "./wa-outbound-content";

type MessageUpsertKind = "notify" | "append";

const PROCESSED_TTL_MS = 120_000;
const processedInboundKeys = new Map<string, number>();
const cooldownUntilByKey = new Map<string, number>();

type FlowWithNodes = ChatbotFlow & {
  nodes: ChatbotFlowNode[];
};

function pruneProcessedMap(now: number): void {
  for (const [k, t] of processedInboundKeys) {
    if (now - t > PROCESSED_TTL_MS) processedInboundKeys.delete(k);
  }
}

function claimMessage(m: WAMessage, now: number): boolean {
  const remote = m.key.remoteJid;
  const id = m.key.id;
  if (!remote || !id) return true;
  pruneProcessedMap(now);
  const participant = m.key.participant ?? "";
  const key = `${remote}|${participant}|${String(id)}`;
  if (processedInboundKeys.has(key)) return false;
  processedInboundKeys.set(key, now);
  return true;
}

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

function shouldProcessUpsertType(
  m: WAMessage,
  upsertType: MessageUpsertKind
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

function destinationJid(m: WAMessage): string | null {
  const primary = m.key.remoteJid;
  if (!primary || primary === "status@broadcast") return null;
  const alt = m.key.remoteJidAlt;
  if (typeof alt === "string" && alt.length > 0 && primary.endsWith("@lid")) {
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

function jsonObjectOrNull(v: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function templateIdFromNode(node: ChatbotFlowNode): string | null {
  const p = jsonObjectOrNull(node.payload);
  if (!p) return null;
  return typeof p.templateId === "string" ? p.templateId : null;
}

function messageBodyFromNode(node: ChatbotFlowNode): string {
  const p = jsonObjectOrNull(node.payload);
  if (!p) return "";
  return typeof p.messageBody === "string" ? p.messageBody.trim() : "";
}

async function sendMessageNode(
  workspaceId: string,
  sock: WASocket,
  toJid: string,
  node: ChatbotFlowNode
): Promise<boolean> {
  const p = jsonObjectOrNull(node.payload);
  const formType =
    p && p.messageFormType === "template" ? "template" : "text";
  if (formType === "template") {
    const tid = templateIdFromNode(node);
    if (!tid) return false;
    const tpl = await prisma.messageTemplate.findFirst({
      where: { id: tid, workspaceId, active: true },
      select: {
        typeId: true,
        body: true,
        name: true,
        media: true,
        footer: true,
      },
    });
    if (!tpl) return false;
    const content = await buildTemplateWhatsAppContent(workspaceId, tpl);
    await sock.sendMessage(toJid, content);
    return true;
  }
  const text = messageBodyFromNode(node);
  if (!text) return false;
  await sock.sendMessage(toJid, { text });
  return true;
}

function firstTriggeredFlow(
  flows: FlowWithNodes[],
  inboundText: string
): { flow: FlowWithNodes; matchedKeyword: string } | null {
  for (const flow of flows) {
    const matched = matchAutoReplyTriggers(inboundText, {
      triggerType: "CONTAINS",
      caseSensitive: false,
      rawKeywordField: flow.triggerKeywords,
    });
    if (matched) return { flow, matchedKeyword: matched };
  }
  return null;
}

export async function dispatchChatbotFlowForInbound(
  deviceId: string,
  workspaceId: string,
  sock: WASocket,
  messages: WAMessage[],
  extractMessageContent: (
    content: proto.IMessage | null | undefined
  ) => proto.IMessage | undefined,
  upsertType: MessageUpsertKind
): Promise<void> {
  if (messages.length === 0) return;

  const flows = await prisma.chatbotFlow.findMany({
    where: { workspaceId, deviceId, active: true },
    include: {
      nodes: {
        orderBy: { sortOrder: "asc" },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  if (flows.length === 0) return;

  const now = Date.now();
  for (const m of messages) {
    if (!m.message || m.key.fromMe) continue;
    if (!shouldProcessUpsertType(m, upsertType)) continue;
    if (!claimMessage(m, now)) continue;

    const remoteJid = destinationJid(m);
    if (!remoteJid) continue;
    const inboundText = inboundTextFromMessage(m, extractMessageContent);
    if (!inboundText) continue;
    const selected = firstTriggeredFlow(flows, inboundText);
    if (!selected) continue;

    const { flow, matchedKeyword } = selected;
    const participant = m.key.participant ?? "";
    const cooldownKey = `${deviceId}:${flow.id}:${remoteJid}:${participant}:${matchedKeyword}`;
    if (flow.cooldownMinutes > 0) {
      const until = cooldownUntilByKey.get(cooldownKey) ?? 0;
      if (now < until) continue;
    }

    let sentAny = false;
    for (const node of flow.nodes) {
      if (node.kind !== "MESSAGE") continue;
      try {
        const sent = await sendMessageNode(workspaceId, sock, remoteJid, node);
        sentAny = sentAny || sent;
      } catch (err) {
        console.error("[chatbot] message node send failed", err);
      }
    }
    if (!sentAny) continue;

    if (flow.cooldownMinutes > 0) {
      cooldownUntilByKey.set(cooldownKey, now + flow.cooldownMinutes * 60_000);
    }
    await prisma.chatbotFlow.update({
      where: { id: flow.id },
      data: { conversationCount: { increment: 1 } },
    });
  }
}

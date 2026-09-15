import type { ChatbotFlow, ChatbotFlowNode, Prisma } from "@prisma/client";
import { LiveChatMessageDirection } from "@prisma/client";
import type { proto, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { prisma } from "../lib/prisma";
import { matchAutoReplyTriggers } from "../lib/auto-reply-keywords";
import {
  WA_DEVICE_INTERACTIVE_MIN_GAP_MS,
  withDeviceOutboundGate,
} from "../lib/wa-device-outbound-gate";
import { buildTemplateWhatsAppContent } from "./wa-outbound-content";
import { generateOpenAiReply } from "./openai_auto_reply.service";
import { resolveAiSettingsToOpenAiInput } from "./ai_credential_resolve.service";
import {
  PROCESS_BOOT_TIME,
  MAX_INBOUND_AUTO_REPLY_AGE_MS,
  waMessageTimestampMs,
  recordOutboundAutoReplyMessage,
} from "./auto_reply_inbound.service";

type MessageUpsertKind = "notify" | "append";

const PROCESSED_TTL_MS = 600_000;
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

function phoneFromJid(jid: string): string | null {
  const m = jid.match(/^(\d+)(?::\d+)?@/);
  return m ? `+${m[1]}` : null;
}

/**
 * Validates whether an inbound message should trigger a chatbot flow.
 * Prevents automated replies on app startup or session reconnect by verifying:
 * 1. Timestamp is valid.
 * 2. Message is not older than MAX_INBOUND_AUTO_REPLY_AGE_MS (2 minutes).
 * 3. Message was NOT sent before process startup (guards against replying to backlogs on restart).
 * 4. Message was NOT sent before the device session connected.
 */
function shouldProcessUpsertType(
  m: WAMessage,
  upsertType: MessageUpsertKind,
  _sessionConnectedAt?: number | null
): boolean {
  if (upsertType !== "notify" && upsertType !== "append") return false;

  const msgMs = waMessageTimestampMs(m.messageTimestamp);
  if (msgMs == null) return false;

  const now = Date.now();
  const ageMs = now - msgMs;

  // Reject messages older than 2 minutes or more than 60s in the future
  if (ageMs > MAX_INBOUND_AUTO_REPLY_AGE_MS || ageMs < -60_000) {
    return false;
  }

  // Startup guard: Never process messages sent before this app instance started
  if (msgMs < PROCESS_BOOT_TIME - 10_000) {
    return false;
  }

  return true;
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
    return i.conversation.trim();
  }

  const ext = i.extendedTextMessage as Record<string, unknown> | undefined;
  if (ext && typeof ext.text === "string" && ext.text.trim()) {
    return ext.text.trim();
  }

  const btn = i.buttonsResponseMessage as Record<string, unknown> | undefined;
  if (btn) {
    const d = btn.selectedDisplayText;
    if (typeof d === "string" && d.trim()) return d.trim();
    const bid = btn.selectedButtonId;
    if (typeof bid === "string" && bid.trim()) return bid.trim();
  }

  const tplBtn = i.templateButtonReplyMessage as Record<string, unknown> | undefined;
  if (tplBtn) {
    const d = tplBtn.selectedDisplayText;
    if (typeof d === "string" && d.trim()) return d.trim();
    const bid = tplBtn.selectedId;
    if (typeof bid === "string" && bid.trim()) return bid.trim();
  }

  const list = i.listResponseMessage as Record<string, unknown> | undefined;
  if (list) {
    if (typeof list.title === "string" && list.title.trim()) return list.title.trim();
    if (typeof list.description === "string" && list.description.trim()) {
      return list.description.trim();
    }
    const sel = list.singleSelectReply as Record<string, unknown> | undefined;
    const rowId = sel?.selectedRowId;
    if (typeof rowId === "string" && rowId.trim()) return rowId.trim();
  }

  const inter = i.interactiveResponseMessage as Record<string, unknown> | undefined;
  if (inter) {
    const body = inter.body as Record<string, unknown> | undefined;
    const bt = body?.text;
    if (typeof bt === "string" && bt.trim()) return bt.trim();
    const native = inter.nativeFlowResponseMessage as Record<string, unknown> | undefined;
    if (native) {
      if (typeof native.name === "string" && native.name.trim()) return native.name.trim();
      if (typeof native.paramsJson === "string" && native.paramsJson.trim()) {
        try {
          const parsed = JSON.parse(native.paramsJson);
          if (parsed && typeof parsed.id === "string") return parsed.id.trim();
        } catch {
          // ignore
        }
      }
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
  deviceId: string,
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
    await withDeviceOutboundGate(
      deviceId,
      { minGapMs: WA_DEVICE_INTERACTIVE_MIN_GAP_MS },
      () => sock.sendMessage(toJid, content)
    );
    return true;
  }
  const text = messageBodyFromNode(node);
  if (!text) return false;
  await withDeviceOutboundGate(
    deviceId,
    { minGapMs: WA_DEVICE_INTERACTIVE_MIN_GAP_MS },
    () => sock.sendMessage(toJid, { text })
  );
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

function inboundMessageKey(m: WAMessage): string | null {
  const remote = m.key.remoteJid;
  const id = m.key.id;
  if (!remote || id == null || id === "") return null;
  return `${remote}|${m.key.participant ?? ""}|${String(id)}`;
}

/**
 * Returns message keys that received a chatbot reply so auto-reply can skip them.
 */
export async function dispatchChatbotFlowForInbound(
  deviceId: string,
  workspaceId: string,
  sock: WASocket,
  messages: WAMessage[],
  extractMessageContent: (
    content: proto.IMessage | null | undefined
  ) => proto.IMessage | undefined,
  upsertType: MessageUpsertKind,
  sessionConnectedAt?: number | null
): Promise<Set<string>> {
  const handled = new Set<string>();
  if (messages.length === 0) return handled;

  const flows = await prisma.chatbotFlow.findMany({
    where: { workspaceId, deviceId, active: true },
    include: {
      nodes: {
        orderBy: { sortOrder: "asc" },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });
  if (flows.length === 0) return handled;

  const now = Date.now();
  for (const m of messages) {
    if (!m.message || m.key.fromMe) continue;
    if (!shouldProcessUpsertType(m, upsertType, sessionConnectedAt)) continue;
    if (!claimMessage(m, now)) continue;

    const msgKey = inboundMessageKey(m);
    const remoteJid = destinationJid(m);
    if (!remoteJid) continue;

    const peerPhone = phoneFromJid(remoteJid);

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

    if (flow.aiEnabled && flow.aiSettings) {
      try {
        const resolved = await resolveAiSettingsToOpenAiInput(
          workspaceId,
          flow.aiSettings
        );
        if (resolved?.apiKey) {
          const aiText = await generateOpenAiReply(resolved, inboundText);
          await withDeviceOutboundGate(
            deviceId,
            { minGapMs: WA_DEVICE_INTERACTIVE_MIN_GAP_MS },
            () => sock.sendMessage(remoteJid, { text: aiText })
          );
          sentAny = true;
          if (peerPhone) {
            void recordOutboundAutoReplyMessage(
              workspaceId,
              deviceId,
              peerPhone,
              aiText
            );
          }
        }
      } catch (err) {
        console.error("[chatbot] AI reply failed, using message nodes", err);
      }
    }

    if (!sentAny) {
      for (const node of flow.nodes) {
        if (node.kind !== "MESSAGE") continue;
        try {
          const sent = await sendMessageNode(
            workspaceId,
            deviceId,
            sock,
            remoteJid,
            node
          );
          sentAny = sentAny || sent;
          if (sent && peerPhone) {
            const body = messageBodyFromNode(node);
            if (body) {
              void recordOutboundAutoReplyMessage(
                workspaceId,
                deviceId,
                peerPhone,
                body
              );
            }
          }
        } catch (err) {
          console.error("[chatbot] message node send failed", err);
        }
      }
    }
    if (!sentAny) continue;

    if (msgKey) handled.add(msgKey);
    if (flow.cooldownMinutes > 0) {
      cooldownUntilByKey.set(cooldownKey, now + flow.cooldownMinutes * 60_000);
    }
    await prisma.chatbotFlow.update({
      where: { id: flow.id },
      data: { conversationCount: { increment: 1 } },
    });
  }
  return handled;
}

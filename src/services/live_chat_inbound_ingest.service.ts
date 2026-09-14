import { LiveChatMessageDirection } from "@prisma/client";
import type { proto, WAMessage } from "@whiskeysockets/baileys";
import { prisma } from "../lib/prisma";
import { attributeInboundReplyToCampaign } from "./campaign_engagement.service";
import { recordTemplateMediaBuffer } from "./template-media-assets.service";
import { encodeLiveChatBodyText } from "./live_chat_message_codec";

const PROCESSED_INBOUND_TTL_MS = 10 * 60 * 1000;
const processedInboundMessageKeys = new Map<string, number>();

function pruneProcessedInbound(now: number): void {
  for (const [k, t] of processedInboundMessageKeys) {
    if (now - t > PROCESSED_INBOUND_TTL_MS) {
      processedInboundMessageKeys.delete(k);
    }
  }
}

function claimInboundMessage(
  deviceId: string,
  m: WAMessage,
  now: number
): boolean {
  const id = m.key.id;
  const remote = m.key.remoteJid;
  if (!id || !remote) return true;
  pruneProcessedInbound(now);
  const participant = m.key.participant ?? "";
  const key = `${deviceId}|${remote}|${participant}|${id}`;
  if (processedInboundMessageKeys.has(key)) return false;
  processedInboundMessageKeys.set(key, now);
  return true;
}

function destinationJidForInbound(m: WAMessage): string | null {
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

function phoneFromJid(jid: string): string | null {
  // Device-linked JIDs may look like `8801…:1@s.whatsapp.net`.
  const m = jid.match(/^(\d+)(?::\d+)?@/);
  return m ? `+${m[1]}` : null;
}

function waTimestampToDate(ts: unknown): Date {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const sec = ts > 1_000_000_000_000 ? Math.floor(ts / 1000) : ts;
    return new Date(sec * 1000);
  }
  if (typeof ts === "object" && ts !== null) {
    const o = ts as { toNumber?: () => number; low?: number };
    if (typeof o.toNumber === "function") {
      const n = o.toNumber();
      if (Number.isFinite(n)) return new Date(n * 1000);
    } else if (typeof o.low === "number" && Number.isFinite(o.low)) {
      return new Date(o.low * 1000);
    }
  }
  return new Date();
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
    if (
      typeof btn.selectedDisplayText === "string" &&
      btn.selectedDisplayText.trim()
    ) {
      return btn.selectedDisplayText.trim();
    }
    if (
      typeof btn.selectedButtonId === "string" &&
      btn.selectedButtonId.trim()
    ) {
      return btn.selectedButtonId.trim();
    }
  }
  const list = i.listResponseMessage as Record<string, unknown> | undefined;
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
  if (fromInner) return fromInner;
  const fromRaw = textFromExtractedContent(raw as object);
  if (fromRaw) return fromRaw;
  return "Message";
}

export async function ingestInboundLiveChatMessages(
  workspaceId: string,
  deviceId: string,
  messages: WAMessage[],
  extractMessageContent: (
    content: proto.IMessage | null | undefined
  ) => proto.IMessage | undefined,
  downloadMedia?: (msg: WAMessage) => Promise<Buffer | null>
): Promise<void> {
  if (!messages.length) return;
  const now = Date.now();
  for (const m of messages) {
    if (!m.message || m.key.fromMe) continue;
    if (!claimInboundMessage(deviceId, m, now)) continue;
    const jid = destinationJidForInbound(m);
    if (!jid) continue;
    const peerPhone = phoneFromJid(jid);
    if (!peerPhone) continue;
    const extracted =
      extractMessageContent(m.message as proto.IMessage) ?? m.message;
    const raw = extracted as Record<string, unknown>;
    let bodyText = inboundTextFromMessage(m, extractMessageContent);
    let meta: Record<string, unknown> | undefined;
    const media = raw?.imageMessage
      ? { kind: "image", msg: raw.imageMessage as Record<string, unknown> }
      : raw?.videoMessage
        ? { kind: "video", msg: raw.videoMessage as Record<string, unknown> }
        : raw?.audioMessage
          ? { kind: "audio", msg: raw.audioMessage as Record<string, unknown> }
          : raw?.documentMessage
            ? {
                kind: "document",
                msg: raw.documentMessage as Record<string, unknown>,
              }
            : raw?.stickerMessage
              ? {
                  kind: "sticker",
                  msg: raw.stickerMessage as Record<string, unknown>,
                }
              : null;
    if (media) {
      const detectedMimeType =
        (typeof media.msg?.mimetype === "string" && media.msg.mimetype) ||
        "application/octet-stream";
      const caption =
        typeof media.msg?.caption === "string" ? media.msg.caption.trim() : "";
      const detectedFileName =
        typeof media.msg?.fileName === "string"
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
            const saved = await recordTemplateMediaBuffer(workspaceId, {
              buffer,
              mimeType: detectedMimeType,
              originalName: detectedFileName,
            });
            meta.assetId = saved.id;
          }
        } catch (err) {
          console.warn("[live-chat] inbound media download failed", err);
        }
      }
    } else if (raw?.locationMessage && typeof raw.locationMessage === "object") {
      const loc = raw.locationMessage as Record<string, unknown>;
      const lat = typeof loc.degreesLatitude === "number" ? loc.degreesLatitude : 0;
      const lng =
        typeof loc.degreesLongitude === "number" ? loc.degreesLongitude : 0;
      bodyText = bodyText || `Location: ${lat}, ${lng}`;
      meta = { kind: "location", lat, lng };
    } else if (raw?.contactMessage && typeof raw.contactMessage === "object") {
      const contact = raw.contactMessage as Record<string, unknown>;
      const displayName =
        typeof contact.displayName === "string" ? contact.displayName : "Contact";
      const vcard = typeof contact.vcard === "string" ? contact.vcard : undefined;
      bodyText = `Contact: ${displayName}`;
      meta = { kind: "contact", vcard };
    }
    const storedBody = encodeLiveChatBodyText(bodyText, meta as never);
    const createdAt = waTimestampToDate(m.messageTimestamp);
    const preview = bodyText.slice(0, 200);

    const thread = await prisma.liveChatThread.upsert({
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

    const existingMessage = await prisma.liveChatMessage.findFirst({
      where: {
        threadId: thread.id,
        direction: LiveChatMessageDirection.INBOUND,
        createdAt,
        bodyText: storedBody,
      },
      select: { id: true },
    });

    const message = existingMessage
      ? existingMessage
      : await prisma.liveChatMessage.create({
          data: {
            threadId: thread.id,
            direction: LiveChatMessageDirection.INBOUND,
            bodyText: storedBody,
            createdAt,
          },
        });

    if (!existingMessage) {
      await attributeInboundReplyToCampaign({
        workspaceId,
        deviceId,
        peerPhone,
        bodyText,
        repliedAt: createdAt,
        liveChatMessageId: message.id,
      });
    }
  }
}

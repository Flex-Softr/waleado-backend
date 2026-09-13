import {
  DeviceStatus,
  LiveChatMessageDirection,
  OutboundKind,
  OutboundStatus,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { validateAndFormatPhone } from "../lib/phone";
import { e164ToWhatsAppJid } from "../lib/whatsapp-jid";
import {
  WA_DEVICE_INTERACTIVE_MIN_GAP_MS,
  withDeviceOutboundGate,
} from "../lib/wa-device-outbound-gate";
import * as messaging from "./messaging.service";
import * as waSession from "./wa-device-session.service";
import { getAssetFilePath } from "./template-media-assets.service";
import {
  decodeLiveChatBodyText,
  encodeLiveChatBodyText,
} from "./live_chat_message_codec";
import { createLiveChatMediaToken } from "./live_chat_media_sign.service";
import { clearActiveAiSessionsForPhone } from "./auto_reply_inbound.service";

export type LiveChatThreadJson = {
  id: string;
  deviceId: string;
  deviceName: string;
  peerPhone: string;
  peerLabel: string;
  displayTitle: string;
  lastPreview: string;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LiveChatMessageRowJson = {
  id: string;
  direction: "inbound" | "outbound";
  bodyText: string;
  createdAt: string;
  kind?: string;
  assetId?: string;
  mediaUrl?: string;
  mimeType?: string;
  fileName?: string;
  deliveryStatus?: "queued" | "sent" | "failed" | "simulated";
};

export type LiveChatMessagesPageJson = {
  messages: LiveChatMessageRowJson[];
  nextCursor: string | null;
};

function outboundStatusToApi(
  s: OutboundStatus
): NonNullable<LiveChatMessageRowJson["deliveryStatus"]> {
  switch (s) {
    case OutboundStatus.SENT:
      return "sent";
    case OutboundStatus.FAILED:
      return "failed";
    case OutboundStatus.SIMULATED:
      return "simulated";
    default:
      return "queued";
  }
}

function previewFromOutbound(o: {
  bodyText: string | null;
  kind: OutboundKind;
}): string {
  const t = o.bodyText?.trim();
  if (t) return t.slice(0, 200);
  return o.kind === OutboundKind.TEMPLATE ? "[Template]" : "Message";
}

function threadToJson(t: {
  id: string;
  deviceId: string;
  peerPhone: string;
  peerLabel: string;
  lastPreview: string;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  device: { name: string };
}): LiveChatThreadJson {
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

function normalizePhoneForMatch(phone: string): string {
  const digits = phone.replace(/\D+/g, "");
  return digits.startsWith("00") ? digits.slice(2) : digits;
}

export async function syncThreadsFromOutbound(
  workspaceId: string,
  deviceId: string
): Promise<void> {
  const device = await prisma.device.findFirst({
    where: { id: deviceId, workspaceId },
  });
  if (!device) {
    return;
  }

  const groups = await prisma.outboundMessage.groupBy({
    by: ["toPhone"],
    where: { workspaceId, deviceId },
  });

  for (const g of groups) {
    const last = await prisma.outboundMessage.findFirst({
      where: { workspaceId, deviceId, toPhone: g.toPhone },
      orderBy: { createdAt: "desc" },
    });
    if (!last) continue;

    const preview = previewFromOutbound(last);
    const existing = await prisma.liveChatThread.findUnique({
      where: {
        workspaceId_deviceId_peerPhone: {
          workspaceId,
          deviceId,
          peerPhone: g.toPhone,
        },
      },
    });

    if (!existing) {
      await prisma.liveChatThread.create({
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

    const shouldBump =
      !existing.lastMessageAt || last.createdAt > existing.lastMessageAt;
    if (shouldBump) {
      await prisma.liveChatThread.update({
        where: { id: existing.id },
        data: { lastPreview: preview, lastMessageAt: last.createdAt },
      });
    }
  }
}

export async function listLiveChatThreads(
  workspaceId: string,
  deviceId: string
): Promise<LiveChatThreadJson[]> {
  await syncThreadsFromOutbound(workspaceId, deviceId);

  const rows = await prisma.liveChatThread.findMany({
    where: { workspaceId, deviceId },
    include: { device: { select: { name: true } } },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
  });

  if (rows.length === 0) return [];

  const peerPhones = [...new Set(rows.map((r) => r.peerPhone))];
  const savedContacts = await prisma.contact.findMany({
    where: {
      group: { workspaceId },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: { phone: true, name: true },
  });

  const savedNameByPhone = new Map<string, string>();
  for (const c of savedContacts) {
    const normalized = normalizePhoneForMatch(c.phone);
    const name = c.name.trim();
    if (!normalized || !name || savedNameByPhone.has(normalized)) continue;
    savedNameByPhone.set(normalized, name);
  }

  return rows.map((row) => {
    const json = threadToJson(row);
    const normalizedPeer = normalizePhoneForMatch(row.peerPhone);
    let savedName = savedNameByPhone.get(normalizedPeer);
    if (!savedName && normalizedPeer) {
      let bestLen = -1;
      for (const [savedPhone, candidateName] of savedNameByPhone) {
        if (
          normalizedPeer.endsWith(savedPhone) ||
          savedPhone.endsWith(normalizedPeer)
        ) {
          if (savedPhone.length > bestLen) {
            bestLen = savedPhone.length;
            savedName = candidateName;
          }
        }
      }
    }
    if (!savedName) return json;
    return {
      ...json,
      displayTitle: savedName,
    };
  });
}

export async function createLiveChatThread(
  workspaceId: string,
  input: { deviceId: string; peerPhone: string; peerLabel?: string }
): Promise<LiveChatThreadJson> {
  const phone = validateAndFormatPhone(input.peerPhone);
  if (!phone.valid) {
    throw new AppError(400, phone.message, "INVALID_PHONE");
  }

  const device = await prisma.device.findFirst({
    where: { id: input.deviceId, workspaceId },
  });
  if (!device) {
    throw new AppError(404, "Device not found", "NOT_FOUND");
  }

  const label = (input.peerLabel ?? "").trim().slice(0, 200);

  const existing = await prisma.liveChatThread.findUnique({
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
      const updated = await prisma.liveChatThread.update({
        where: { id: existing.id },
        data: { peerLabel: label },
        include: { device: { select: { name: true } } },
      });
      return threadToJson(updated);
    }
    return threadToJson(existing);
  }

  const row = await prisma.liveChatThread.create({
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

export async function updateLiveChatThread(
  workspaceId: string,
  threadId: string,
  input: { peerLabel?: string }
): Promise<LiveChatThreadJson> {
  const thread = await prisma.liveChatThread.findFirst({
    where: { id: threadId, workspaceId },
    include: { device: { select: { name: true } } },
  });
  if (!thread) {
    throw new AppError(404, "Thread not found", "NOT_FOUND");
  }

  if (input.peerLabel === undefined) {
    return threadToJson(thread);
  }

  const label = input.peerLabel.trim().slice(0, 200);
  const updated = await prisma.liveChatThread.update({
    where: { id: threadId },
    data: { peerLabel: label },
    include: { device: { select: { name: true } } },
  });
  return threadToJson(updated);
}

export async function listLiveChatMessages(
  workspaceId: string,
  threadId: string,
  opts?: { cursor?: string; limit?: number }
): Promise<LiveChatMessagesPageJson> {
  const thread = await prisma.liveChatThread.findFirst({
    where: { id: threadId, workspaceId },
  });
  if (!thread) {
    throw new AppError(404, "Thread not found", "NOT_FOUND");
  }

  const limit = Math.max(1, Math.min(100, opts?.limit ?? 50));
  const liveMsgs = await prisma.liveChatMessage.findMany({
    where: {
      threadId,
      ...(opts?.cursor
        ? { createdAt: { lt: new Date(opts.cursor) } }
        : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  const outboundMsgs = await prisma.outboundMessage.findMany({
    where: {
      workspaceId,
      deviceId: thread.deviceId,
      toPhone: thread.peerPhone,
    },
    orderBy: { createdAt: "asc" },
  });

  const linkedOutboundIds = new Set(
    liveMsgs.map((m) => m.outboundMessageId).filter(Boolean) as string[]
  );

  const outboundById = new Map(outboundMsgs.map((o) => [o.id, o]));

  const rows: LiveChatMessageRowJson[] = [];

  for (const m of liveMsgs) {
    const linked = m.outboundMessageId
      ? outboundById.get(m.outboundMessageId)
      : undefined;
    rows.push({
      id: m.id,
      direction: m.direction === LiveChatMessageDirection.INBOUND ? "inbound" : "outbound",
      bodyText: decodeLiveChatBodyText(m.bodyText).text,
      createdAt: m.createdAt.toISOString(),
      ...(() => {
        const decoded = decodeLiveChatBodyText(m.bodyText);
        const assetId = decoded.meta.assetId;
        return {
          kind: decoded.meta.kind,
          assetId,
          mediaUrl: assetId
            ? (() => {
                const tok = createLiveChatMediaToken({
                  workspaceId,
                  assetId,
                });
                return `/v1/live-chat/media/${assetId}?wid=${encodeURIComponent(
                  workspaceId
                )}&exp=${tok.exp}&sig=${tok.sig}`;
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
    if (linkedOutboundIds.has(o.id)) continue;
    rows.push({
      id: `ob:${o.id}`,
      direction: "outbound",
      bodyText: o.bodyText?.trim() || previewFromOutbound(o),
      createdAt: o.createdAt.toISOString(),
      deliveryStatus: outboundStatusToApi(o.status),
    });
  }

  rows.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  return {
    messages: rows,
    nextCursor:
      liveMsgs.length === limit
        ? liveMsgs[liveMsgs.length - 1]?.createdAt.toISOString() ?? null
        : null,
  };
}

export async function sendLiveChatMessage(
  workspaceId: string,
  threadId: string,
  input: { bodyText?: string; mediaAssetId?: string }
): Promise<{ message: LiveChatMessageRowJson; outbound: messaging.OutboundJson }> {
  const text = (input.bodyText ?? "").trim();
  const mediaAssetId = input.mediaAssetId?.trim() || null;
  if (!text && !mediaAssetId) {
    throw new AppError(400, "Message text or media is required", "VALIDATION");
  }
  if (text.length > 4096) {
    throw new AppError(
      400,
      "Message is too long (max 4096 characters)",
      "VALIDATION"
    );
  }

  const thread = await prisma.liveChatThread.findFirst({
    where: { id: threadId, workspaceId },
  });
  if (!thread) {
    throw new AppError(404, "Thread not found", "NOT_FOUND");
  }

  if (!mediaAssetId) {
    const outbound = await messaging.sendSingleMessage(workspaceId, {
      deviceId: thread.deviceId,
      toPhone: thread.peerPhone,
      kind: "text",
      bodyText: text,
    });

    const created = await prisma.liveChatMessage.create({
      data: {
        threadId: thread.id,
        direction: LiveChatMessageDirection.OUTBOUND,
        bodyText: text,
        outboundMessageId: outbound.id,
      },
    });

    await prisma.liveChatThread.update({
      where: { id: thread.id },
      data: {
        lastPreview: text.slice(0, 200),
        lastMessageAt: new Date(),
      },
    });

    clearActiveAiSessionsForPhone(workspaceId, thread.deviceId, thread.peerPhone);

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

  const device = await prisma.device.findFirst({
    where: { id: thread.deviceId, workspaceId },
  });
  if (!device) {
    throw new AppError(404, "Device not found", "NOT_FOUND");
  }
  if (device.status !== DeviceStatus.CONNECTED) {
    throw new AppError(400, "Device is not connected", "DEVICE_NOT_CONNECTED");
  }
  const sock = await waSession.waitForOpenWaSocket(device.id, workspaceId);
  if (!sock) {
    throw new AppError(503, "WhatsApp session is offline", "WA_SESSION_OFFLINE");
  }

  const media = await getAssetFilePath(workspaceId, mediaAssetId);
  if (!media) {
    throw new AppError(404, "Uploaded media not found", "NOT_FOUND");
  }
  const fs = await import("fs/promises");
  const data = await fs.readFile(media.absolutePath);
  const mime = media.mimeType.toLowerCase();
  const waPayload =
    mime.startsWith("image/")
      ? { image: data, caption: text || undefined, mimetype: media.mimeType }
      : mime.startsWith("video/")
        ? { video: data, caption: text || undefined, mimetype: media.mimeType }
        : mime.startsWith("audio/")
          ? {
              audio: data,
              // Send as true WhatsApp voice note (PTT).
              ptt: true,
              mimetype:
                mime.includes("ogg") || mime.includes("opus")
                  ? "audio/ogg; codecs=opus"
                  : media.mimeType,
            }
          : {
              document: data,
              fileName: media.originalName,
              mimetype: media.mimeType,
              caption: text || undefined,
            };
  const jid = e164ToWhatsAppJid(thread.peerPhone);
  const row = await prisma.outboundMessage.create({
    data: {
      workspaceId,
      deviceId: device.id,
      toPhone: thread.peerPhone,
      kind: OutboundKind.TEXT,
      bodyText: text || media.originalName,
      status: OutboundStatus.QUEUED,
    },
  });
  try {
    const sent = await withDeviceOutboundGate(
      device.id,
      { minGapMs: WA_DEVICE_INTERACTIVE_MIN_GAP_MS },
      () => sock.sendMessage(jid, waPayload as never)
    );
    const providerRef = sent?.key?.id
      ? `${sent.key.remoteJid ?? jid}:${sent.key.id}`
      : "baileys";
    await prisma.outboundMessage.update({
      where: { id: row.id },
      data: {
        status: OutboundStatus.SENT,
        providerRef,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "WhatsApp send failed";
    await prisma.outboundMessage.update({
      where: { id: row.id },
      data: {
        status: OutboundStatus.FAILED,
        errorMessage: msg.slice(0, 500),
      },
    });
    throw new AppError(502, `WhatsApp could not send media: ${msg}`, "WHATSAPP_SEND_FAILED");
  }

  const kind =
    mime.startsWith("image/")
      ? "image"
      : mime.startsWith("video/")
        ? "video"
        : mime.startsWith("audio/")
          ? "audio"
          : "document";
  const storedText = encodeLiveChatBodyText(text, {
    kind,
    assetId: mediaAssetId,
    mimeType: media.mimeType,
    fileName: media.originalName,
  });
  const created = await prisma.liveChatMessage.create({
    data: {
      threadId: thread.id,
      direction: LiveChatMessageDirection.OUTBOUND,
      bodyText: storedText,
      outboundMessageId: row.id,
    },
  });
  await prisma.liveChatThread.update({
    where: { id: thread.id },
    data: {
      lastPreview: text || `[${kind}] ${media.originalName}`,
      lastMessageAt: new Date(),
    },
  });
  clearActiveAiSessionsForPhone(workspaceId, thread.deviceId, thread.peerPhone);
  return {
    message: {
      id: created.id,
      direction: "outbound",
      bodyText: text,
      kind,
      assetId: mediaAssetId,
      mediaUrl: (() => {
        const tok = createLiveChatMediaToken({ workspaceId, assetId: mediaAssetId });
        return `/v1/live-chat/media/${mediaAssetId}?wid=${encodeURIComponent(
          workspaceId
        )}&exp=${tok.exp}&sig=${tok.sig}`;
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

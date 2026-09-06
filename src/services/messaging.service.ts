import { DeviceStatus, OutboundKind, OutboundStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { validateAndFormatPhone } from "../lib/phone";
import { e164ToWhatsAppJid } from "../lib/whatsapp-jid";
import { env } from "../env";
import {
  WA_DEVICE_INTERACTIVE_MIN_GAP_MS,
  withDeviceOutboundGate,
} from "../lib/wa-device-outbound-gate";
import { requireActiveTemplate } from "./templates.service";
import { buildTemplateWhatsAppContent } from "./wa-outbound-content";
import * as waSession from "./wa-device-session.service";

export type SingleSendPayload =
  | {
      deviceId: string;
      toPhone: string;
      kind: "text";
      bodyText: string;
    }
  | {
      deviceId: string;
      toPhone: string;
      kind: "template";
      templateId: string;
    }
  | {
      deviceId: string;
      toPhone: string;
      kind: "media";
      bodyText?: string;
      fileBuffer?: Buffer;
      fileBase64?: string;
      fileUrl?: string;
      fileName?: string;
      mimeType?: string;
    };

export type OutboundJson = {
  id: string;
  status: "queued" | "sent" | "failed" | "simulated";
  kind: "text" | "template" | "media";
  toPhone: string;
  deviceId: string;
  templateId: string | null;
  bodyText: string | null;
  fileName?: string | null;
  createdAt: string;
  note?: string;
};

function inferMimeType(fileName?: string, defaultMime = "application/octet-stream"): string {
  if (!fileName) return defaultMime;
  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "mp4":
      return "video/mp4";
    case "mp3":
      return "audio/mpeg";
    case "ogg":
    case "opus":
      return "audio/ogg";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "csv":
      return "text/csv";
    case "txt":
      return "text/plain";
    case "zip":
      return "application/zip";
    default:
      return defaultMime;
  }
}

function statusToApi(s: OutboundStatus): OutboundJson["status"] {
  switch (s) {
    case OutboundStatus.QUEUED:
      return "queued";
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

export async function sendSingleMessage(
  workspaceId: string,
  payload: SingleSendPayload
): Promise<OutboundJson> {
  const phone = validateAndFormatPhone(payload.toPhone);
  if (!phone.valid) {
    throw new AppError(400, phone.message, "INVALID_PHONE");
  }

  const device = await prisma.device.findFirst({
    where: { id: payload.deviceId, workspaceId },
  });
  if (!device) {
    throw new AppError(404, "Device not found", "NOT_FOUND");
  }
  if (device.status !== DeviceStatus.CONNECTED) {
    throw new AppError(
      400,
      "Device must be connected before sending. Complete QR pairing under Devices first.",
      "DEVICE_NOT_CONNECTED"
    );
  }

  let templateId: string | null = null;
  let bodyText: string | null = null;
  let resolvedFileName: string | null = null;
  let kind: OutboundKind;
  /** Resolved Baileys payload for template sends (after validation). */
  let templateWaContent: Awaited<
    ReturnType<typeof buildTemplateWhatsAppContent>
  > | null = null;
  let mediaWaContent: import("@whiskeysockets/baileys").AnyMessageContent | null = null;
  let textToSend: string;

  if (payload.kind === "text") {
    const text = payload.bodyText.trim();
    if (!text) {
      throw new AppError(400, "Message text is required", "VALIDATION");
    }
    if (text.length > 4096) {
      throw new AppError(
        400,
        "Message is too long (max 4096 characters)",
        "VALIDATION"
      );
    }
    bodyText = text;
    textToSend = text;
    kind = OutboundKind.TEXT;
  } else if (payload.kind === "template") {
    const tpl = await requireActiveTemplate(workspaceId, payload.templateId);
    try {
      templateWaContent = await buildTemplateWhatsAppContent(workspaceId, tpl);
    } catch (e) {
      if (e instanceof AppError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new AppError(
        400,
        `Template cannot be sent: ${msg}`,
        "VALIDATION"
      );
    }
    const summary =
      tpl.body?.trim() || tpl.name.trim() || "(template message)";
    if (summary.length > 4096) {
      throw new AppError(400, "Template content is too long", "VALIDATION");
    }
    textToSend = summary;
    templateId = tpl.id;
    bodyText = null;
    kind = OutboundKind.TEMPLATE;
  } else if (payload.kind === "media") {
    let buffer: Buffer;
    let resolvedMime = (payload.mimeType || "").trim();
    let resolvedName = (payload.fileName || "").trim();

    if (payload.fileBuffer && Buffer.isBuffer(payload.fileBuffer)) {
      buffer = payload.fileBuffer;
    } else if (payload.fileBase64) {
      let b64 = payload.fileBase64.trim();
      const match = b64.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        if (!resolvedMime) resolvedMime = match[1];
        b64 = match[2];
      }
      buffer = Buffer.from(b64, "base64");
    } else if (payload.fileUrl) {
      const url = payload.fileUrl.trim();
      try {
        const fetchRes = await fetch(url, {
          signal: AbortSignal.timeout(25000),
          headers: { "User-Agent": "LeadWhatsApp-API/1.0" },
        });
        if (!fetchRes.ok) {
          throw new Error(`HTTP ${fetchRes.status} ${fetchRes.statusText}`);
        }
        const ab = await fetchRes.arrayBuffer();
        buffer = Buffer.from(ab);
        if (!resolvedMime) {
          resolvedMime = fetchRes.headers.get("content-type")?.split(";")[0]?.trim() || "";
        }
        if (!resolvedName) {
          try {
            const parsed = new URL(url);
            resolvedName = parsed.pathname.split("/").pop() || "";
          } catch {}
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new AppError(400, `Failed to download file from fileUrl: ${msg}`, "MEDIA_DOWNLOAD_FAILED");
      }
    } else {
      throw new AppError(400, "Media payload must include fileBuffer, fileBase64, or fileUrl", "VALIDATION");
    }

    if (!buffer || buffer.length === 0) {
      throw new AppError(400, "Media file is empty (0 bytes)", "VALIDATION");
    }

    if (!resolvedName) {
      resolvedName = resolvedMime.includes("pdf") ? "invoice.pdf" : "document.pdf";
    }
    if (!resolvedMime || resolvedMime === "application/octet-stream") {
      resolvedMime = inferMimeType(resolvedName, "application/pdf");
    }

    resolvedFileName = resolvedName;
    const caption = payload.bodyText?.trim() || undefined;
    if (caption && caption.length > 4096) {
      throw new AppError(400, "Caption is too long (max 4096 characters)", "VALIDATION");
    }

    if (resolvedMime.startsWith("image/")) {
      mediaWaContent = { image: buffer, ...(caption ? { caption } : {}), mimetype: resolvedMime };
    } else if (resolvedMime.startsWith("video/")) {
      mediaWaContent = { video: buffer, ...(caption ? { caption } : {}), mimetype: resolvedMime };
    } else if (resolvedMime.startsWith("audio/")) {
      mediaWaContent = { audio: buffer, mimetype: resolvedMime, ptt: false };
    } else {
      mediaWaContent = {
        document: buffer,
        mimetype: resolvedMime || "application/pdf",
        fileName: resolvedName || "document.pdf",
        ...(caption ? { caption } : {}),
      };
    }

    bodyText = caption || `[File: ${resolvedName}]`;
    textToSend = bodyText;
    kind = OutboundKind.TEXT;
  } else {
    throw new AppError(400, "Invalid message kind", "VALIDATION");
  }

  const row = await prisma.outboundMessage.create({
    data: {
      workspaceId,
      deviceId: device.id,
      toPhone: phone.e164,
      kind,
      bodyText: kind === OutboundKind.TEXT ? bodyText : null,
      templateId,
      status: OutboundStatus.QUEUED,
    },
  });

  if (!env.WHATSAPP_BRIDGE_ENABLED) {
    console.warn(
      "[messaging] WHATSAPP_BRIDGE_ENABLED is false — single message stored as SIMULATED (no WhatsApp send)."
    );
    const final = await prisma.outboundMessage.update({
      where: { id: row.id },
      data: {
        status: OutboundStatus.SIMULATED,
        providerRef: "demo:no_provider",
      },
    });
    return {
      id: final.id,
      status: statusToApi(final.status),
      kind: payload.kind,
      toPhone: final.toPhone,
      deviceId: final.deviceId,
      templateId: final.templateId,
      bodyText: final.bodyText,
      fileName: resolvedFileName,
      createdAt: final.createdAt.toISOString(),
      note:
        "Bridge is off: set WHATSAPP_BRIDGE_ENABLED=true in the repo root .env, restart the API, then send again. Check the API log on startup for: bridge ENABLED.",
    };
  }

  const sock = await waSession.waitForOpenWaSocket(device.id, workspaceId);
  if (!sock) {
    await prisma.outboundMessage.update({
      where: { id: row.id },
      data: {
        status: OutboundStatus.FAILED,
        errorMessage:
          "WhatsApp session is not online. Open Devices, reconnect if needed, then try again.",
      },
    });
    throw new AppError(
      503,
      "WhatsApp session is offline or still connecting. Open Devices to restore the session, wait a few seconds, and try again.",
      "WA_SESSION_OFFLINE"
    );
  }

  let jid: string;
  try {
    jid = e164ToWhatsAppJid(phone.e164);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid phone for WhatsApp";
    await prisma.outboundMessage.update({
      where: { id: row.id },
      data: { status: OutboundStatus.FAILED, errorMessage: msg },
    });
    throw new AppError(400, msg, "INVALID_PHONE");
  }

  try {
    const outgoing =
      payload.kind === "text"
        ? { text: textToSend }
        : payload.kind === "template"
          ? templateWaContent!
          : mediaWaContent!;
    const waMsg = await withDeviceOutboundGate(
      device.id,
      { minGapMs: WA_DEVICE_INTERACTIVE_MIN_GAP_MS },
      () => sock.sendMessage(jid, outgoing as never)
    );
    const key = waMsg?.key;
    const providerRef = key?.id
      ? `${key.remoteJid ?? jid}:${key.id}`
      : "baileys";

    const final = await prisma.outboundMessage.update({
      where: { id: row.id },
      data: {
        status: OutboundStatus.SENT,
        providerRef,
        ...(kind === OutboundKind.TEMPLATE
          ? { bodyText: textToSend }
          : {}),
      },
    });

    return {
      id: final.id,
      status: statusToApi(final.status),
      kind: payload.kind,
      toPhone: final.toPhone,
      deviceId: final.deviceId,
      templateId: final.templateId,
      bodyText: final.bodyText,
      fileName: resolvedFileName,
      createdAt: final.createdAt.toISOString(),
      note: `Sent from device “${device.name}” via your linked WhatsApp.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const clipped = msg.slice(0, 500);
    await prisma.outboundMessage.update({
      where: { id: row.id },
      data: {
        status: OutboundStatus.FAILED,
        errorMessage: clipped,
      },
    });
    throw new AppError(
      502,
      `WhatsApp could not send this message: ${clipped}`,
      "WHATSAPP_SEND_FAILED"
    );
  }
}

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
    };

export type OutboundJson = {
  id: string;
  status: "queued" | "sent" | "failed" | "simulated";
  kind: "text" | "template";
  toPhone: string;
  deviceId: string;
  templateId: string | null;
  bodyText: string | null;
  createdAt: string;
  note?: string;
};

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
  let kind: OutboundKind;
  /** Resolved Baileys payload for template sends (after validation). */
  let templateWaContent: Awaited<
    ReturnType<typeof buildTemplateWhatsAppContent>
  > | null = null;
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
  } else {
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
      kind: final.kind === OutboundKind.TEXT ? "text" : "template",
      toPhone: final.toPhone,
      deviceId: final.deviceId,
      templateId: final.templateId,
      bodyText: final.bodyText,
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
      kind === OutboundKind.TEXT
        ? { text: textToSend }
        : templateWaContent!;
    const waMsg = await withDeviceOutboundGate(
      device.id,
      { minGapMs: WA_DEVICE_INTERACTIVE_MIN_GAP_MS },
      () => sock.sendMessage(jid, outgoing)
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
      kind: final.kind === OutboundKind.TEXT ? "text" : "template",
      toPhone: final.toPhone,
      deviceId: final.deviceId,
      templateId: final.templateId,
      bodyText: final.bodyText,
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

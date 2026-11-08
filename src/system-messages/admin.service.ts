import { DeviceStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { validateAndFormatPhone } from "../lib/phone";
import { isMailConfigured, sendMail, textToHtml } from "./mailer";
import { getSystemSettings, updateSystemSettings } from "./settings.service";
import { sendSystemWhatsApp } from "./whatsapp-sender";

/** Devices that may send system messages: those in workspaces of platform admins. */
async function listSenderCandidates() {
  const devices = await prisma.device.findMany({
    where: { workspace: { memberships: { some: { user: { role: "ADMIN" } } } } },
    select: { id: true, name: true, phone: true, status: true, workspace: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    phone: d.phone,
    connected: d.status === DeviceStatus.CONNECTED,
    workspace: d.workspace.name,
  }));
}

export async function getSystemMessagingConfig() {
  const [settings, devices] = await Promise.all([getSystemSettings(), listSenderCandidates()]);
  return {
    settings: {
      senderDeviceId: settings.senderDeviceId,
      emailEnabled: settings.emailEnabled,
      whatsappEnabled: settings.whatsappEnabled,
      requirePhoneVerification: settings.requirePhoneVerification,
      idleFreeDeviceDays: settings.idleFreeDeviceDays,
    },
    smtpConfigured: isMailConfigured(),
    senderDevices: devices,
  };
}

export async function updateSystemMessagingSettings(input: {
  senderDeviceId: string | null;
  emailEnabled: boolean;
  whatsappEnabled: boolean;
  requirePhoneVerification: boolean;
  idleFreeDeviceDays: number;
}) {
  if (input.senderDeviceId) {
    const candidates = await listSenderCandidates();
    if (!candidates.some((d) => d.id === input.senderDeviceId)) {
      throw new AppError(400, "The sender must be a device in an admin workspace.", "INVALID_SENDER");
    }
  }
  await updateSystemSettings(input);
  return getSystemMessagingConfig();
}

export async function sendTestMessage(input: { channel: "email" | "whatsapp"; to: string }) {
  const text = "This is a test message from Waleado system notifications. If you received it, the channel works.";
  if (input.channel === "email") {
    const res = await sendMail({ to: input.to, subject: "Waleado test email", text, html: textToHtml(text) });
    if (!res.delivered) throw new AppError(502, `Email failed: ${res.error ?? "unknown error"}`, "SEND_FAILED");
    return { sent: true };
  }
  const phone = validateAndFormatPhone(input.to);
  if (!phone.valid) throw new AppError(400, phone.message, "INVALID_PHONE");
  const result = await sendSystemWhatsApp(phone.e164, text);
  if (result !== "sent") {
    throw new AppError(
      502,
      result === "skipped"
        ? "WhatsApp sending is off or no sender device is selected."
        : "The sender device could not send. Check that it is connected.",
      "SEND_FAILED"
    );
  }
  return { sent: true };
}

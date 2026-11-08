import { DeviceStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../env";
import { e164ToWhatsAppJid } from "../lib/whatsapp-jid";
import {
  WA_DEVICE_INTERACTIVE_MIN_GAP_MS,
  withDeviceOutboundGate,
} from "../lib/wa-device-outbound-gate";
import { waitForOpenWaSocket } from "../services/wa-device-session.service";
import { getSystemSettings } from "./settings.service";

const SOCKET_WAIT_MS = 15_000;

async function getSenderDevice() {
  const { senderDeviceId, whatsappEnabled } = await getSystemSettings();
  if (!whatsappEnabled || !senderDeviceId || !env.WHATSAPP_BRIDGE_ENABLED) return null;
  return prisma.device.findUnique({
    where: { id: senderDeviceId },
    select: { id: true, workspaceId: true, status: true, phone: true },
  });
}

/** True when system WhatsApp messages (OTP, reminders) can be sent right now. */
export async function isSystemWhatsAppReady(): Promise<boolean> {
  const device = await getSenderDevice();
  return device?.status === DeviceStatus.CONNECTED;
}

export type ChannelResult = "sent" | "skipped" | "failed";

/** Sends a plain text WhatsApp message from the admin-chosen sender device. */
export async function sendSystemWhatsApp(toE164: string, text: string): Promise<ChannelResult> {
  const device = await getSenderDevice();
  if (!device) return "skipped";
  try {
    const sock = await waitForOpenWaSocket(device.id, device.workspaceId, SOCKET_WAIT_MS);
    if (!sock) {
      console.warn("[system-whatsapp] sender device is not connected");
      return "failed";
    }
    const jid = e164ToWhatsAppJid(toE164);
    await withDeviceOutboundGate(device.id, { minGapMs: WA_DEVICE_INTERACTIVE_MIN_GAP_MS }, () =>
      sock.sendMessage(jid, { text })
    );
    return "sent";
  } catch (err) {
    console.error(`[system-whatsapp] send to ${toE164} failed:`, err);
    return "failed";
  }
}

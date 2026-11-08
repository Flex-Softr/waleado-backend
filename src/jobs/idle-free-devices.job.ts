import { DeviceStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getEntitlements } from "../billing/entitlements.service";
import { DAY_MS } from "../billing/period";
import { getSystemSettings } from "../system-messages/settings.service";
import { dispatchSystemMessage } from "../system-messages/dispatcher.service";
import { stopWaDeviceSession } from "../services/wa-device-session.service";

/** Warn this many days before an idle device is disconnected. */
const WARNING_DAYS = 3;

/** Latest of: device connected/created, last outbound message, last live chat activity. */
async function lastActivityByDevice(deviceIds: string[]): Promise<Map<string, Date>> {
  const [outbound, threads] = await Promise.all([
    prisma.outboundMessage.groupBy({
      by: ["deviceId"],
      where: { deviceId: { in: deviceIds } },
      _max: { createdAt: true },
    }),
    prisma.liveChatThread.groupBy({
      by: ["deviceId"],
      where: { deviceId: { in: deviceIds } },
      _max: { lastMessageAt: true },
    }),
  ]);
  const latest = new Map<string, Date>();
  const bump = (id: string, d: Date | null | undefined) => {
    if (d && (!latest.has(id) || d > (latest.get(id) as Date))) latest.set(id, d);
  };
  for (const r of outbound) bump(r.deviceId, r._max.createdAt);
  for (const r of threads) bump(r.deviceId, r._max.lastMessageAt);
  return latest;
}

/**
 * Frees server resources held by connected devices that Free-plan workspaces no longer use:
 * a warning first, then the WhatsApp session is closed (re-linking only needs a new QR scan).
 */
export async function runIdleFreeDeviceCleanup(now = new Date()): Promise<void> {
  const { idleFreeDeviceDays } = await getSystemSettings();
  if (idleFreeDeviceDays <= 0) return;

  const devices = await prisma.device.findMany({
    where: { status: DeviceStatus.CONNECTED },
    select: { id: true, name: true, workspaceId: true, updatedAt: true },
  });
  const activity = await lastActivityByDevice(devices.map((d) => d.id));

  for (const device of devices) {
    const ent = await getEntitlements(device.workspaceId);
    if (ent.tier !== "FREE" || ent.isPlatformAdmin) continue;

    const last = activity.get(device.id) ?? device.updatedAt;
    const idleDays = Math.floor((now.getTime() - Math.max(last.getTime(), device.updatedAt.getTime())) / DAY_MS);
    const lastKey = last.toISOString();

    if (idleDays >= idleFreeDeviceDays) {
      await stopWaDeviceSession(device.id, device.workspaceId);
      await prisma.device.update({
        where: { id: device.id },
        data: { status: DeviceStatus.QR_READY, phone: null, profilePictureUrl: null, isDefault: false },
      });
      await dispatchSystemMessage({
        key: "device_idle_disconnected",
        workspaceId: device.workspaceId,
        dedupeKey: `idle_disconnected:${device.id}:${lastKey}`,
        vars: { device: device.name },
      });
    } else if (idleDays >= idleFreeDeviceDays - WARNING_DAYS) {
      await dispatchSystemMessage({
        key: "device_idle_warning",
        workspaceId: device.workspaceId,
        dedupeKey: `idle_warning:${device.id}:${lastKey}`,
        vars: { device: device.name, days: idleFreeDeviceDays - idleDays },
      });
    }
  }
}

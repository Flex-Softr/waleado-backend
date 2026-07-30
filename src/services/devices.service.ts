import { randomBytes } from "crypto";
import { DeviceStatus, Plan } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { env } from "../env";
import * as waSession from "./wa-device-session.service";

export type DeviceJson = {
  id: string;
  workspaceId: string;
  name: string;
  sessionId: string;
  status: "qr_ready" | "connected";
  phone: string | null;
  profilePictureUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeviceLinkStateJson = {
  bridgeEnabled: boolean;
  qr: string | null;
  connection: "connecting" | "open" | "close" | null;
  status: "qr_ready" | "connected";
  startError: string | null;
};

const DEMO_PHONE = "+917261902348";

function maxDevicesForPlan(plan: Plan): number {
  switch (plan) {
    case Plan.FREE:
      return 1;
    case Plan.PRO:
      return 5;
    case Plan.BUSINESS:
      return 100;
    default:
      return 1;
  }
}

function newSessionId(): string {
  return `sess_${randomBytes(18).toString("base64url")}`;
}

function statusToApi(s: DeviceStatus): "qr_ready" | "connected" {
  return s === DeviceStatus.QR_READY ? "qr_ready" : "connected";
}

export function deviceToJson(d: {
  id: string;
  workspaceId: string;
  name: string;
  sessionId: string;
  status: DeviceStatus;
  phone: string | null;
  profilePictureUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}): DeviceJson {
  return {
    id: d.id,
    workspaceId: d.workspaceId,
    name: d.name,
    sessionId: d.sessionId,
    status: statusToApi(d.status),
    phone: d.phone,
    profilePictureUrl: d.profilePictureUrl,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export async function listDevices(workspaceId: string): Promise<DeviceJson[]> {
  const rows = await prisma.device.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });

  if (!env.WHATSAPP_BRIDGE_ENABLED) {
    return rows.map(deviceToJson);
  }

  const mapped = await Promise.all(
    rows.map(async (row) => {
      let json = deviceToJson(row);

      if (row.status === DeviceStatus.CONNECTED && !row.phone) {
        const phone = await waSession.fetchAndPersistOwnPhone(
          row.id,
          row.workspaceId
        );
        if (phone) {
          json = { ...json, phone };
        }
      }

      if (
        row.status !== DeviceStatus.CONNECTED ||
        row.profilePictureUrl != null
      ) {
        return json;
      }
      const fresh = await waSession.fetchAndPersistProfilePicture(row.id);
      if (fresh) {
        return { ...json, profilePictureUrl: fresh };
      }
      return json;
    })
  );

  return mapped;
}

export async function createDevice(
  workspaceId: string,
  name: string
): Promise<DeviceJson> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new AppError(400, "Device name is required", "VALIDATION");
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { plan: true },
  });
  if (!workspace) {
    throw new AppError(404, "Workspace not found", "NOT_FOUND");
  }

  const count = await prisma.device.count({ where: { workspaceId } });
  const max = maxDevicesForPlan(workspace.plan);
  if (count >= max) {
    throw new AppError(
      403,
      `Your plan allows up to ${max} device(s). Upgrade billing to add more.`,
      "PLAN_DEVICE_LIMIT"
    );
  }

  const device = await prisma.device.create({
    data: {
      workspaceId,
      name: trimmed.slice(0, 120),
      sessionId: newSessionId(),
      status: DeviceStatus.QR_READY,
    },
  });

  return deviceToJson(device);
}

export async function getDeviceOrThrow(deviceId: string, workspaceId: string) {
  const d = await prisma.device.findFirst({
    where: { id: deviceId, workspaceId },
  });
  if (!d) {
    throw new AppError(404, "Device not found", "NOT_FOUND");
  }
  return d;
}

const WA_PROFILE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function downloadProfilePhotoFromCdn(
  url: string
): Promise<{ body: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent": WA_PROFILE_UA,
      },
    });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    const rawType = res.headers.get("content-type");
    const contentType = rawType?.split(";")[0]?.trim() || "image/jpeg";
    return { body: Buffer.from(ab), contentType };
  } catch (err) {
    console.warn("[devices] profile photo CDN download failed", err);
    return null;
  }
}

/**
 * Fetches bytes for the linked WhatsApp account photo (server-side CDN fetch).
 * Browsers often cannot load signed pps.whatsapp.net URLs directly.
 */
export async function getDeviceProfilePhotoBytes(
  deviceId: string,
  workspaceId: string
): Promise<{ body: Buffer; contentType: string }> {
  const d = await getDeviceOrThrow(deviceId, workspaceId);
  if (d.status !== DeviceStatus.CONNECTED) {
    throw new AppError(400, "Device not connected", "DEVICE_NOT_CONNECTED");
  }
  if (!env.WHATSAPP_BRIDGE_ENABLED) {
    throw new AppError(
      503,
      "WhatsApp bridge is not enabled",
      "BRIDGE_DISABLED"
    );
  }

  await waSession.ensureWaDeviceSession(deviceId, workspaceId);

  let url = await waSession.getOpenSocketProfilePictureUrl(deviceId);
  if (!url && d.profilePictureUrl) {
    url = d.profilePictureUrl;
  }
  if (!url) {
    throw new AppError(
      404,
      "No profile photo from WhatsApp (check privacy: who can see your photo).",
      "PROFILE_PHOTO_UNAVAILABLE"
    );
  }

  let downloaded = await downloadProfilePhotoFromCdn(url);
  if (!downloaded) {
    const fresh = await waSession.getOpenSocketProfilePictureUrl(deviceId);
    if (fresh && fresh !== url) {
      downloaded = await downloadProfilePhotoFromCdn(fresh);
      if (downloaded) {
        void prisma.device
          .update({
            where: { id: deviceId },
            data: { profilePictureUrl: fresh },
          })
          .catch(() => {});
      }
    }
  }

  if (!downloaded) {
    throw new AppError(
      502,
      "Could not download profile photo from WhatsApp.",
      "PROFILE_PHOTO_DOWNLOAD_FAILED"
    );
  }

  return downloaded;
}

export async function getDeviceLinkState(
  deviceId: string,
  workspaceId: string
): Promise<DeviceLinkStateJson> {
  const d = await getDeviceOrThrow(deviceId, workspaceId);

  if (d.status === DeviceStatus.CONNECTED) {
    if (!env.WHATSAPP_BRIDGE_ENABLED) {
      return {
        bridgeEnabled: false,
        qr: null,
        connection: null,
        status: "connected",
        startError: null,
      };
    }
    await waSession.ensureWaDeviceSession(deviceId, workspaceId);
    return {
      bridgeEnabled: true,
      qr: waSession.getWaQr(deviceId),
      connection: waSession.getWaConnection(deviceId),
      status: "connected",
      startError: waSession.getWaStartError(deviceId),
    };
  }

  if (!env.WHATSAPP_BRIDGE_ENABLED) {
    return {
      bridgeEnabled: false,
      qr: null,
      connection: null,
      status: "qr_ready",
      startError: null,
    };
  }

  await waSession.ensureWaDeviceSession(deviceId, workspaceId);

  const refreshed = await prisma.device.findFirst({
    where: { id: deviceId, workspaceId },
  });
  if (!refreshed) {
    throw new AppError(404, "Device not found", "NOT_FOUND");
  }

  return {
    bridgeEnabled: true,
    qr: waSession.getWaQr(deviceId),
    connection: waSession.getWaConnection(deviceId),
    status: statusToApi(refreshed.status),
    startError: waSession.getWaStartError(deviceId),
  };
}

export async function disconnectDevice(
  deviceId: string,
  workspaceId: string
): Promise<DeviceJson> {
  await getDeviceOrThrow(deviceId, workspaceId);
  await waSession.stopWaDeviceSession(deviceId, workspaceId);
  const updated = await prisma.device.update({
    where: { id: deviceId },
    data: {
      status: DeviceStatus.QR_READY,
      phone: null,
      profilePictureUrl: null,
    },
  });
  return deviceToJson(updated);
}

/** Simulates a successful QR scan until a real WhatsApp bridge is wired. */
export async function simulateDeviceConnected(
  deviceId: string,
  workspaceId: string
): Promise<DeviceJson> {
  await getDeviceOrThrow(deviceId, workspaceId);
  await waSession.stopWaDeviceSession(deviceId, workspaceId);
  const updated = await prisma.device.update({
    where: { id: deviceId },
    data: {
      status: DeviceStatus.CONNECTED,
      phone: DEMO_PHONE,
      profilePictureUrl: null,
    },
  });
  return deviceToJson(updated);
}

export async function deleteDevice(
  deviceId: string,
  workspaceId: string
): Promise<void> {
  const d = await getDeviceOrThrow(deviceId, workspaceId);
  await waSession.stopWaDeviceSession(d.id, d.workspaceId);
  await prisma.device.delete({ where: { id: d.id } });
}

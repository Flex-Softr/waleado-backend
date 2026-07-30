import { OutboundStatus } from "@prisma/client";
import { prisma } from "./prisma";

/** Conservative per-device daily send ceiling to reduce ban risk. */
export const WA_DEVICE_DAILY_SEND_CAP = 350;

/** Minimum gap between any two outbound sends on the same device (bulk). */
export const WA_DEVICE_BULK_MIN_GAP_MS = 15_000;

/** Light gap for interactive sends (live chat / single message) sharing a device with bulk. */
export const WA_DEVICE_INTERACTIVE_MIN_GAP_MS = 800;

export class DeviceDailyCapExceededError extends Error {
  readonly deviceId: string;
  readonly cap: number;
  readonly sentToday: number;

  constructor(deviceId: string, cap: number, sentToday: number) {
    super(
      `Device daily send limit reached (${sentToday}/${cap}). Pause campaigns and resume tomorrow to protect the WhatsApp account.`
    );
    this.name = "DeviceDailyCapExceededError";
    this.deviceId = deviceId;
    this.cap = cap;
    this.sentToday = sentToday;
  }
}

type DeviceGateState = {
  tail: Promise<unknown>;
  lastSendAt: number;
};

const gates = new Map<string, DeviceGateState>();

function getGate(deviceId: string): DeviceGateState {
  let g = gates.get(deviceId);
  if (!g) {
    g = { tail: Promise.resolve(), lastSendAt: 0 };
    gates.set(deviceId, g);
  }
  return g;
}

function startOfUtcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export async function countDeviceSentToday(deviceId: string): Promise<number> {
  return prisma.outboundMessage.count({
    where: {
      deviceId,
      status: OutboundStatus.SENT,
      createdAt: { gte: startOfUtcDay() },
    },
  });
}

export type DeviceOutboundGateOptions = {
  /** Wait at least this many ms since the previous send on this device. */
  minGapMs?: number;
  /** When true, refuse the send if the device already hit the daily SENT cap. */
  enforceDailyCap?: boolean;
  dailyCap?: number;
};

/**
 * Serializes WhatsApp sends per device and optionally enforces min gap + daily cap.
 * Use for every Baileys `sendMessage` on a linked device to avoid burst traffic.
 */
export async function withDeviceOutboundGate<T>(
  deviceId: string,
  opts: DeviceOutboundGateOptions,
  fn: () => Promise<T>
): Promise<T> {
  const gate = getGate(deviceId);
  const minGapMs = Math.max(0, opts.minGapMs ?? 0);
  const enforceDailyCap = opts.enforceDailyCap === true;
  const dailyCap = Math.max(1, opts.dailyCap ?? WA_DEVICE_DAILY_SEND_CAP);

  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = gate.tail;
  gate.tail = prev.then(() => slot).catch(() => slot);

  await prev.catch(() => undefined);

  try {
    if (enforceDailyCap) {
      const sentToday = await countDeviceSentToday(deviceId);
      if (sentToday >= dailyCap) {
        throw new DeviceDailyCapExceededError(deviceId, dailyCap, sentToday);
      }
    }

    const waitMs = Math.max(0, gate.lastSendAt + minGapMs - Date.now());
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }

    const result = await fn();
    gate.lastSendAt = Date.now();
    return result;
  } finally {
    release();
  }
}

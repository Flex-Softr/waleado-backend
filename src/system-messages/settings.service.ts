import type { SystemSettings } from "@prisma/client";
import { prisma } from "../lib/prisma";

const DEFAULTS: SystemSettings = {
  id: "default",
  senderDeviceId: null,
  emailEnabled: true,
  whatsappEnabled: true,
  requirePhoneVerification: true,
  idleFreeDeviceDays: 30,
  updatedAt: new Date(0),
};

const TTL_MS = 30_000;
let cache: { at: number; value: SystemSettings } | null = null;

export async function getSystemSettings(): Promise<SystemSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const row = await prisma.systemSettings.findUnique({ where: { id: "default" } });
  const value = row ?? DEFAULTS;
  cache = { at: Date.now(), value };
  return value;
}

export async function updateSystemSettings(
  data: Partial<Omit<SystemSettings, "id" | "updatedAt">>
): Promise<SystemSettings> {
  const value = await prisma.systemSettings.upsert({
    where: { id: "default" },
    create: { id: "default", ...data },
    update: data,
  });
  cache = { at: Date.now(), value };
  return value;
}

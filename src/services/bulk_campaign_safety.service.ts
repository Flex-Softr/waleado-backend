import { BulkUniquenessMode, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

export type BulkAntiBlockSettings = {
  enabled: boolean;
  spintaxEnabled: boolean;
  verifyNumbers: boolean;
  repliedOnly: boolean;
  recent24hOnly: boolean;
  uniquenessMode: BulkUniquenessMode;
  batchPauseEvery: number;
  batchPauseSec: number;
  failLimitInRow: number;
  activeHoursStart: string | null;
  activeHoursEnd: string | null;
};

export function parseTimeToMinute(input: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isWithinActiveHours(
  now: Date,
  start: string | null,
  end: string | null
): boolean {
  if (!start || !end) return true;
  const s = parseTimeToMinute(start);
  const e = parseTimeToMinute(end);
  if (s === null || e === null) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (s === e) return true;
  if (s < e) return cur >= s && cur <= e;
  return cur >= s || cur <= e;
}

export function applySpintax(input: string): string {
  const maxRounds = 10;
  let out = input;
  for (let i = 0; i < maxRounds; i++) {
    const next = out.replace(/\{([^{}]+)\}/g, (_all, inner: string) => {
      const options = inner
        .split("|")
        .map((x) => x.trim())
        .filter(Boolean);
      if (options.length === 0) return "";
      const idx = Math.floor(Math.random() * options.length);
      return options[idx] ?? "";
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

export function applyUniqueness(
  phones: string[],
  mode: BulkUniquenessMode
): string[] {
  if (mode === BulkUniquenessMode.NONE) return phones;
  return [...new Set(phones)];
}

export async function applyWorkspaceUniquenessWindow(
  workspaceId: string,
  phones: string[],
  windowHours = 24
): Promise<string[]> {
  if (phones.length === 0) return [];
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const sentRows = await prisma.outboundMessage.findMany({
    where: {
      workspaceId,
      toPhone: { in: phones },
      createdAt: { gte: since },
    },
    select: { toPhone: true },
  });
  const sentSet = new Set(sentRows.map((r) => r.toPhone));
  return phones.filter((p) => !sentSet.has(p));
}

export async function fetchInboundLastMap(
  workspaceId: string,
  phones: string[]
): Promise<Map<string, Date>> {
  if (phones.length === 0) return new Map();
  const rows = await prisma.liveChatThread.findMany({
    where: { workspaceId, peerPhone: { in: phones } },
    select: { peerPhone: true, lastMessageAt: true },
  });
  const byPhone = new Map<string, Date>();
  for (const row of rows) {
    if (!row.lastMessageAt) continue;
    const prev = byPhone.get(row.peerPhone);
    if (!prev || row.lastMessageAt > prev) byPhone.set(row.peerPhone, row.lastMessageAt);
  }
  return byPhone;
}

export async function filterByReplyRules(
  workspaceId: string,
  phones: string[],
  opts: { repliedOnly: boolean; recent24hOnly: boolean }
): Promise<string[]> {
  if (!opts.repliedOnly && !opts.recent24hOnly) return phones;
  const lastMap = await fetchInboundLastMap(workspaceId, phones);
  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  return phones.filter((p) => {
    const d = lastMap.get(p);
    if (!d) return false;
    if (opts.recent24hOnly && d.getTime() < since24h) return false;
    return true;
  });
}

export async function filterVerifiedFromContacts(
  workspaceId: string,
  phones: string[]
): Promise<string[]> {
  if (phones.length === 0) return [];
  const rows = await prisma.contact.findMany({
    where: {
      phone: { in: phones },
      status: "VERIFIED",
      group: { workspaceId },
    },
    select: { phone: true },
  });
  const ok = new Set(rows.map((r) => r.phone));
  return phones.filter((p) => ok.has(p));
}

export async function sleepMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export function randomDelayMs(minSec: number, maxSec: number): number {
  const lo = Math.min(minSec, maxSec);
  const hi = Math.max(minSec, maxSec);
  const spread = hi - lo;
  const sec = lo + (spread > 0 ? Math.floor(Math.random() * (spread + 1)) : 0);
  return sec * 1000;
}

export function shouldStopByFailLimit(
  consecutiveFailures: number,
  settings: BulkAntiBlockSettings
): boolean {
  return settings.enabled && consecutiveFailures >= settings.failLimitInRow;
}

export function normalizeAntiBlock(
  antiBlock?: {
    enabled?: boolean;
    spintax?: boolean;
    verifyNumbers?: boolean;
    repliedOnly?: boolean;
    recent24hOnly?: boolean;
    uniquenessMode?: "none" | "campaign" | "workspace_window";
    batchPauseEvery?: number;
    batchPauseSec?: number;
    failLimitInRow?: number;
    activeHoursStart?: string | null;
    activeHoursEnd?: string | null;
  } | null
): BulkAntiBlockSettings {
  const uniquenessMode =
    antiBlock?.uniquenessMode === "campaign"
      ? BulkUniquenessMode.CAMPAIGN
      : antiBlock?.uniquenessMode === "workspace_window"
        ? BulkUniquenessMode.WORKSPACE_WINDOW
        : BulkUniquenessMode.NONE;
  return {
    enabled: antiBlock?.enabled === true,
    spintaxEnabled: antiBlock?.spintax === true,
    verifyNumbers: antiBlock?.verifyNumbers === true,
    repliedOnly: antiBlock?.repliedOnly === true,
    recent24hOnly: antiBlock?.recent24hOnly === true,
    uniquenessMode,
    batchPauseEvery: Math.max(1, Math.floor(antiBlock?.batchPauseEvery ?? 30)),
    batchPauseSec: Math.max(1, Math.floor(antiBlock?.batchPauseSec ?? 30)),
    failLimitInRow: Math.max(1, Math.floor(antiBlock?.failLimitInRow ?? 5)),
    activeHoursStart: antiBlock?.activeHoursStart?.trim() || null,
    activeHoursEnd: antiBlock?.activeHoursEnd?.trim() || null,
  };
}

export function antiBlockApiFromRow(row: {
  antiBlockEnabled: boolean;
  spintaxEnabled: boolean;
  verifyNumbers: boolean;
  repliedOnly: boolean;
  recent24hOnly: boolean;
  uniquenessMode: BulkUniquenessMode;
  batchPauseEvery: number;
  batchPauseSec: number;
  failLimitInRow: number;
  activeHoursStart: string | null;
  activeHoursEnd: string | null;
}) {
  return {
    enabled: row.antiBlockEnabled,
    spintax: row.spintaxEnabled,
    verifyNumbers: row.verifyNumbers,
    repliedOnly: row.repliedOnly,
    recent24hOnly: row.recent24hOnly,
    uniquenessMode:
      row.uniquenessMode === BulkUniquenessMode.CAMPAIGN
        ? "campaign"
        : row.uniquenessMode === BulkUniquenessMode.WORKSPACE_WINDOW
          ? "workspace_window"
          : "none",
    batchPauseEvery: row.batchPauseEvery,
    batchPauseSec: row.batchPauseSec,
    failLimitInRow: row.failLimitInRow,
    activeHoursStart: row.activeHoursStart,
    activeHoursEnd: row.activeHoursEnd,
  } as const;
}

export async function applyPhoneFilters(
  workspaceId: string,
  phones: string[],
  settings: BulkAntiBlockSettings
): Promise<string[]> {
  let out = phones;
  if (!settings.enabled) return out;
  if (settings.uniquenessMode === BulkUniquenessMode.CAMPAIGN) {
    out = applyUniqueness(out, settings.uniquenessMode);
  }
  if (settings.uniquenessMode === BulkUniquenessMode.WORKSPACE_WINDOW) {
    out = await applyWorkspaceUniquenessWindow(workspaceId, out);
  }
  if (settings.verifyNumbers) {
    out = await filterVerifiedFromContacts(workspaceId, out);
  }
  if (settings.repliedOnly || settings.recent24hOnly) {
    out = await filterByReplyRules(workspaceId, out, {
      repliedOnly: settings.repliedOnly,
      recent24hOnly: settings.recent24hOnly,
    });
  }
  return out;
}

export function toJsonValue(input: string[]): Prisma.InputJsonValue {
  return input as unknown as Prisma.InputJsonValue;
}

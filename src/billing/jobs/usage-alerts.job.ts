import { OutboundStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { getCatalog } from "../catalog.service";
import { getEntitlements, quotaDayStart, quotaMonthStart } from "../entitlements.service";
import { COUNT_LIMIT_LABELS, type CountLimitKey } from "../limits";
import { dispatchSystemMessage } from "../../system-messages/dispatcher.service";

type UsageRow = { workspaceId: string; used: number };

async function countOutboundSince(since: Date): Promise<UsageRow[]> {
  const rows = await prisma.outboundMessage.groupBy({
    by: ["workspaceId"],
    where: { createdAt: { gte: since }, status: { in: [OutboundStatus.QUEUED, OutboundStatus.SENT] } },
    _count: { _all: true },
  });
  return rows.map((r) => ({ workspaceId: r.workspaceId, used: r._count._all }));
}

async function countContacts(): Promise<UsageRow[]> {
  const groups = await prisma.contactGroup.findMany({
    select: { workspaceId: true, _count: { select: { contacts: true } } },
  });
  const byWs = new Map<string, number>();
  for (const g of groups) byWs.set(g.workspaceId, (byWs.get(g.workspaceId) ?? 0) + g._count.contacts);
  return [...byWs].map(([workspaceId, used]) => ({ workspaceId, used }));
}

/**
 * Warns workspace owners when they reach the configured share of a limit (e.g. 80% and 100%).
 * Daily and monthly message quotas alert once per day/month; contacts once per plan limit.
 */
export async function runUsageAlerts(now = new Date()): Promise<void> {
  const { settings } = await getCatalog();
  const thresholds = [...settings.usageAlertPercents].sort((a, b) => b - a);
  if (!thresholds.length) return;

  const dayKey = quotaDayStart(now).toISOString().slice(0, 10);
  const monthKey = quotaMonthStart(now).toISOString().slice(0, 7);
  const checks: Array<{ limit: CountLimitKey; rows: UsageRow[]; period: string }> = [
    { limit: "messagesPerDay", rows: await countOutboundSince(quotaDayStart(now)), period: dayKey },
    { limit: "messagesPerMonth", rows: await countOutboundSince(quotaMonthStart(now)), period: monthKey },
    { limit: "contacts", rows: await countContacts(), period: "" },
  ];

  for (const { limit, rows, period } of checks) {
    for (const { workspaceId, used } of rows) {
      const ent = await getEntitlements(workspaceId);
      const max = ent.limits[limit];
      if (ent.isPlatformAdmin || max === null || max === 0) continue;
      const percent = Math.floor((used / max) * 100);
      // Only the highest threshold reached is sent, so 100% doesn't arrive with an 80% duplicate.
      const reached = thresholds.find((t) => percent >= t);
      if (reached === undefined) continue;
      await dispatchSystemMessage({
        key: "usage_alert",
        workspaceId,
        dedupeKey: `usage:${workspaceId}:${limit}:${period || `${ent.planId}-${max}`}:${reached}`,
        vars: {
          plan: ent.planName,
          limit: COUNT_LIMIT_LABELS[limit],
          percent: Math.min(percent, 100),
          used,
          max,
        },
      });
    }
  }
}

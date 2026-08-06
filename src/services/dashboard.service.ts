import {
  DeviceStatus,
  LiveChatMessageDirection,
  OutboundKind,
  OutboundStatus,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../env";

export type DashboardSystemStatus = "online" | "offline" | "degraded";

export type DashboardKpiTrend = "positive" | "negative" | "neutral";

export type DashboardOverviewKpi = {
  id: string;
  label: string;
  value: string;
  period: string;
  changeLabel: string;
  trend: DashboardKpiTrend;
  iconKey:
    | "users"
    | "revenue"
    | "messages"
    | "delivery"
    | "sessions"
    | "response"
    | "contacts"
    | "campaigns";
};

export type DashboardBarPoint = { label: string; value: number };

export type DashboardLinePoint = {
  x: string;
  s1: number;
  s2: number;
  s3: number;
  s4: number;
};

export type DashboardSummaryRow = { label: string; value: number };

export type DashboardSummaryCard = {
  id: string;
  title: string;
  rows: DashboardSummaryRow[];
  progress: number;
  icon: "reply" | "bulk" | "bot" | "template";
};

export type DashboardOverviewJson = {
  generatedAt: string;
  systemStatus: DashboardSystemStatus;
  lastUpdatedLabel: string;
  devicesOnline: number;
  devicesTotal: number;
  messagesToday: number;
  kpis: DashboardOverviewKpi[];
  barSeries: DashboardBarPoint[];
  lineSeries: DashboardLinePoint[];
  summaries: DashboardSummaryCard[];
};

function startOfUtcDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function pctChangeLabel(current: number, previous: number): {
  label: string;
  trend: DashboardKpiTrend;
} {
  if (previous === 0 && current === 0) {
    return { label: "—", trend: "neutral" };
  }
  if (previous === 0) {
    return { label: "+100%", trend: "positive" };
  }
  const raw = ((current - previous) / previous) * 100;
  const rounded = Math.round(raw * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  const trend: DashboardKpiTrend =
    rounded > 0 ? "positive" : rounded < 0 ? "negative" : "neutral";
  return { label: `${sign}${rounded}%`, trend };
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatPct(p: number): string {
  if (!Number.isFinite(p)) return "—";
  return `${Math.round(p * 10) / 10}%`;
}

export async function getDashboardOverview(
  workspaceId: string
): Promise<DashboardOverviewJson> {
  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const d60 = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 11);
  twelveMonthsAgo.setUTCDate(1);
  twelveMonthsAgo.setUTCHours(0, 0, 0, 0);

  const lineFrom = new Date(now);
  lineFrom.setUTCDate(lineFrom.getUTCDate() - 13);
  lineFrom.setUTCHours(0, 0, 0, 0);

  const [
    devicesTotal,
    devicesOnline,
    messagesToday,
    outboundLast30,
    outboundPrev30,
    outboundStatus30,
    liveThreadsTotal,
    liveThreads30,
    threadsNewLast30,
    threadsNewPrev30,
    contactsCount,
    bulkLast30,
    bulkPrev30,
    bulkTotals,
    autoReplyAgg,
    chatbotTotals,
    chatbotActiveCount,
    templateGroups,
  ] = await Promise.all([
    prisma.device.count({ where: { workspaceId } }),
    prisma.device.count({
      where: { workspaceId, status: DeviceStatus.CONNECTED },
    }),
    prisma.outboundMessage.count({
      where: { workspaceId, createdAt: { gte: todayStart } },
    }),
    prisma.outboundMessage.count({
      where: { workspaceId, createdAt: { gte: d30 } },
    }),
    prisma.outboundMessage.count({
      where: { workspaceId, createdAt: { gte: d60, lt: d30 } },
    }),
    prisma.outboundMessage.groupBy({
      by: ["status"],
      where: { workspaceId, createdAt: { gte: d30 } },
      _count: { _all: true },
    }),
    prisma.liveChatThread.count({ where: { workspaceId } }),
    prisma.liveChatThread.count({
      where: {
        workspaceId,
        OR: [{ lastMessageAt: { gte: d30 } }, { createdAt: { gte: d30 } }],
      },
    }),
    prisma.liveChatThread.count({
      where: { workspaceId, createdAt: { gte: d30 } },
    }),
    prisma.liveChatThread.count({
      where: { workspaceId, createdAt: { gte: d60, lt: d30 } },
    }),
    prisma.contact.count({
      where: { group: { workspaceId } },
    }),
    prisma.bulkCampaign.count({
      where: { workspaceId, createdAt: { gte: d30 } },
    }),
    prisma.bulkCampaign.count({
      where: { workspaceId, createdAt: { gte: d60, lt: d30 } },
    }),
    prisma.bulkCampaign.groupBy({
      by: ["status"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.autoReplyRule.aggregate({
      where: { workspaceId },
      _count: { _all: true },
      _sum: { responseCount: true },
    }),
    prisma.chatbotFlow.aggregate({
      where: { workspaceId },
      _count: { _all: true },
      _sum: { conversationCount: true },
    }),
    prisma.chatbotFlow.count({
      where: { workspaceId, active: true },
    }),
    prisma.messageTemplate.groupBy({
      by: ["active"],
      where: { workspaceId },
      _count: { _all: true },
    }),
  ]);

  const dayStartUtc = startOfUtcDay(now);

  const [outboundForCharts, liveChatOutboundRows] = await Promise.all([
    prisma.outboundMessage.findMany({
      where: { workspaceId, createdAt: { gte: twelveMonthsAgo } },
      select: {
        id: true,
        createdAt: true,
        kind: true,
        bulkCampaignId: true,
      },
    }),
    prisma.liveChatMessage.findMany({
      where: {
        direction: LiveChatMessageDirection.OUTBOUND,
        outboundMessageId: { not: null },
        thread: { workspaceId },
        outboundMessage: {
          workspaceId,
          createdAt: { gte: lineFrom },
        },
      },
      select: {
        outboundMessageId: true,
        outboundMessage: { select: { createdAt: true } },
      },
    }),
  ]);

  const activeAutoRules = await prisma.autoReplyRule.count({
    where: { workspaceId, active: true },
  });

  const totalAutoRules = autoReplyAgg._count._all;
  const totalResponses = autoReplyAgg._sum.responseCount ?? 0;

  const totalFlows = chatbotTotals._count._all;
  const flowConversations = chatbotTotals._sum.conversationCount ?? 0;
  const activeFlows = chatbotActiveCount;

  let templatesActive = 0;
  let templatesInactive = 0;
  for (const g of templateGroups) {
    if (g.active) templatesActive = g._count._all;
    else templatesInactive = g._count._all;
  }
  const templatesTotal = templatesActive + templatesInactive;

  let bulkScheduled = 0;
  let bulkCompleted = 0;
  let bulkInProgress = 0;
  let bulkCampaignsTotal = 0;
  for (const g of bulkTotals) {
    bulkCampaignsTotal += g._count._all;
    if (g.status === "SCHEDULED") bulkScheduled = g._count._all;
    if (g.status === "COMPLETED") bulkCompleted = g._count._all;
    if (
      g.status === "PENDING" ||
      g.status === "RUNNING" ||
      g.status === "PAUSED"
    ) {
      bulkInProgress += g._count._all;
    }
  }

  let sentOk = 0;
  let sentFail = 0;
  for (const g of outboundStatus30) {
    if (g.status === OutboundStatus.SENT || g.status === OutboundStatus.SIMULATED) {
      sentOk += g._count._all;
    }
    if (g.status === OutboundStatus.FAILED) {
      sentFail += g._count._all;
    }
  }
  const settled = sentOk + sentFail;
  const deliveryRate = settled > 0 ? (sentOk / settled) * 100 : 100;

  const msgTrend = pctChangeLabel(outboundLast30, outboundPrev30);
  const bulkTrend = pctChangeLabel(bulkLast30, bulkPrev30);
  const threadsTrend = pctChangeLabel(threadsNewLast30, threadsNewPrev30);

  const bridge = env.WHATSAPP_BRIDGE_ENABLED;
  let systemStatus: DashboardSystemStatus;
  if (!bridge) {
    systemStatus = "offline";
  } else if (devicesOnline === 0) {
    systemStatus = "degraded";
  } else {
    systemStatus = "online";
  }

  const lastUpdatedLabel = now.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const kpis: DashboardOverviewKpi[] = [
    {
      id: "devices",
      label: "Connected devices",
      value:
        devicesTotal === 0
          ? "0"
          : `${devicesOnline} / ${devicesTotal}`,
      period: "Of registered devices",
      changeLabel: "—",
      trend: "neutral",
      iconKey: "sessions",
    },
    {
      id: "messages",
      label: "Outbound messages",
      value: formatCompact(outboundLast30),
      period: "Last 30 days",
      changeLabel: msgTrend.label,
      trend: msgTrend.trend,
      iconKey: "messages",
    },
    {
      id: "delivery",
      label: "Send success rate",
      value: formatPct(deliveryRate),
      period: "Last 30 days (sent vs failed)",
      changeLabel:
        settled === 0
          ? "No settled sends"
          : sentFail === 0
            ? "No failures"
            : `${formatCompact(sentFail)} failed`,
      trend: settled === 0 || sentFail === 0 ? "positive" : "negative",
      iconKey: "delivery",
    },
    {
      id: "threads",
      label: "Live chat threads",
      value: formatCompact(liveThreadsTotal),
      period: `${formatCompact(liveThreads30)} with activity (30d)`,
      changeLabel: threadsTrend.label,
      trend: threadsTrend.trend,
      iconKey: "users",
    },
    {
      id: "contacts",
      label: "Contacts",
      value: formatCompact(contactsCount),
      period: "Across all groups",
      changeLabel: "—",
      trend: "neutral",
      iconKey: "contacts",
    },
    {
      id: "campaigns",
      label: "Bulk campaigns",
      value: formatCompact(bulkLast30),
      period: "Created last 30 days",
      changeLabel: bulkTrend.label,
      trend: bulkTrend.trend,
      iconKey: "campaigns",
    },
  ];

  const barByYm = new Map<string, number>();
  for (const o of outboundForCharts) {
    const y = o.createdAt.getUTCFullYear();
    const m = o.createdAt.getUTCMonth() + 1;
    const k = `${y}-${m}`;
    barByYm.set(k, (barByYm.get(k) ?? 0) + 1);
  }

  const barSeries: DashboardBarPoint[] = [];
  for (let i = 11; i >= 0; i -= 1) {
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = t.getUTCFullYear();
    const m = t.getUTCMonth() + 1;
    const label = t.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    barSeries.push({
      label,
      value: barByYm.get(`${y}-${m}`) ?? 0,
    });
  }

  function utcDayKey(d: Date): string {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  }

  type LineBucket = { s1: number; s2: number; s3: number; s4: number };
  const lineByDay = new Map<string, LineBucket>();
  function bumpDay(d: Date): LineBucket {
    const k = utcDayKey(d);
    let b = lineByDay.get(k);
    if (!b) {
      b = { s1: 0, s2: 0, s3: 0, s4: 0 };
      lineByDay.set(k, b);
    }
    return b;
  }

  const liveChatOutboundIds = new Set(
    liveChatOutboundRows
      .map((row) => row.outboundMessageId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );

  for (const o of outboundForCharts) {
    if (o.createdAt < lineFrom) continue;
    const b = bumpDay(o.createdAt);
    // Live-chat outbound rows also create OutboundMessage TEXT rows — count once as s4.
    if (liveChatOutboundIds.has(o.id)) {
      b.s4 += 1;
    } else if (o.bulkCampaignId) {
      b.s1 += 1;
    } else if (o.kind === OutboundKind.TEXT) {
      b.s2 += 1;
    } else if (o.kind === OutboundKind.TEMPLATE) {
      b.s3 += 1;
    }
  }

  const lineSeries: DashboardLinePoint[] = [];
  for (
    let t = new Date(lineFrom);
    t.getTime() <= dayStartUtc.getTime();
    t.setUTCDate(t.getUTCDate() + 1)
  ) {
    const k = utcDayKey(t);
    const b = lineByDay.get(k) ?? { s1: 0, s2: 0, s3: 0, s4: 0 };
    lineSeries.push({
      x: `${t.getUTCMonth() + 1}/${t.getUTCDate()}`,
      s1: b.s1,
      s2: b.s2,
      s3: b.s3,
      s4: b.s4,
    });
  }

  const autoProgress =
    totalAutoRules > 0
      ? Math.round((activeAutoRules / totalAutoRules) * 100)
      : 0;
  const bulkProgress =
    bulkCampaignsTotal > 0
      ? Math.round((bulkCompleted / bulkCampaignsTotal) * 100)
      : 0;
  const botProgress =
    totalFlows > 0 ? Math.round((activeFlows / totalFlows) * 100) : 0;
  const tplProgress =
    templatesTotal > 0
      ? Math.round((templatesActive / templatesTotal) * 100)
      : 0;

  const summaries: DashboardSummaryCard[] = [
    {
      id: "auto-reply",
      title: "Auto reply",
      rows: [
        { label: "Active rules", value: activeAutoRules },
        { label: "Total responses", value: totalResponses },
      ],
      progress: autoProgress,
      icon: "reply",
    },
    {
      id: "bulk",
      title: "Bulk sends",
      rows: [
        { label: "Campaigns", value: bulkCampaignsTotal },
        {
          label: "In progress",
          value: bulkInProgress + bulkScheduled,
        },
      ],
      progress: bulkProgress,
      icon: "bulk",
    },
    {
      id: "chatbot",
      title: "Chatbot",
      rows: [
        { label: "Active flows", value: activeFlows },
        { label: "Flow conversations", value: flowConversations },
      ],
      progress: botProgress,
      icon: "bot",
    },
    {
      id: "templates",
      title: "Templates",
      rows: [
        { label: "Active", value: templatesActive },
        { label: "Inactive", value: templatesInactive },
      ],
      progress: tplProgress,
      icon: "template",
    },
  ];

  return {
    generatedAt: now.toISOString(),
    systemStatus,
    lastUpdatedLabel,
    devicesOnline,
    devicesTotal,
    messagesToday,
    kpis,
    barSeries,
    lineSeries,
    summaries,
  };
}

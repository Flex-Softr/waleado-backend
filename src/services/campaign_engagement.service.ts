import { BulkCampaignRecipientStatus } from "@prisma/client";
import type {
  MessageUserReceiptUpdate,
  WAMessageUpdate,
} from "@whiskeysockets/baileys";
import { prisma } from "../lib/prisma";

const ATTRIBUTION_WINDOW_DAYS = 30;

function statusNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseReceiptDate(value: unknown): Date {
  if (typeof value === "number" && Number.isFinite(value)) {
    const sec = value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
    return new Date(sec * 1000);
  }
  if (typeof value === "object" && value !== null) {
    const o = value as { toNumber?: () => number; low?: number };
    if (typeof o.toNumber === "function") {
      const n = o.toNumber();
      if (Number.isFinite(n)) {
        const sec = n > 1_000_000_000_000 ? Math.floor(n / 1000) : n;
        return new Date(sec * 1000);
      }
    } else if (typeof o.low === "number" && Number.isFinite(o.low)) {
      const n = o.low;
      const sec = n > 1_000_000_000_000 ? Math.floor(n / 1000) : n;
      return new Date(sec * 1000);
    }
  }
  return new Date();
}

async function updateRecipientReceiptByMessageId(input: {
  workspaceId: string;
  deviceId: string;
  messageId: string;
  deliveredAt?: Date;
  seenAt?: Date;
}): Promise<void> {
  const outbound = await prisma.outboundMessage.findFirst({
    where: {
      workspaceId: input.workspaceId,
      deviceId: input.deviceId,
      OR: [
        { providerRef: input.messageId },
        { providerRef: { endsWith: `:${input.messageId}` } },
      ],
      bulkRecipient: { isNot: null },
    },
    select: {
      bulkRecipient: { select: { id: true, deliveredAt: true, seenAt: true } },
    },
  });
  const recipient = outbound?.bulkRecipient;
  if (!recipient) return;

  await prisma.bulkCampaignRecipient.update({
    where: { id: recipient.id },
    data: {
      ...(input.deliveredAt && !recipient.deliveredAt
        ? { deliveredAt: input.deliveredAt }
        : {}),
      ...(input.seenAt && !recipient.seenAt ? { seenAt: input.seenAt } : {}),
    },
  });
}

export async function recordCampaignMessageStatusUpdates(
  workspaceId: string,
  deviceId: string,
  updates: WAMessageUpdate[]
): Promise<void> {
  for (const item of updates) {
    const id = item.key.id;
    if (!id) continue;
    const status = statusNumber(item.update.status);
    if (status === null) continue;

    const now = new Date();
    await updateRecipientReceiptByMessageId({
      workspaceId,
      deviceId,
      messageId: id,
      deliveredAt: status >= 2 ? now : undefined,
      seenAt: status >= 3 ? now : undefined,
    });
  }
}

export async function recordCampaignMessageReceiptUpdates(
  workspaceId: string,
  deviceId: string,
  updates: MessageUserReceiptUpdate[]
): Promise<void> {
  for (const item of updates) {
    const id = item.key.id;
    if (!id) continue;
    const receipt = item.receipt as {
      receiptTimestamp?: unknown;
      readTimestamp?: unknown;
    };
    await updateRecipientReceiptByMessageId({
      workspaceId,
      deviceId,
      messageId: id,
      deliveredAt: receipt?.receiptTimestamp
        ? parseReceiptDate(receipt.receiptTimestamp)
        : undefined,
      seenAt: receipt?.readTimestamp
        ? parseReceiptDate(receipt.readTimestamp)
        : undefined,
    });
  }
}

export async function attributeInboundReplyToCampaign(input: {
  workspaceId: string;
  deviceId: string;
  peerPhone: string;
  bodyText: string;
  repliedAt: Date;
  liveChatMessageId: string;
}): Promise<void> {
  const since = new Date(
    input.repliedAt.getTime() - ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
  const rawClean = input.peerPhone.replace(/^\+/, "").trim();
  const phoneVariants = [
    input.peerPhone.trim(),
    rawClean,
    `+${rawClean}`,
  ].filter(Boolean);

  const recipient = await prisma.bulkCampaignRecipient.findFirst({
    where: {
      workspaceId: input.workspaceId,
      phone: { in: phoneVariants },
      deviceId: input.deviceId,
      status: {
        in: [
          BulkCampaignRecipientStatus.SENT,
          BulkCampaignRecipientStatus.SIMULATED,
        ],
      },
      sentAt: { gte: since, lte: input.repliedAt },
    },
    orderBy: [{ sentAt: "desc" }, { updatedAt: "desc" }],
    select: { id: true, deliveredAt: true, seenAt: true },
  });
  if (!recipient) return;

  await prisma.bulkCampaignRecipient.update({
    where: { id: recipient.id },
    data: {
      repliedAt: input.repliedAt,
      lastReplyAt: input.repliedAt,
      lastReplyText: input.bodyText.slice(0, 1000),
      lastReplyMessageId: input.liveChatMessageId,
      // If a recipient replied, they evidently received and saw the message
      ...(!recipient.deliveredAt ? { deliveredAt: input.repliedAt } : {}),
      ...(!recipient.seenAt ? { seenAt: input.repliedAt } : {}),
    },
  });
}

import {
  NotificationAudience,
  NotificationType,
  Prisma,
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";

export type AuthCallerContext = {
  userId: string;
  workspaceId: string;
  userRole: "ADMIN" | "CUSTOMER" | string;
};

export type CreateNotificationInput = {
  audience?: NotificationAudience;
  type: NotificationType;
  title: string;
  message: string;
  workspaceId?: string | null;
  userId?: string | null;
  link?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export type ListNotificationsQuery = {
  unreadOnly?: boolean;
  page?: number;
  pageSize?: number;
};

function buildCallerWhere(caller: AuthCallerContext): Prisma.NotificationWhereInput {
  if (caller.userRole === "ADMIN") {
    // Admin sees platform admin notifications + their current workspace's customer notifications
    return {
      OR: [
        { audience: NotificationAudience.ADMIN },
        { audience: NotificationAudience.ALL },
        {
          audience: NotificationAudience.CUSTOMER,
          workspaceId: caller.workspaceId,
        },
      ],
    };
  }

  // Customer only sees notifications targeting their workspace (or broadcast to all)
  return {
    OR: [
      {
        audience: NotificationAudience.CUSTOMER,
        workspaceId: caller.workspaceId,
        OR: [
          { userId: null },
          { userId: caller.userId },
        ],
      },
      { audience: NotificationAudience.ALL },
    ],
  };
}

/**
 * Creates a persistent notification for a customer workspace or platform admins.
 */
export async function createNotification(input: CreateNotificationInput) {
  try {
    return await prisma.notification.create({
      data: {
        audience: input.audience ?? NotificationAudience.CUSTOMER,
        type: input.type,
        title: input.title.trim().slice(0, 255),
        message: input.message.trim(),
        workspaceId: input.workspaceId ?? null,
        userId: input.userId ?? null,
        link: input.link?.trim().slice(0, 500) ?? null,
        metadata: input.metadata ?? Prisma.JsonNull,
      },
    });
  } catch (err) {
    console.error("[notifications] failed to create notification:", err);
    return null;
  }
}

/**
 * Lists notifications accessible by the current caller.
 */
export async function listNotifications(
  caller: AuthCallerContext,
  query: ListNotificationsQuery = {}
) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20));
  const skip = (page - 1) * pageSize;

  const baseWhere = buildCallerWhere(caller);
  const where: Prisma.NotificationWhereInput = {
    ...baseWhere,
    ...(query.unreadOnly ? { isRead: false } : {}),
  };

  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({
      where: {
        ...baseWhere,
        isRead: false,
      },
    }),
  ]);

  return {
    notifications,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
    unreadCount,
  };
}

/**
 * Gets the number of unread notifications for navbar badge display.
 */
export async function getUnreadNotificationCount(
  caller: AuthCallerContext
): Promise<number> {
  const baseWhere = buildCallerWhere(caller);
  return prisma.notification.count({
    where: {
      ...baseWhere,
      isRead: false,
    },
  });
}

/**
 * Marks a specific notification as read.
 */
export async function markNotificationAsRead(
  caller: AuthCallerContext,
  notificationId: string
) {
  const baseWhere = buildCallerWhere(caller);
  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      ...baseWhere,
    },
  });

  if (!notification) {
    throw new AppError(404, "Notification not found", "NOT_FOUND");
  }

  if (notification.isRead) {
    return notification;
  }

  return prisma.notification.update({
    where: { id: notificationId },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });
}

/**
 * Marks all unread notifications for the caller as read.
 */
export async function markAllNotificationsAsRead(
  caller: AuthCallerContext
): Promise<{ count: number }> {
  const baseWhere = buildCallerWhere(caller);
  const result = await prisma.notification.updateMany({
    where: {
      ...baseWhere,
      isRead: false,
    },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });

  return { count: result.count };
}

/**
 * Dismisses/deletes a specific notification.
 */
export async function deleteNotification(
  caller: AuthCallerContext,
  notificationId: string
): Promise<void> {
  const baseWhere = buildCallerWhere(caller);
  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      ...baseWhere,
    },
  });

  if (!notification) {
    throw new AppError(404, "Notification not found", "NOT_FOUND");
  }

  await prisma.notification.delete({
    where: { id: notificationId },
  });
}

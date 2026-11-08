import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

/** Records an admin billing action (who, what, on which workspace). */
export async function logBillingAction(input: {
  action: string;
  actorUserId: string | null;
  workspaceId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.billingAuditLog.create({
      data: {
        action: input.action,
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId ?? null,
        detail: (input.detail ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    console.error("[billing-audit] failed to record action", input.action, err);
  }
}

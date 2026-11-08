import { NotificationAudience, NotificationType, type Invoice } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { createNotification } from "../../services/notifications.service";
import { dispatchSystemMessage } from "../../system-messages/dispatcher.service";
import { formatBdt } from "../period";

/** In-app notices for admin and customer, plus the customer's email/WhatsApp receipt. */
export async function notifyInvoicePaid(invoice: Invoice): Promise<void> {
  try {
    const ws = await prisma.workspace.findUnique({
      where: { id: invoice.workspaceId },
      select: { name: true, walletBalance: true },
    });
    const collected = Number(invoice.total) + Number(invoice.walletAmount);
    const amount = formatBdt(invoice.kind === "topup" ? Number(invoice.subtotal) : collected);

    await createNotification({
      audience: NotificationAudience.ADMIN,
      type: NotificationType.PAYMENT_RECEIVED,
      title: `Payment Received: ${amount}`,
      message: `${invoice.description} — "${ws?.name ?? "Workspace"}" (Invoice ${invoice.number}, ${invoice.gateway ?? "—"}).`,
      link: "/admin/invoices",
      metadata: { invoiceId: invoice.id, invoiceNumber: invoice.number, workspaceId: invoice.workspaceId },
    });
    await createNotification({
      audience: NotificationAudience.CUSTOMER,
      workspaceId: invoice.workspaceId,
      type: NotificationType.PAYMENT_RECEIVED,
      title: "Payment confirmed",
      message: `${invoice.description} — ${amount}. Invoice ${invoice.number}.`,
      link: "/billing",
      metadata: { invoiceId: invoice.id, invoiceNumber: invoice.number },
    });

    if (invoice.kind === "topup") {
      await dispatchSystemMessage({
        key: "wallet_topup",
        workspaceId: invoice.workspaceId,
        vars: { amount, balance: formatBdt(Number(ws?.walletBalance ?? 0)) },
      });
    } else {
      await dispatchSystemMessage({
        key: "payment_received",
        workspaceId: invoice.workspaceId,
        vars: { amount, description: invoice.description, invoice: invoice.number },
      });
    }
  } catch (e) {
    console.warn("[billing] invoice paid notification failed:", e);
  }
}

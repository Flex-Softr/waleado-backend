import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../env";
import { isMailConfigured, sendMail, textToHtml } from "./mailer";
import { getSystemSettings } from "./settings.service";
import { getTemplate } from "./template-store.service";
import { renderTemplate, type TemplateKey, type TemplateVars } from "./templates";
import { sendSystemWhatsApp, type ChannelResult } from "./whatsapp-sender";

export type Recipient = { name: string | null; email: string | null; phone: string | null };

export type DispatchResult =
  | { status: "duplicate" }
  | { status: "done"; email: ChannelResult; whatsapp: ChannelResult };

/** Owner of a workspace, with the phone confirmed by OTP preferred over the profile phone. */
export async function getWorkspaceRecipient(workspaceId: string): Promise<Recipient & { workspace: string }> {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      name: true,
      memberships: {
        where: { role: "OWNER" },
        take: 1,
        select: { user: { select: { name: true, email: true, phone: true, verifiedPhone: true } } },
      },
    },
  });
  const user = ws?.memberships[0]?.user;
  return {
    workspace: ws?.name ?? "your workspace",
    name: user?.name ?? null,
    email: user?.email ?? null,
    phone: user?.verifiedPhone ?? user?.phone ?? null,
  };
}

/** Claims a dedupe key; false when the same message was already sent. */
async function claimDedupeKey(dedupeKey: string, workspaceId: string | null, key: TemplateKey): Promise<boolean> {
  try {
    await prisma.notificationLog.create({ data: { dedupeKey, workspaceId, templateKey: key } });
    return true;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
    throw e;
  }
}

export function billingLink(): string {
  return `${env.APP_PUBLIC_URL.replace(/\/$/, "")}/billing`;
}

/**
 * Sends a system message by template over every enabled channel.
 * With `dedupeKey`, the same key is never sent twice (safe for scheduled jobs).
 */
export async function dispatchSystemMessage(input: {
  key: TemplateKey;
  vars: TemplateVars;
  workspaceId?: string;
  /** Explicit recipient; defaults to the workspace owner. */
  to?: Recipient;
  dedupeKey?: string;
  /** Limit to these channels (e.g. OTP is WhatsApp only). */
  channels?: Array<"email" | "whatsapp">;
}): Promise<DispatchResult> {
  const workspaceId = input.workspaceId ?? null;
  if (input.dedupeKey && !(await claimDedupeKey(input.dedupeKey, workspaceId, input.key))) {
    return { status: "duplicate" };
  }

  const [settings, template] = await Promise.all([getSystemSettings(), getTemplate(input.key)]);
  const owner = workspaceId ? await getWorkspaceRecipient(workspaceId) : null;
  const to = input.to ?? owner;
  const vars: TemplateVars = {
    name: to?.name ?? "there",
    workspace: owner?.workspace,
    billing_link: billingLink(),
    ...input.vars,
  };
  const wants = (c: "email" | "whatsapp") => !input.channels || input.channels.includes(c);

  let email: ChannelResult = "skipped";
  if (
    wants("email") &&
    settings.emailEnabled &&
    isMailConfigured() &&
    template.emailEnabled &&
    template.email &&
    to?.email
  ) {
    const body = renderTemplate(template.email.body, vars);
    const res = await sendMail({
      to: to.email,
      subject: renderTemplate(template.email.subject, vars),
      text: body,
      html: textToHtml(body),
    });
    email = res.delivered ? "sent" : "failed";
  }

  let whatsapp: ChannelResult = "skipped";
  if (wants("whatsapp") && template.whatsappEnabled && template.whatsapp && to?.phone) {
    whatsapp = await sendSystemWhatsApp(to.phone, renderTemplate(template.whatsapp, vars));
  }

  if (input.dedupeKey) {
    await prisma.notificationLog.update({
      where: { dedupeKey: input.dedupeKey },
      data: { result: { email, whatsapp } },
    });
  }
  return { status: "done", email, whatsapp };
}

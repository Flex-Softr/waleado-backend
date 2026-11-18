import { prisma } from "../lib/prisma";
import type { RenderContext } from "../lib/template-render";

/**
 * Who a template is going to, for {name} and {phone}: the live-chat label on that number,
 * else the name saved in the workspace's contacts. Never throws; a miss just means no name.
 */
export async function templateContextFor(
  workspaceId: string,
  phone: string | null | undefined,
  deviceId?: string | null
): Promise<RenderContext> {
  if (!phone) return {};
  const e164 = phone.startsWith("+") ? phone : `+${phone.replace(/\D/g, "")}`;
  try {
    const thread = await prisma.liveChatThread.findFirst({
      where: { workspaceId, peerPhone: e164, ...(deviceId ? { deviceId } : {}) },
      select: { peerLabel: true },
      orderBy: { lastMessageAt: "desc" },
    });
    let name = thread?.peerLabel?.trim() || "";
    if (!name) {
      const contact = await prisma.contact.findFirst({
        where: {
          group: { workspaceId },
          phone: { in: [e164, e164.slice(1)] },
          name: { not: "" },
        },
        select: { name: true },
      });
      name = contact?.name.trim() ?? "";
    }
    // A label that is just the number again is not a name.
    if (name.replace(/\D/g, "") === e164.replace(/\D/g, "")) name = "";
    return { name: name || null, phone: e164 };
  } catch {
    return { phone: e164 };
  }
}

import { env } from "../env";
import { resolveOpenWaSocketForWorkspace } from "./wa-device-session.service";

const CHUNK = 80;

function jidLeadingDigits(jid: string): string {
  const m = jid.match(/^(\d+)/);
  return m?.[1] ?? "";
}

/**
 * Uses Baileys `onWhatsApp` (WhatsApp USync) against a connected workspace device.
 * Returns null if the bridge is off, no active open session, or the socket/query fails.
 *
 * Does not start or wait on sessions — if nothing is already open, returns null immediately
 * so contact revalidation can finish with formatting-only results.
 */
export async function checkE164RegisteredOnWhatsApp(
  workspaceId: string,
  e164Phones: string[]
): Promise<Map<string, boolean> | null> {
  if (!env.WHATSAPP_BRIDGE_ENABLED || e164Phones.length === 0) {
    return null;
  }

  const resolved = await resolveOpenWaSocketForWorkspace(workspaceId, {
    onlyAlreadyOpen: true,
    maxDevices: 8,
  });
  if (!resolved) {
    return null;
  }
  const { sock } = resolved;

  const unique = [...new Set(e164Phones)];
  const out = new Map<string, boolean>();

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;

    let results: { jid: string; exists: boolean }[] | undefined;
    try {
      // Baileys accepts E.164 (+…) or …@s.whatsapp.net; E.164 matches USync reliably.
      results = await sock.onWhatsApp(...chunk);
    } catch (e) {
      console.error("[wa-presence] onWhatsApp failed", e);
      return null;
    }

    const byDigits = new Map<string, boolean>();
    for (const r of results ?? []) {
      const k = jidLeadingDigits(r.jid);
      if (k) byDigits.set(k, r.exists);
    }
    for (const e164 of chunk) {
      const d = e164.replace(/\D/g, "");
      out.set(e164, byDigits.get(d) ?? false);
    }
  }

  return out;
}

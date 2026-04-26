"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkE164RegisteredOnWhatsApp = checkE164RegisteredOnWhatsApp;
const env_1 = require("../env");
const wa_device_session_service_1 = require("./wa-device-session.service");
const CHUNK = 80;
function jidLeadingDigits(jid) {
    const m = jid.match(/^(\d+)/);
    return m?.[1] ?? "";
}
/**
 * Uses Baileys `onWhatsApp` (WhatsApp USync) against a connected workspace device.
 * Returns null if the bridge is off, no connected device, or the socket/query fails.
 */
async function checkE164RegisteredOnWhatsApp(workspaceId, e164Phones) {
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED || e164Phones.length === 0) {
        return null;
    }
    const resolved = await (0, wa_device_session_service_1.resolveOpenWaSocketForWorkspace)(workspaceId, {
        perDeviceTimeoutMs: 22_000,
        maxDevices: 8,
    });
    if (!resolved) {
        return null;
    }
    const { sock } = resolved;
    const unique = [...new Set(e164Phones)];
    const out = new Map();
    for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK);
        if (chunk.length === 0)
            continue;
        let results;
        try {
            // Baileys accepts E.164 (+…) or …@s.whatsapp.net; E.164 matches USync reliably.
            results = await sock.onWhatsApp(...chunk);
        }
        catch (e) {
            console.error("[wa-presence] onWhatsApp failed", e);
            return null;
        }
        const byDigits = new Map();
        for (const r of results ?? []) {
            const k = jidLeadingDigits(r.jid);
            if (k)
                byDigits.set(k, r.exists);
        }
        for (const e164 of chunk) {
            const d = e164.replace(/\D/g, "");
            out.set(e164, byDigits.get(d) ?? false);
        }
    }
    return out;
}

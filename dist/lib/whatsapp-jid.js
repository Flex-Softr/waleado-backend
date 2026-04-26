"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.e164ToWhatsAppJid = e164ToWhatsAppJid;
/** Build WhatsApp multi-device JID from E.164 (e.g. +1 234 → 1234@s.whatsapp.net). */
function e164ToWhatsAppJid(e164) {
    const digits = e164.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) {
        throw new Error("Phone must be valid E.164 (8–15 digits) for WhatsApp");
    }
    return `${digits}@s.whatsapp.net`;
}

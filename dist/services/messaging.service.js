"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSingleMessage = sendSingleMessage;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const errors_1 = require("../lib/errors");
const phone_1 = require("../lib/phone");
const whatsapp_jid_1 = require("../lib/whatsapp-jid");
const env_1 = require("../env");
const templates_service_1 = require("./templates.service");
const wa_outbound_content_1 = require("./wa-outbound-content");
const waSession = __importStar(require("./wa-device-session.service"));
function statusToApi(s) {
    switch (s) {
        case client_1.OutboundStatus.QUEUED:
            return "queued";
        case client_1.OutboundStatus.SENT:
            return "sent";
        case client_1.OutboundStatus.FAILED:
            return "failed";
        case client_1.OutboundStatus.SIMULATED:
            return "simulated";
        default:
            return "queued";
    }
}
async function sendSingleMessage(workspaceId, payload) {
    const phone = (0, phone_1.validateAndFormatPhone)(payload.toPhone);
    if (!phone.valid) {
        throw new errors_1.AppError(400, phone.message, "INVALID_PHONE");
    }
    const device = await prisma_1.prisma.device.findFirst({
        where: { id: payload.deviceId, workspaceId },
    });
    if (!device) {
        throw new errors_1.AppError(404, "Device not found", "NOT_FOUND");
    }
    if (device.status !== client_1.DeviceStatus.CONNECTED) {
        throw new errors_1.AppError(400, "Device must be connected before sending. Complete QR pairing under Devices first.", "DEVICE_NOT_CONNECTED");
    }
    let templateId = null;
    let bodyText = null;
    let kind;
    /** Resolved Baileys payload for template sends (after validation). */
    let templateWaContent = null;
    let textToSend;
    if (payload.kind === "text") {
        const text = payload.bodyText.trim();
        if (!text) {
            throw new errors_1.AppError(400, "Message text is required", "VALIDATION");
        }
        if (text.length > 4096) {
            throw new errors_1.AppError(400, "Message is too long (max 4096 characters)", "VALIDATION");
        }
        bodyText = text;
        textToSend = text;
        kind = client_1.OutboundKind.TEXT;
    }
    else {
        const tpl = await (0, templates_service_1.requireActiveTemplate)(workspaceId, payload.templateId);
        try {
            templateWaContent = await (0, wa_outbound_content_1.buildTemplateWhatsAppContent)(workspaceId, tpl);
        }
        catch (e) {
            if (e instanceof errors_1.AppError)
                throw e;
            const msg = e instanceof Error ? e.message : String(e);
            throw new errors_1.AppError(400, `Template cannot be sent: ${msg}`, "VALIDATION");
        }
        const summary = tpl.body?.trim() || tpl.name.trim() || "(template message)";
        if (summary.length > 4096) {
            throw new errors_1.AppError(400, "Template content is too long", "VALIDATION");
        }
        textToSend = summary;
        templateId = tpl.id;
        bodyText = null;
        kind = client_1.OutboundKind.TEMPLATE;
    }
    const row = await prisma_1.prisma.outboundMessage.create({
        data: {
            workspaceId,
            deviceId: device.id,
            toPhone: phone.e164,
            kind,
            bodyText: kind === client_1.OutboundKind.TEXT ? bodyText : null,
            templateId,
            status: client_1.OutboundStatus.QUEUED,
        },
    });
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        console.warn("[messaging] WHATSAPP_BRIDGE_ENABLED is false — single message stored as SIMULATED (no WhatsApp send).");
        const final = await prisma_1.prisma.outboundMessage.update({
            where: { id: row.id },
            data: {
                status: client_1.OutboundStatus.SIMULATED,
                providerRef: "demo:no_provider",
            },
        });
        return {
            id: final.id,
            status: statusToApi(final.status),
            kind: final.kind === client_1.OutboundKind.TEXT ? "text" : "template",
            toPhone: final.toPhone,
            deviceId: final.deviceId,
            templateId: final.templateId,
            bodyText: final.bodyText,
            createdAt: final.createdAt.toISOString(),
            note: "Bridge is off: set WHATSAPP_BRIDGE_ENABLED=true in the repo root .env, restart the API, then send again. Check the API log on startup for: bridge ENABLED.",
        };
    }
    const sock = await waSession.waitForOpenWaSocket(device.id, workspaceId);
    if (!sock) {
        await prisma_1.prisma.outboundMessage.update({
            where: { id: row.id },
            data: {
                status: client_1.OutboundStatus.FAILED,
                errorMessage: "WhatsApp session is not online. Open Devices, reconnect if needed, then try again.",
            },
        });
        throw new errors_1.AppError(503, "WhatsApp session is offline or still connecting. Open Devices to restore the session, wait a few seconds, and try again.", "WA_SESSION_OFFLINE");
    }
    let jid;
    try {
        jid = (0, whatsapp_jid_1.e164ToWhatsAppJid)(phone.e164);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "Invalid phone for WhatsApp";
        await prisma_1.prisma.outboundMessage.update({
            where: { id: row.id },
            data: { status: client_1.OutboundStatus.FAILED, errorMessage: msg },
        });
        throw new errors_1.AppError(400, msg, "INVALID_PHONE");
    }
    try {
        const outgoing = kind === client_1.OutboundKind.TEXT
            ? { text: textToSend }
            : templateWaContent;
        const waMsg = await sock.sendMessage(jid, outgoing);
        const key = waMsg?.key;
        const providerRef = key?.id
            ? `${key.remoteJid ?? jid}:${key.id}`
            : "baileys";
        const final = await prisma_1.prisma.outboundMessage.update({
            where: { id: row.id },
            data: {
                status: client_1.OutboundStatus.SENT,
                providerRef,
                ...(kind === client_1.OutboundKind.TEMPLATE
                    ? { bodyText: textToSend }
                    : {}),
            },
        });
        return {
            id: final.id,
            status: statusToApi(final.status),
            kind: final.kind === client_1.OutboundKind.TEXT ? "text" : "template",
            toPhone: final.toPhone,
            deviceId: final.deviceId,
            templateId: final.templateId,
            bodyText: final.bodyText,
            createdAt: final.createdAt.toISOString(),
            note: `Sent from device “${device.name}” via your linked WhatsApp.`,
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const clipped = msg.slice(0, 500);
        await prisma_1.prisma.outboundMessage.update({
            where: { id: row.id },
            data: {
                status: client_1.OutboundStatus.FAILED,
                errorMessage: clipped,
            },
        });
        throw new errors_1.AppError(502, `WhatsApp could not send this message: ${clipped}`, "WHATSAPP_SEND_FAILED");
    }
}

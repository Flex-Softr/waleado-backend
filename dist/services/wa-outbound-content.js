"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTemplateWhatsAppContent = buildTemplateWhatsAppContent;
exports.buildBulkTextCampaignContent = buildBulkTextCampaignContent;
exports.buildAutoReplyMediaContent = buildAutoReplyMediaContent;
const fs_1 = __importDefault(require("fs"));
const errors_1 = require("../lib/errors");
const template_types_1 = require("../lib/template-types");
const template_media_assets_service_1 = require("./template-media-assets.service");
function asMediaJson(media) {
    if (media === null || media === undefined)
        return {};
    if (typeof media !== "object" || Array.isArray(media))
        return {};
    return media;
}
async function resolveMediaUpload(workspaceId, media) {
    const fileId = typeof media.fileId === "string" ? media.fileId : "";
    const externalUrl = typeof media.externalUrl === "string" ? media.externalUrl.trim() : "";
    if (fileId) {
        const resolved = await (0, template_media_assets_service_1.getAssetFilePath)(workspaceId, fileId);
        if (!resolved) {
            throw new errors_1.AppError(400, "Template media file is missing or was removed — re-upload in Templates.", "VALIDATION");
        }
        const buf = await fs_1.default.promises.readFile(resolved.absolutePath);
        return {
            upload: buf,
            mimeType: resolved.mimeType,
            fileName: resolved.originalName,
        };
    }
    if (externalUrl) {
        return { upload: { url: externalUrl } };
    }
    throw new errors_1.AppError(400, "This template has no image or file attached — edit the template and add media.", "VALIDATION");
}
function captionFromTemplate(body, footer) {
    const parts = [body?.trim(), footer?.trim()].filter((p) => Boolean(p));
    if (parts.length === 0)
        return undefined;
    return parts.join("\n\n");
}
function digitsOnlyPhone(raw) {
    return raw.replace(/\D/g, "");
}
function contactVcard(name, phone, org) {
    const raw = phone.trim();
    const telLine = raw
        ? `TEL;type=CELL:${raw.startsWith("+") ? raw : `+${digitsOnlyPhone(raw)}`}`
        : "";
    const lines = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `FN:${name.replace(/\n/g, " ")}`,
        telLine,
        org?.trim() ? `ORG:${org.replace(/\n/g, " ")}` : "",
        "END:VCARD",
    ].filter(Boolean);
    return lines.join("\n");
}
/**
 * Maps a DB message template to Baileys `sendMessage` content (text, image, video, etc.).
 */
async function buildTemplateWhatsAppContent(workspaceId, tpl) {
    const caption = captionFromTemplate(tpl.body, tpl.footer);
    const textFallback = tpl.body?.trim() || tpl.name.trim() || " ";
    const typeRaw = tpl.typeId;
    const typeId = (0, template_types_1.isTemplateTypeId)(typeRaw)
        ? typeRaw
        : null;
    const media = asMediaJson(tpl.media);
    if (!typeId) {
        return { text: textFallback };
    }
    switch (typeId) {
        case "text_message":
        case "message_buttons":
        case "mixed_interactive":
        case "message_list":
        case "message_carousel":
        case "cta_button":
        case "copy_code":
        case "flow_message":
            return { text: textFallback };
        case "message_image": {
            const r = await resolveMediaUpload(workspaceId, media);
            return { image: r.upload, ...(caption ? { caption } : {}) };
        }
        case "message_video": {
            const r = await resolveMediaUpload(workspaceId, media);
            return { video: r.upload, ...(caption ? { caption } : {}) };
        }
        case "message_document": {
            const r = await resolveMediaUpload(workspaceId, media);
            const mime = r.mimeType ||
                (typeof media.mimeType === "string" ? media.mimeType : "") ||
                "application/octet-stream";
            const fileName = r.fileName ||
                (typeof media.originalName === "string" ? media.originalName : "") ||
                "file";
            return {
                document: r.upload,
                mimetype: mime,
                fileName,
                ...(caption ? { caption } : {}),
            };
        }
        case "message_audio": {
            const r = await resolveMediaUpload(workspaceId, media);
            const mime = r.mimeType ?? "";
            const ptt = mime.includes("ogg") ||
                mime.includes("opus") ||
                mime.startsWith("audio/ogg");
            return { audio: r.upload, ptt };
        }
        case "message_location": {
            const lat = Number(media.latitude);
            const lng = Number(media.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                throw new errors_1.AppError(400, "Location template has invalid coordinates — edit the template.", "VALIDATION");
            }
            const name = typeof media.locationName === "string"
                ? media.locationName.slice(0, 200)
                : undefined;
            const address = typeof media.address === "string"
                ? media.address.slice(0, 500)
                : undefined;
            return {
                location: {
                    degreesLatitude: lat,
                    degreesLongitude: lng,
                    ...(name ? { name } : {}),
                    ...(address ? { address } : {}),
                },
            };
        }
        case "message_contact": {
            const contactName = typeof media.contactName === "string" ? media.contactName.trim() : "";
            const contactPhone = typeof media.contactPhone === "string" ? media.contactPhone.trim() : "";
            if (!contactName || !contactPhone) {
                throw new errors_1.AppError(400, "Contact template is incomplete — edit the template.", "VALIDATION");
            }
            const org = typeof media.contactOrg === "string" ? media.contactOrg.trim() : "";
            const vcard = contactVcard(contactName, contactPhone, org || undefined);
            return {
                contacts: {
                    displayName: contactName,
                    contacts: [{ displayName: contactName, vcard }],
                },
            };
        }
        case "message_poll": {
            const pollQuestion = typeof media.pollQuestion === "string" ? media.pollQuestion.trim() : "";
            const optsRaw = media.pollOptions;
            if (!pollQuestion || !Array.isArray(optsRaw)) {
                throw new errors_1.AppError(400, "Poll template is incomplete — edit the template.", "VALIDATION");
            }
            const values = optsRaw
                .map((o) => String(o).trim())
                .filter(Boolean)
                .slice(0, 12);
            if (values.length < 2) {
                throw new errors_1.AppError(400, "Poll template needs at least two options.", "VALIDATION");
            }
            return {
                poll: {
                    name: pollQuestion.slice(0, 300),
                    values,
                    selectableCount: 1,
                },
            };
        }
        default:
            return { text: textFallback };
    }
}
/**
 * Text bulk campaign with optional attachment (image/video/document/audio).
 */
async function buildBulkTextCampaignContent(workspaceId, bodyText, attachmentType, attachmentAssetId) {
    const text = bodyText.trim();
    if (!text) {
        throw new errors_1.AppError(400, "Message text is required", "VALIDATION");
    }
    if (!attachmentAssetId?.trim() || !attachmentType?.trim()) {
        return { text };
    }
    const resolved = await (0, template_media_assets_service_1.getAssetFilePath)(workspaceId, attachmentAssetId.trim());
    if (!resolved) {
        throw new errors_1.AppError(404, "Campaign attachment file not found — upload again.", "NOT_FOUND");
    }
    const buf = await fs_1.default.promises.readFile(resolved.absolutePath);
    const t = attachmentType.trim().toLowerCase();
    switch (t) {
        case "image":
            return { image: buf, caption: text };
        case "video":
            return { video: buf, caption: text };
        case "audio": {
            const mime = resolved.mimeType ?? "";
            const ptt = mime.includes("ogg") ||
                mime.includes("opus") ||
                mime.startsWith("audio/ogg");
            return { audio: buf, ptt };
        }
        case "document":
            return {
                document: buf,
                mimetype: resolved.mimeType || "application/octet-stream",
                fileName: resolved.originalName || "file",
                caption: text,
            };
        default:
            return { text };
    }
}
function mimeToMediaKind(mime) {
    const m = mime.toLowerCase();
    if (m.startsWith("image/"))
        return "image";
    if (m.startsWith("video/"))
        return "video";
    if (m.startsWith("audio/"))
        return "audio";
    return "document";
}
/** Auto-reply media: infer type from uploaded asset mime. */
async function buildAutoReplyMediaContent(workspaceId, assetId, caption) {
    const resolved = await (0, template_media_assets_service_1.getAssetFilePath)(workspaceId, assetId);
    if (!resolved) {
        throw new errors_1.AppError(404, "Media file not found — upload again under Templates media.", "NOT_FOUND");
    }
    const buf = await fs_1.default.promises.readFile(resolved.absolutePath);
    const kind = mimeToMediaKind(resolved.mimeType);
    const cap = caption?.trim() ? caption.trim() : undefined;
    switch (kind) {
        case "image":
            return { image: buf, ...(cap ? { caption: cap } : {}) };
        case "video":
            return { video: buf, ...(cap ? { caption: cap } : {}) };
        case "audio": {
            const mime = resolved.mimeType ?? "";
            const ptt = mime.includes("ogg") ||
                mime.includes("opus") ||
                mime.startsWith("audio/ogg");
            return { audio: buf, ptt };
        }
        default:
            return {
                document: buf,
                mimetype: resolved.mimeType || "application/octet-stream",
                fileName: resolved.originalName || "file",
                ...(cap ? { caption: cap } : {}),
            };
    }
}

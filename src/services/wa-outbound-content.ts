import fs from "fs";
import type { AnyMessageContent } from "@whiskeysockets/baileys";
import type { Prisma } from "@prisma/client";

import { AppError } from "../lib/errors";
import {
  isTemplateTypeId,
  type TemplateTypeId,
} from "../lib/template-types";
import { getAssetFilePath } from "./template-media-assets.service";

function asMediaJson(media: Prisma.JsonValue | null): Record<string, unknown> {
  if (media === null || media === undefined) return {};
  if (typeof media !== "object" || Array.isArray(media)) return {};
  return media as Record<string, unknown>;
}

type MediaResolved = {
  upload: Buffer | { url: string };
  mimeType?: string;
  fileName?: string;
};

async function resolveMediaUpload(
  workspaceId: string,
  media: Record<string, unknown>
): Promise<MediaResolved> {
  const fileId = typeof media.fileId === "string" ? media.fileId : "";
  const externalUrl =
    typeof media.externalUrl === "string" ? media.externalUrl.trim() : "";
  if (fileId) {
    const resolved = await getAssetFilePath(workspaceId, fileId);
    if (!resolved) {
      throw new AppError(
        400,
        "Template media file is missing or was removed — re-upload in Templates.",
        "VALIDATION"
      );
    }
    const buf = await fs.promises.readFile(resolved.absolutePath);
    return {
      upload: buf,
      mimeType: resolved.mimeType,
      fileName: resolved.originalName,
    };
  }
  if (externalUrl) {
    return { upload: { url: externalUrl } };
  }
  throw new AppError(
    400,
    "This template has no image or file attached — edit the template and add media.",
    "VALIDATION"
  );
}

function captionFromTemplate(
  body: string | null,
  footer: string | null
): string | undefined {
  const parts = [body?.trim(), footer?.trim()].filter(
    (p): p is string => Boolean(p)
  );
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}

function digitsOnlyPhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

function contactVcard(name: string, phone: string, org?: string): string {
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

export type TemplateRowForSend = {
  typeId: string;
  body: string | null;
  name: string;
  media: Prisma.JsonValue | null;
  footer: string | null;
};

/**
 * Maps a DB message template to Baileys `sendMessage` content (text, image, video, etc.).
 */
export async function buildTemplateWhatsAppContent(
  workspaceId: string,
  tpl: TemplateRowForSend
): Promise<AnyMessageContent> {
  const caption = captionFromTemplate(tpl.body, tpl.footer);
  const textFallback =
    tpl.body?.trim() || tpl.name.trim() || " ";
  const typeRaw = tpl.typeId;
  const typeId: TemplateTypeId | null = isTemplateTypeId(typeRaw)
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
      const mime =
        r.mimeType ||
        (typeof media.mimeType === "string" ? media.mimeType : "") ||
        "application/octet-stream";
      const fileName =
        r.fileName ||
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
      const ptt =
        mime.includes("ogg") ||
        mime.includes("opus") ||
        mime.startsWith("audio/ogg");
      return { audio: r.upload, ptt };
    }
    case "message_location": {
      const lat = Number(media.latitude);
      const lng = Number(media.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new AppError(
          400,
          "Location template has invalid coordinates — edit the template.",
          "VALIDATION"
        );
      }
      const name =
        typeof media.locationName === "string"
          ? media.locationName.slice(0, 200)
          : undefined;
      const address =
        typeof media.address === "string"
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
      const contactName =
        typeof media.contactName === "string" ? media.contactName.trim() : "";
      const contactPhone =
        typeof media.contactPhone === "string" ? media.contactPhone.trim() : "";
      if (!contactName || !contactPhone) {
        throw new AppError(
          400,
          "Contact template is incomplete — edit the template.",
          "VALIDATION"
        );
      }
      const org =
        typeof media.contactOrg === "string" ? media.contactOrg.trim() : "";
      const vcard = contactVcard(contactName, contactPhone, org || undefined);
      return {
        contacts: {
          displayName: contactName,
          contacts: [{ displayName: contactName, vcard }],
        },
      };
    }
    case "message_poll": {
      const pollQuestion =
        typeof media.pollQuestion === "string" ? media.pollQuestion.trim() : "";
      const optsRaw = media.pollOptions;
      if (!pollQuestion || !Array.isArray(optsRaw)) {
        throw new AppError(
          400,
          "Poll template is incomplete — edit the template.",
          "VALIDATION"
        );
      }
      const values = optsRaw
        .map((o) => String(o).trim())
        .filter(Boolean)
        .slice(0, 12);
      if (values.length < 2) {
        throw new AppError(
          400,
          "Poll template needs at least two options.",
          "VALIDATION"
        );
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
export async function buildBulkTextCampaignContent(
  workspaceId: string,
  bodyText: string,
  attachmentType: string | null,
  attachmentAssetId: string | null
): Promise<AnyMessageContent> {
  const text = bodyText.trim();
  if (!text) {
    throw new AppError(400, "Message text is required", "VALIDATION");
  }
  if (!attachmentAssetId?.trim() || !attachmentType?.trim()) {
    return { text };
  }

  const resolved = await getAssetFilePath(
    workspaceId,
    attachmentAssetId.trim()
  );
  if (!resolved) {
    throw new AppError(
      404,
      "Campaign attachment file not found — upload again.",
      "NOT_FOUND"
    );
  }
  const buf = await fs.promises.readFile(resolved.absolutePath);
  const t = attachmentType.trim().toLowerCase();

  switch (t) {
    case "image":
      return { image: buf, caption: text };
    case "video":
      return { video: buf, caption: text };
    case "audio": {
      const mime = resolved.mimeType ?? "";
      const ptt =
        mime.includes("ogg") ||
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

function mimeToMediaKind(
  mime: string
): "image" | "video" | "document" | "audio" {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
}

/** Auto-reply media: infer type from uploaded asset mime. */
export async function buildAutoReplyMediaContent(
  workspaceId: string,
  assetId: string,
  caption: string | null
): Promise<AnyMessageContent> {
  const resolved = await getAssetFilePath(workspaceId, assetId);
  if (!resolved) {
    throw new AppError(
      404,
      "Media file not found — upload again under Templates media.",
      "NOT_FOUND"
    );
  }
  const buf = await fs.promises.readFile(resolved.absolutePath);
  const kind = mimeToMediaKind(resolved.mimeType);
  const cap = caption?.trim() ? caption.trim() : undefined;
  switch (kind) {
    case "image":
      return { image: buf, ...(cap ? { caption: cap } : {}) };
    case "video":
      return { video: buf, ...(cap ? { caption: cap } : {}) };
    case "audio": {
      const mime = resolved.mimeType ?? "";
      const ptt =
        mime.includes("ogg") ||
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

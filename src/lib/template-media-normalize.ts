import type { Prisma } from "@prisma/client";

import { prisma } from "./prisma";
import { AppError } from "./errors";
import type { TemplateTypeId } from "./template-types";

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function requireHttpsUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new AppError(400, "Media URL must be http(s)", "VALIDATION");
    }
    return url.toString().slice(0, 2048);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(400, "Invalid media URL", "VALIDATION");
  }
}

async function verifyFile(
  workspaceId: string,
  fileId: string
): Promise<{ mimeType: string; originalName: string }> {
  const asset = await prisma.templateMediaAsset.findFirst({
    where: { id: fileId, workspaceId },
    select: { mimeType: true, originalName: true },
  });
  if (!asset) {
    throw new AppError(
      400,
      "Invalid or unknown media file — upload again",
      "VALIDATION"
    );
  }
  return asset;
}

function parseListSections(raw: unknown): {
  title: string;
  rows: { id: string; title: string; description?: string }[];
}[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(400, "List template needs at least one section", "VALIDATION");
  }
  const sections = raw.slice(0, 10).map((sec, i) => {
    const o = asRecord(sec);
    const title = str(o.title, 80) ?? `Section ${i + 1}`;
    const rowsRaw = o.rows;
    if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
      throw new AppError(400, "Each list section needs at least one row", "VALIDATION");
    }
    const rows = rowsRaw.slice(0, 10).map((row, j) => {
      const r = asRecord(row);
      const id = str(r.id, 64) ?? `row_${i}_${j}`;
      const rowTitle = str(r.title, 80);
      if (!rowTitle) {
        throw new AppError(400, "Each list row needs a title", "VALIDATION");
      }
      return {
        id,
        title: rowTitle,
        description: str(r.description, 120),
      };
    });
    return { title, rows };
  });
  return sections;
}

function parseCarouselCards(raw: unknown): {
  title?: string;
  body?: string;
  imageUrl?: string;
}[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(
      400,
      "Carousel template needs at least one card",
      "VALIDATION"
    );
  }
  return raw.slice(0, 10).map((c) => {
    const o = asRecord(c);
    const imageUrlRaw = str(o.imageUrl, 2048);
    let imageUrl: string | undefined;
    if (imageUrlRaw) {
      imageUrl = requireHttpsUrl(imageUrlRaw);
    }
    return {
      title: str(o.title, 80),
      body: str(o.body, 500),
      imageUrl,
    };
  });
}

/**
 * Validates client `media` JSON per template type and returns DB-safe JSON.
 */
export async function normalizeTemplateMedia(
  workspaceId: string,
  typeId: TemplateTypeId,
  raw: unknown
): Promise<Prisma.InputJsonValue | undefined> {
  const m = asRecord(raw);

  switch (typeId) {
    case "text_message":
    case "mixed_interactive":
    case "message_buttons":
      return undefined;

    case "message_image":
    case "message_video":
    case "message_document":
    case "message_audio": {
      const fileId = str(m.fileId, 64);
      const extRaw = m.externalUrl;
      const externalUrl =
        typeof extRaw === "string" && extRaw.trim()
          ? requireHttpsUrl(extRaw)
          : undefined;
      if (!fileId && !externalUrl) {
        throw new AppError(
          400,
          "Upload a file or paste a public https URL for this media template",
          "VALIDATION"
        );
      }
      const out: Record<string, unknown> = {};
      if (fileId) {
        const meta = await verifyFile(workspaceId, fileId);
        out.fileId = fileId;
        out.mimeType = meta.mimeType;
        out.originalName = meta.originalName;
      }
      if (externalUrl) out.externalUrl = externalUrl;
      return out as Prisma.InputJsonValue;
    }

    case "message_location": {
      const lat = Number(m.latitude);
      const lng = Number(m.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new AppError(
          400,
          "Location template needs numeric latitude and longitude",
          "VALIDATION"
        );
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new AppError(400, "Latitude or longitude out of range", "VALIDATION");
      }
      return {
        latitude: lat,
        longitude: lng,
        locationName: str(m.locationName, 200),
        address: str(m.address, 500),
      } as Prisma.InputJsonValue;
    }

    case "message_contact": {
      const contactName = str(m.contactName, 200);
      const contactPhone = str(m.contactPhone, 32);
      if (!contactName || !contactPhone) {
        throw new AppError(
          400,
          "Contact template needs a display name and phone number",
          "VALIDATION"
        );
      }
      return {
        contactName,
        contactPhone,
        contactOrg: str(m.contactOrg, 200),
      } as Prisma.InputJsonValue;
    }

    case "message_poll": {
      const pollQuestion = str(m.pollQuestion, 300);
      const optsRaw = m.pollOptions;
      if (!pollQuestion) {
        throw new AppError(400, "Poll needs a question", "VALIDATION");
      }
      if (!Array.isArray(optsRaw) || optsRaw.length < 2) {
        throw new AppError(
          400,
          "Poll needs at least two options",
          "VALIDATION"
        );
      }
      const pollOptions = optsRaw
        .slice(0, 12)
        .map((o) => String(o).trim().slice(0, 200))
        .filter(Boolean);
      if (pollOptions.length < 2) {
        throw new AppError(400, "Poll options cannot be empty", "VALIDATION");
      }
      return { pollQuestion, pollOptions } as Prisma.InputJsonValue;
    }

    case "message_list": {
      const listSections = parseListSections(m.listSections);
      return { listSections } as Prisma.InputJsonValue;
    }

    case "message_carousel": {
      const carouselCards = parseCarouselCards(m.carouselCards);
      return { carouselCards } as Prisma.InputJsonValue;
    }

    case "cta_button": {
      const ctaUrlRaw = str(m.ctaUrl, 2048);
      if (!ctaUrlRaw) {
        throw new AppError(400, "CTA template needs a destination URL", "VALIDATION");
      }
      const ctaUrl = requireHttpsUrl(ctaUrlRaw);
      const ctaButtonLabel =
        str(m.ctaButtonLabel, 100) ?? str(m.ctaLabel, 100);
      if (!ctaButtonLabel) {
        throw new AppError(400, "CTA template needs a button label", "VALIDATION");
      }
      return { ctaUrl, ctaButtonLabel } as Prisma.InputJsonValue;
    }

    case "copy_code": {
      const copyCodeValue = str(m.copyCodeValue, 200);
      if (!copyCodeValue) {
        throw new AppError(400, "Copy-code template needs the code text", "VALIDATION");
      }
      return { copyCodeValue } as Prisma.InputJsonValue;
    }

    case "flow_message": {
      const flowId = str(m.flowId, 200);
      if (!flowId) {
        throw new AppError(400, "Flow template needs a Flow ID", "VALIDATION");
      }
      return { flowId } as Prisma.InputJsonValue;
    }

    default:
      throw new AppError(500, "Unsupported template type", "INTERNAL");
  }
}

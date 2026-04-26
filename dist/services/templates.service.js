"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireActiveTemplate = requireActiveTemplate;
exports.ensureDefaultTemplates = ensureDefaultTemplates;
exports.listTemplates = listTemplates;
exports.createTemplate = createTemplate;
exports.updateTemplate = updateTemplate;
exports.deleteTemplate = deleteTemplate;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const errors_1 = require("../lib/errors");
const template_types_1 = require("../lib/template-types");
const template_media_normalize_1 = require("../lib/template-media-normalize");
const DEFAULT_TEMPLATES = [
    {
        name: "Welcome — new subscriber",
        waTemplateName: "welcome",
        body: "Hello {{1}}, welcome to our service.",
        category: "utility",
        typeId: "text_message",
    },
    {
        name: "Order confirmation",
        waTemplateName: "order",
        body: "Your order {{1}} is confirmed.",
        category: "transactional",
        typeId: "text_message",
    },
    {
        name: "Appointment reminder",
        waTemplateName: "appointment",
        body: "Reminder: appointment on {{1}}.",
        category: "utility",
        typeId: "text_message",
    },
];
function slugifyWaTemplateName(raw) {
    const s = raw
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return s.length > 0 ? s.slice(0, 200) : "template";
}
async function uniqueWaTemplateName(workspaceId, base) {
    let candidate = base.slice(0, 200);
    let n = 0;
    for (;;) {
        const exists = await prisma_1.prisma.messageTemplate.findFirst({
            where: { workspaceId, waTemplateName: candidate },
            select: { id: true },
        });
        if (!exists)
            return candidate;
        n += 1;
        const suffix = `_${n}`;
        candidate = (base.slice(0, Math.max(1, 200 - suffix.length)) + suffix).slice(0, 200);
    }
}
function parseButtons(value) {
    if (value === null || value === undefined)
        return null;
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const item of value) {
        if (!item || typeof item !== "object")
            continue;
        const o = item;
        const id = typeof o.id === "string" ? o.id : "";
        const kind = o.kind;
        const label = typeof o.label === "string" ? o.label : "";
        if (!id || !label)
            continue;
        if (kind !== "quick_reply" &&
            kind !== "cta_url" &&
            kind !== "cta_phone" &&
            kind !== "copy_code") {
            continue;
        }
        out.push({ id, kind, label });
    }
    return out.length ? out : null;
}
function parseMedia(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value !== "object" || Array.isArray(value))
        return null;
    return value;
}
function toJson(t) {
    const content = t.body;
    return {
        id: t.id,
        name: t.name,
        waTemplateName: t.waTemplateName,
        language: t.language,
        content,
        body: content,
        category: t.category,
        typeId: t.typeId,
        footer: t.footer,
        buttons: parseButtons(t.buttons),
        media: parseMedia(t.media),
        active: t.active,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
    };
}
/** For new sends, campaigns, and automations — template must exist and be active. */
async function requireActiveTemplate(workspaceId, templateId) {
    const tpl = await prisma_1.prisma.messageTemplate.findFirst({
        where: { id: templateId, workspaceId, active: true },
    });
    if (!tpl) {
        throw new errors_1.AppError(404, "Template not found or inactive. Activate it under Templates or pick another.", "NOT_FOUND");
    }
    return tpl;
}
async function ensureDefaultTemplates(workspaceId) {
    const count = await prisma_1.prisma.messageTemplate.count({
        where: { workspaceId },
    });
    if (count > 0)
        return;
    await prisma_1.prisma.messageTemplate.createMany({
        data: DEFAULT_TEMPLATES.map((t) => ({
            workspaceId,
            name: t.name,
            waTemplateName: t.waTemplateName,
            language: "en",
            body: t.body,
            category: t.category,
            typeId: t.typeId,
        })),
    });
}
async function listTemplates(workspaceId) {
    await ensureDefaultTemplates(workspaceId);
    const rows = await prisma_1.prisma.messageTemplate.findMany({
        where: { workspaceId },
        orderBy: { updatedAt: "desc" },
    });
    return rows.map(toJson);
}
async function createTemplate(workspaceId, input) {
    const name = input.name.trim();
    const content = input.content.trim();
    if (!name || !content) {
        throw new errors_1.AppError(400, "Name and message content are required", "VALIDATION");
    }
    if (!(0, template_types_1.isTemplateTypeId)(input.typeId)) {
        throw new errors_1.AppError(400, "Invalid template type", "VALIDATION");
    }
    const typeId = input.typeId;
    const allowedCategories = new Set([
        "general",
        "marketing",
        "transactional",
        "utility",
    ]);
    const category = allowedCategories.has(input.category)
        ? input.category
        : "general";
    const footer = input.footer?.trim() === "" ? null : input.footer?.trim().slice(0, 500) ?? null;
    if (typeId === "message_buttons") {
        const n = input.buttons?.length ?? 0;
        if (n < 1 || n > 3) {
            throw new errors_1.AppError(400, "Button templates need between 1 and 3 buttons", "VALIDATION");
        }
    }
    let buttonsJson;
    if ((typeId === "mixed_interactive" || typeId === "message_buttons") &&
        input.buttons?.length) {
        const capped = input.buttons.map((b) => ({
            id: b.id.slice(0, 64),
            kind: b.kind,
            label: b.label.slice(0, 200),
        }));
        buttonsJson = capped;
    }
    else {
        buttonsJson = undefined;
    }
    const mediaJson = await (0, template_media_normalize_1.normalizeTemplateMedia)(workspaceId, typeId, input.media);
    const slugBase = input.waTemplateName?.trim()
        ? slugifyWaTemplateName(input.waTemplateName)
        : slugifyWaTemplateName(name);
    const waTemplateName = await uniqueWaTemplateName(workspaceId, slugBase);
    try {
        const row = await prisma_1.prisma.messageTemplate.create({
            data: {
                workspaceId,
                name: name.slice(0, 200),
                waTemplateName,
                language: (input.language ?? "en").slice(0, 16),
                body: content.slice(0, 4096),
                category,
                typeId,
                footer,
                ...(buttonsJson !== undefined ? { buttons: buttonsJson } : {}),
                ...(mediaJson !== undefined ? { media: mediaJson } : {}),
            },
        });
        return toJson(row);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("Unique constraint") || msg.includes("unique constraint")) {
            throw new errors_1.AppError(409, "A template with this WhatsApp name already exists", "CONFLICT");
        }
        throw e;
    }
}
async function updateTemplate(workspaceId, templateId, input) {
    const existing = await prisma_1.prisma.messageTemplate.findFirst({
        where: { id: templateId, workspaceId },
    });
    if (!existing) {
        throw new errors_1.AppError(404, "Template not found", "NOT_FOUND");
    }
    const typeId = existing.typeId;
    const hasChange = Object.values(input).some((v) => v !== undefined);
    if (!hasChange) {
        throw new errors_1.AppError(400, "No changes provided", "VALIDATION");
    }
    const allowedCategories = new Set([
        "general",
        "marketing",
        "transactional",
        "utility",
    ]);
    const data = {};
    if (input.name !== undefined) {
        const n = input.name.trim();
        if (!n) {
            throw new errors_1.AppError(400, "Name cannot be empty", "VALIDATION");
        }
        data.name = n.slice(0, 200);
    }
    if (input.category !== undefined) {
        data.category = allowedCategories.has(input.category)
            ? input.category
            : "general";
    }
    if (input.content !== undefined) {
        const c = input.content.trim();
        if (!c) {
            throw new errors_1.AppError(400, "Message content cannot be empty", "VALIDATION");
        }
        data.body = c.slice(0, 4096);
    }
    if (input.footer !== undefined) {
        data.footer =
            input.footer === null || input.footer.trim() === ""
                ? null
                : input.footer.trim().slice(0, 500);
    }
    if (input.language !== undefined) {
        data.language = (input.language ?? existing.language).slice(0, 16);
    }
    if (input.active !== undefined) {
        data.active = input.active;
    }
    if (input.buttons !== undefined) {
        if (typeId === "message_buttons") {
            const n = input.buttons?.length ?? 0;
            if (n < 1 || n > 3) {
                throw new errors_1.AppError(400, "Button templates need between 1 and 3 buttons", "VALIDATION");
            }
        }
        if ((typeId === "mixed_interactive" || typeId === "message_buttons") &&
            input.buttons &&
            input.buttons.length > 0) {
            const capped = input.buttons.map((b) => ({
                id: b.id.slice(0, 64),
                kind: b.kind,
                label: b.label.slice(0, 200),
            }));
            data.buttons = capped;
        }
        else if (typeId === "mixed_interactive" ||
            typeId === "message_buttons") {
            data.buttons = client_1.Prisma.DbNull;
        }
    }
    if (input.media !== undefined) {
        const mediaJson = await (0, template_media_normalize_1.normalizeTemplateMedia)(workspaceId, typeId, input.media);
        if (mediaJson !== undefined) {
            data.media = mediaJson;
        }
    }
    const row = await prisma_1.prisma.messageTemplate.update({
        where: { id: templateId },
        data,
    });
    return toJson(row);
}
async function deleteTemplate(workspaceId, templateId) {
    const existing = await prisma_1.prisma.messageTemplate.findFirst({
        where: { id: templateId, workspaceId },
        select: { id: true },
    });
    if (!existing) {
        throw new errors_1.AppError(404, "Template not found", "NOT_FOUND");
    }
    await prisma_1.prisma.messageTemplate.delete({ where: { id: templateId } });
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAutoReplyRules = listAutoReplyRules;
exports.createAutoReplyRule = createAutoReplyRule;
exports.updateAutoReplyRule = updateAutoReplyRule;
exports.deleteAutoReplyRule = deleteAutoReplyRule;
const client_1 = require("@prisma/client");
const auto_reply_keywords_1 = require("../lib/auto-reply-keywords");
const prisma_1 = require("../lib/prisma");
const errors_1 = require("../lib/errors");
const templates_service_1 = require("./templates.service");
function deviceLabel(d) {
    return d.phone ? `${d.name} · ${d.phone}` : d.name;
}
function toPrismaTriggerType(api) {
    switch (api) {
        case "exact":
            return client_1.AutoReplyTriggerType.EXACT;
        case "contains":
            return client_1.AutoReplyTriggerType.CONTAINS;
        case "starts_with":
            return client_1.AutoReplyTriggerType.STARTS_WITH;
        case "ends_with":
            return client_1.AutoReplyTriggerType.ENDS_WITH;
        case "regex":
            return client_1.AutoReplyTriggerType.REGEX;
        case "keyword":
        default:
            return client_1.AutoReplyTriggerType.KEYWORD;
    }
}
function fromPrismaTriggerType(t) {
    switch (t) {
        case client_1.AutoReplyTriggerType.EXACT:
            return "exact";
        case client_1.AutoReplyTriggerType.CONTAINS:
            return "contains";
        case client_1.AutoReplyTriggerType.STARTS_WITH:
            return "starts_with";
        case client_1.AutoReplyTriggerType.ENDS_WITH:
            return "ends_with";
        case client_1.AutoReplyTriggerType.REGEX:
            return "regex";
        case client_1.AutoReplyTriggerType.KEYWORD:
        default:
            return "keyword";
    }
}
function fromPrismaMessageMode(m) {
    switch (m) {
        case client_1.AutoReplyMessageMode.TEMPLATE:
            return "template";
        case client_1.AutoReplyMessageMode.MEDIA:
            return "media";
        case client_1.AutoReplyMessageMode.TEXT:
        default:
            return "text";
    }
}
function toPrismaMessageMode(api) {
    switch (api) {
        case "template":
            return client_1.AutoReplyMessageMode.TEMPLATE;
        case "media":
            return client_1.AutoReplyMessageMode.MEDIA;
        case "text":
        default:
            return client_1.AutoReplyMessageMode.TEXT;
    }
}
function validateTriggers(triggerType, caseSensitive, raw) {
    const trimmed = raw.trim();
    if (triggerType === "regex") {
        const patterns = (0, auto_reply_keywords_1.parseRegexPatterns)(trimmed);
        if (patterns.length === 0) {
            throw new errors_1.AppError(400, "Enter at least one regex pattern (one per line).", "VALIDATION");
        }
        for (const p of patterns) {
            try {
                void new RegExp(p);
            }
            catch {
                throw new errors_1.AppError(400, `Invalid regex: ${p.slice(0, 80)}`, "VALIDATION");
            }
        }
        return;
    }
    const tokens = caseSensitive
        ? (0, auto_reply_keywords_1.parseTriggerTokens)(trimmed)
        : (0, auto_reply_keywords_1.parseAutoReplyKeywords)(trimmed);
    if (tokens.length === 0) {
        throw new errors_1.AppError(400, "Enter at least one trigger (use commas or new lines between values).", "VALIDATION");
    }
}
function assertContentRules(input) {
    const hasText = input.response.trim().length > 0;
    if (input.openAiEnabled) {
        return;
    }
    if (input.messageMode === "template" && !input.templateId) {
        throw new errors_1.AppError(400, "Template is required for template message mode", "VALIDATION");
    }
    if (input.messageMode === "media" && !input.mediaAssetId) {
        throw new errors_1.AppError(400, "Media file is required for media message mode", "VALIDATION");
    }
    if (input.messageMode === "text" && !hasText) {
        throw new errors_1.AppError(400, "Reply text is required for text mode", "VALIDATION");
    }
    if (input.messageMode === "template" && !input.templateId && !hasText) {
        throw new errors_1.AppError(400, "Select a template or enable OpenAI / add fallback text", "VALIDATION");
    }
}
function toJson(row) {
    return {
        id: row.id,
        name: row.name,
        keyword: row.keyword,
        triggerType: fromPrismaTriggerType(row.triggerType),
        caseSensitive: row.caseSensitive,
        deviceId: row.deviceId,
        deviceLabel: deviceLabel(row.device),
        priority: row.priority,
        cooldownMinutes: row.cooldownMinutes,
        messageMode: fromPrismaMessageMode(row.messageMode),
        templateId: row.templateId,
        templateName: row.template?.name ?? null,
        mediaAssetId: row.mediaAssetId,
        mediaCaption: row.mediaCaption,
        response: row.response,
        openAiEnabled: row.openAiEnabled,
        openAiSettings: row.openAiSettings,
        active: row.active,
        responseCount: row.responseCount,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
const include = {
    device: { select: { name: true, phone: true } },
    template: { select: { name: true } },
};
async function listAutoReplyRules(workspaceId) {
    const rows = await prisma_1.prisma.autoReplyRule.findMany({
        where: { workspaceId },
        include,
        orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });
    return rows.map(toJson);
}
async function createAutoReplyRule(workspaceId, input) {
    const device = await prisma_1.prisma.device.findFirst({
        where: { id: input.deviceId, workspaceId },
    });
    if (!device) {
        throw new errors_1.AppError(404, "Device not found", "NOT_FOUND");
    }
    let templateId = null;
    if (input.templateId?.trim()) {
        const tpl = await (0, templates_service_1.requireActiveTemplate)(workspaceId, input.templateId.trim());
        templateId = tpl.id;
    }
    let mediaAssetId = null;
    if (input.mediaAssetId?.trim()) {
        const asset = await prisma_1.prisma.templateMediaAsset.findFirst({
            where: { id: input.mediaAssetId.trim(), workspaceId },
        });
        if (!asset) {
            throw new errors_1.AppError(404, "Media file not found", "NOT_FOUND");
        }
        mediaAssetId = asset.id;
    }
    const name = input.name.trim();
    const keyword = input.keyword.trim();
    const response = input.response.trim();
    const mediaCaption = input.mediaCaption?.trim() === "" ? null : input.mediaCaption?.trim().slice(0, 4096) ?? null;
    if (!name) {
        throw new errors_1.AppError(400, "Rule name is required", "VALIDATION");
    }
    validateTriggers(input.triggerType, input.caseSensitive, keyword);
    assertContentRules({
        messageMode: input.messageMode,
        templateId,
        mediaAssetId,
        response,
        openAiEnabled: input.openAiEnabled,
    });
    if (input.openAiEnabled) {
        const raw = input.openAiSettings;
        const key = raw && typeof raw === "object" && !Array.isArray(raw)
            ? raw.apiKey
            : undefined;
        if (typeof key !== "string" || !key.trim()) {
            throw new errors_1.AppError(400, "OpenAI settings with apiKey are required when AI is enabled", "VALIDATION");
        }
    }
    const row = await prisma_1.prisma.autoReplyRule.create({
        data: {
            workspaceId,
            deviceId: input.deviceId,
            name: name.slice(0, 200),
            keyword: keyword.slice(0, 8000),
            triggerType: toPrismaTriggerType(input.triggerType),
            caseSensitive: input.caseSensitive,
            priority: Math.min(1_000_000, Math.max(0, input.priority)),
            cooldownMinutes: Math.min(10_080, Math.max(0, input.cooldownMinutes)),
            messageMode: toPrismaMessageMode(input.messageMode),
            templateId,
            mediaAssetId,
            mediaCaption,
            response: response.slice(0, 4096),
            openAiEnabled: input.openAiEnabled,
            openAiSettings: input.openAiSettings === undefined
                ? undefined
                : input.openAiSettings,
            active: input.active,
        },
        include,
    });
    return toJson(row);
}
async function updateAutoReplyRule(workspaceId, ruleId, input) {
    const existing = await prisma_1.prisma.autoReplyRule.findFirst({
        where: { id: ruleId, workspaceId },
    });
    if (!existing) {
        throw new errors_1.AppError(404, "Rule not found", "NOT_FOUND");
    }
    let deviceId = existing.deviceId;
    if (input.deviceId !== undefined) {
        const device = await prisma_1.prisma.device.findFirst({
            where: { id: input.deviceId, workspaceId },
        });
        if (!device) {
            throw new errors_1.AppError(404, "Device not found", "NOT_FOUND");
        }
        deviceId = input.deviceId;
    }
    let templateId = undefined;
    if (input.templateId !== undefined) {
        if (input.templateId === null || input.templateId === "") {
            templateId = null;
        }
        else {
            const tpl = await (0, templates_service_1.requireActiveTemplate)(workspaceId, input.templateId.trim());
            templateId = tpl.id;
        }
    }
    let mediaAssetId = undefined;
    if (input.mediaAssetId !== undefined) {
        if (input.mediaAssetId === null || input.mediaAssetId === "") {
            mediaAssetId = null;
        }
        else {
            const asset = await prisma_1.prisma.templateMediaAsset.findFirst({
                where: { id: input.mediaAssetId.trim(), workspaceId },
            });
            if (!asset) {
                throw new errors_1.AppError(404, "Media file not found", "NOT_FOUND");
            }
            mediaAssetId = asset.id;
        }
    }
    const data = {
        device: { connect: { id: deviceId } },
    };
    if (input.name !== undefined) {
        const t = input.name.trim();
        if (!t)
            throw new errors_1.AppError(400, "Rule name is required", "VALIDATION");
        data.name = t.slice(0, 200);
    }
    if (input.keyword !== undefined) {
        const t = input.keyword.trim();
        const tt = input.triggerType ?? fromPrismaTriggerType(existing.triggerType);
        const cs = input.caseSensitive ?? existing.caseSensitive;
        validateTriggers(tt, cs, t);
        data.keyword = t.slice(0, 8000);
    }
    if (input.triggerType !== undefined) {
        data.triggerType = toPrismaTriggerType(input.triggerType);
    }
    if (input.caseSensitive !== undefined) {
        data.caseSensitive = input.caseSensitive;
    }
    if (input.priority !== undefined) {
        data.priority = Math.min(1_000_000, Math.max(0, input.priority));
    }
    if (input.cooldownMinutes !== undefined) {
        data.cooldownMinutes = Math.min(10_080, Math.max(0, input.cooldownMinutes));
    }
    if (input.messageMode !== undefined) {
        data.messageMode = toPrismaMessageMode(input.messageMode);
    }
    if (templateId !== undefined) {
        data.template =
            templateId === null
                ? { disconnect: true }
                : { connect: { id: templateId } };
    }
    if (mediaAssetId !== undefined) {
        data.mediaAsset =
            mediaAssetId === null
                ? { disconnect: true }
                : { connect: { id: mediaAssetId } };
    }
    if (input.mediaCaption !== undefined) {
        data.mediaCaption =
            input.mediaCaption === null || input.mediaCaption.trim() === ""
                ? null
                : input.mediaCaption.trim().slice(0, 4096);
    }
    if (input.response !== undefined) {
        data.response = input.response.trim().slice(0, 4096);
    }
    if (input.openAiEnabled !== undefined) {
        data.openAiEnabled = input.openAiEnabled;
    }
    if (input.openAiSettings !== undefined) {
        data.openAiSettings =
            input.openAiSettings === null
                ? client_1.Prisma.JsonNull
                : input.openAiSettings;
    }
    if (input.active !== undefined) {
        data.active = input.active;
    }
    const merged = {
        messageMode: fromPrismaMessageMode(input.messageMode !== undefined
            ? toPrismaMessageMode(input.messageMode)
            : existing.messageMode),
        templateId: templateId !== undefined ? templateId : existing.templateId,
        mediaAssetId: mediaAssetId !== undefined ? mediaAssetId : existing.mediaAssetId,
        response: input.response !== undefined
            ? input.response.trim()
            : existing.response,
        openAiEnabled: input.openAiEnabled !== undefined
            ? input.openAiEnabled
            : existing.openAiEnabled,
    };
    assertContentRules({
        messageMode: merged.messageMode,
        templateId: merged.templateId,
        mediaAssetId: merged.mediaAssetId,
        response: merged.response,
        openAiEnabled: merged.openAiEnabled,
    });
    if (merged.openAiEnabled) {
        const settings = input.openAiSettings !== undefined
            ? input.openAiSettings
            : existing.openAiSettings;
        if (settings === null ||
            (typeof settings === "object" &&
                settings !== null &&
                (typeof settings.apiKey !== "string" ||
                    !settings.apiKey.trim()))) {
            throw new errors_1.AppError(400, "OpenAI settings with apiKey are required when AI is enabled", "VALIDATION");
        }
    }
    const row = await prisma_1.prisma.autoReplyRule.update({
        where: { id: ruleId },
        data,
        include,
    });
    return toJson(row);
}
async function deleteAutoReplyRule(workspaceId, ruleId) {
    const existing = await prisma_1.prisma.autoReplyRule.findFirst({
        where: { id: ruleId, workspaceId },
        select: { id: true },
    });
    if (!existing) {
        throw new errors_1.AppError(404, "Rule not found", "NOT_FOUND");
    }
    await prisma_1.prisma.autoReplyRule.delete({ where: { id: ruleId } });
}

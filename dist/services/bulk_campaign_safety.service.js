"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTimeToMinute = parseTimeToMinute;
exports.isWithinActiveHours = isWithinActiveHours;
exports.isWithinInactiveHours = isWithinInactiveHours;
exports.canSendAt = canSendAt;
exports.applySpintax = applySpintax;
exports.applyUniqueness = applyUniqueness;
exports.applyWorkspaceUniquenessWindow = applyWorkspaceUniquenessWindow;
exports.fetchInboundLastMap = fetchInboundLastMap;
exports.filterByReplyRules = filterByReplyRules;
exports.filterVerifiedFromContacts = filterVerifiedFromContacts;
exports.sleepMs = sleepMs;
exports.randomDelayMs = randomDelayMs;
exports.shouldStopByFailLimit = shouldStopByFailLimit;
exports.normalizeAntiBlock = normalizeAntiBlock;
exports.antiBlockApiFromRow = antiBlockApiFromRow;
exports.applyPhoneFilters = applyPhoneFilters;
exports.toJsonValue = toJsonValue;
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
function parseTimeToMinute(input) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input.trim());
    if (!m)
        return null;
    return Number(m[1]) * 60 + Number(m[2]);
}
function isWithinActiveHours(now, start, end) {
    if (!start || !end)
        return true;
    const s = parseTimeToMinute(start);
    const e = parseTimeToMinute(end);
    if (s === null || e === null)
        return true;
    const cur = now.getHours() * 60 + now.getMinutes();
    if (s === e)
        return true;
    if (s < e)
        return cur >= s && cur <= e;
    return cur >= s || cur <= e;
}
function isWithinInactiveHours(now, start, end) {
    if (!start || !end)
        return false;
    return isWithinActiveHours(now, start, end);
}
function canSendAt(now, settings) {
    const inActive = isWithinActiveHours(now, settings.activeHoursStart, settings.activeHoursEnd);
    if (!inActive)
        return false;
    return !isWithinInactiveHours(now, settings.inactiveHoursStart, settings.inactiveHoursEnd);
}
function applySpintax(input) {
    const maxRounds = 10;
    let out = input;
    for (let i = 0; i < maxRounds; i++) {
        const next = out.replace(/\{([^{}]+)\}/g, (_all, inner) => {
            const options = inner
                .split("|")
                .map((x) => x.trim())
                .filter(Boolean);
            if (options.length === 0)
                return "";
            const idx = Math.floor(Math.random() * options.length);
            return options[idx] ?? "";
        });
        if (next === out)
            break;
        out = next;
    }
    return out;
}
function applyUniqueness(phones, mode) {
    if (mode === client_1.BulkUniquenessMode.NONE)
        return phones;
    return [...new Set(phones)];
}
async function applyWorkspaceUniquenessWindow(workspaceId, phones, windowHours = 24) {
    if (phones.length === 0)
        return [];
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const sentRows = await prisma_1.prisma.outboundMessage.findMany({
        where: {
            workspaceId,
            toPhone: { in: phones },
            createdAt: { gte: since },
        },
        select: { toPhone: true },
    });
    const sentSet = new Set(sentRows.map((r) => r.toPhone));
    return phones.filter((p) => !sentSet.has(p));
}
async function fetchInboundLastMap(workspaceId, phones) {
    if (phones.length === 0)
        return new Map();
    const rows = await prisma_1.prisma.liveChatThread.findMany({
        where: { workspaceId, peerPhone: { in: phones } },
        select: { peerPhone: true, lastMessageAt: true },
    });
    const byPhone = new Map();
    for (const row of rows) {
        if (!row.lastMessageAt)
            continue;
        const prev = byPhone.get(row.peerPhone);
        if (!prev || row.lastMessageAt > prev)
            byPhone.set(row.peerPhone, row.lastMessageAt);
    }
    return byPhone;
}
async function filterByReplyRules(workspaceId, phones, opts) {
    if (!opts.repliedOnly && !opts.recent24hOnly)
        return phones;
    const lastMap = await fetchInboundLastMap(workspaceId, phones);
    const since24h = Date.now() - 24 * 60 * 60 * 1000;
    return phones.filter((p) => {
        const d = lastMap.get(p);
        if (!d)
            return false;
        if (opts.recent24hOnly && d.getTime() < since24h)
            return false;
        return true;
    });
}
async function filterVerifiedFromContacts(workspaceId, phones) {
    if (phones.length === 0)
        return [];
    const rows = await prisma_1.prisma.contact.findMany({
        where: {
            phone: { in: phones },
            status: "VERIFIED",
            group: { workspaceId },
        },
        select: { phone: true },
    });
    const ok = new Set(rows.map((r) => r.phone));
    return phones.filter((p) => ok.has(p));
}
async function sleepMs(ms) {
    await new Promise((r) => setTimeout(r, ms));
}
function randomDelayMs(minSec, maxSec) {
    const lo = Math.min(minSec, maxSec);
    const hi = Math.max(minSec, maxSec);
    const spread = hi - lo;
    const sec = lo + (spread > 0 ? Math.floor(Math.random() * (spread + 1)) : 0);
    return sec * 1000;
}
function shouldStopByFailLimit(consecutiveFailures, settings) {
    return settings.enabled && consecutiveFailures >= settings.failLimitInRow;
}
function normalizeAntiBlock(antiBlock) {
    const uniquenessMode = antiBlock?.uniquenessMode === "campaign"
        ? client_1.BulkUniquenessMode.CAMPAIGN
        : antiBlock?.uniquenessMode === "workspace_window"
            ? client_1.BulkUniquenessMode.WORKSPACE_WINDOW
            : client_1.BulkUniquenessMode.NONE;
    return {
        enabled: antiBlock?.enabled === true,
        spintaxEnabled: antiBlock?.spintax === true,
        verifyNumbers: antiBlock?.verifyNumbers === true,
        repliedOnly: antiBlock?.repliedOnly === true,
        recent24hOnly: antiBlock?.recent24hOnly === true,
        uniquenessMode,
        batchPauseEvery: Math.max(1, Math.floor(antiBlock?.batchPauseEvery ?? 30)),
        batchPauseSec: Math.max(1, Math.floor(antiBlock?.batchPauseSec ?? 30)),
        failLimitInRow: Math.max(1, Math.floor(antiBlock?.failLimitInRow ?? 5)),
        activeHoursStart: antiBlock?.activeHoursStart?.trim() || null,
        activeHoursEnd: antiBlock?.activeHoursEnd?.trim() || null,
        inactiveHoursStart: antiBlock?.inactiveHoursStart?.trim() || null,
        inactiveHoursEnd: antiBlock?.inactiveHoursEnd?.trim() || null,
    };
}
function antiBlockApiFromRow(row) {
    return {
        enabled: row.antiBlockEnabled,
        spintax: row.spintaxEnabled,
        verifyNumbers: row.verifyNumbers,
        repliedOnly: row.repliedOnly,
        recent24hOnly: row.recent24hOnly,
        uniquenessMode: row.uniquenessMode === client_1.BulkUniquenessMode.CAMPAIGN
            ? "campaign"
            : row.uniquenessMode === client_1.BulkUniquenessMode.WORKSPACE_WINDOW
                ? "workspace_window"
                : "none",
        batchPauseEvery: row.batchPauseEvery,
        batchPauseSec: row.batchPauseSec,
        failLimitInRow: row.failLimitInRow,
        activeHoursStart: row.activeHoursStart,
        activeHoursEnd: row.activeHoursEnd,
        inactiveHoursStart: row.inactiveHoursStart,
        inactiveHoursEnd: row.inactiveHoursEnd,
    };
}
async function applyPhoneFilters(workspaceId, phones, settings) {
    let out = phones;
    if (!settings.enabled)
        return out;
    if (settings.uniquenessMode === client_1.BulkUniquenessMode.CAMPAIGN) {
        out = applyUniqueness(out, settings.uniquenessMode);
    }
    if (settings.uniquenessMode === client_1.BulkUniquenessMode.WORKSPACE_WINDOW) {
        out = await applyWorkspaceUniquenessWindow(workspaceId, out);
    }
    if (settings.verifyNumbers) {
        out = await filterVerifiedFromContacts(workspaceId, out);
    }
    if (settings.repliedOnly || settings.recent24hOnly) {
        out = await filterByReplyRules(workspaceId, out, {
            repliedOnly: settings.repliedOnly,
            recent24hOnly: settings.recent24hOnly,
        });
    }
    return out;
}
function toJsonValue(input) {
    return input;
}

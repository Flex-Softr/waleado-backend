"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listGroups = listGroups;
exports.getGroupDetail = getGroupDetail;
exports.createGroup = createGroup;
exports.updateGroup = updateGroup;
exports.deleteGroup = deleteGroup;
exports.createContact = createContact;
exports.bulkCreateContacts = bulkCreateContacts;
exports.importMembersFromGrabber = importMembersFromGrabber;
exports.removeInvalidContactsInGroup = removeInvalidContactsInGroup;
exports.revalidateAllContactsInWorkspace = revalidateAllContactsInWorkspace;
exports.revalidateContactsInGroup = revalidateContactsInGroup;
exports.updateContact = updateContact;
exports.deleteContact = deleteContact;
const client_1 = require("@prisma/client");
const env_1 = require("../env");
const prisma_1 = require("../lib/prisma");
const errors_1 = require("../lib/errors");
const phone_1 = require("../lib/phone");
const wa_phone_presence_service_1 = require("./wa-phone-presence.service");
function statusToApi(s) {
    switch (s) {
        case client_1.ContactStatus.VERIFIED:
            return "verified";
        case client_1.ContactStatus.INVALID:
            return "invalid";
        default:
            return "unverified";
    }
}
function apiToStatus(s) {
    switch (s) {
        case "verified":
            return client_1.ContactStatus.VERIFIED;
        case "invalid":
            return client_1.ContactStatus.INVALID;
        default:
            return client_1.ContactStatus.UNVERIFIED;
    }
}
function contactToRow(c) {
    return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        status: statusToApi(c.status),
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
    };
}
async function assertGroupInWorkspace(workspaceId, groupId) {
    const g = await prisma_1.prisma.contactGroup.findFirst({
        where: { id: groupId, workspaceId },
    });
    if (!g) {
        throw new errors_1.AppError(404, "Group not found", "NOT_FOUND");
    }
    return g;
}
async function buildStatsMap(workspaceId) {
    const rows = await prisma_1.prisma.contact.groupBy({
        by: ["groupId", "status"],
        where: { group: { workspaceId } },
        _count: { _all: true },
    });
    const map = new Map();
    function ensure(gid) {
        let s = map.get(gid);
        if (!s) {
            s = { total: 0, verified: 0, unverified: 0, invalid: 0 };
            map.set(gid, s);
        }
        return s;
    }
    for (const r of rows) {
        const s = ensure(r.groupId);
        const n = r._count._all;
        s.total += n;
        if (r.status === client_1.ContactStatus.VERIFIED)
            s.verified += n;
        else if (r.status === client_1.ContactStatus.INVALID)
            s.invalid += n;
        else
            s.unverified += n;
    }
    return map;
}
async function listGroups(workspaceId) {
    const [groups, statsMap] = await Promise.all([
        prisma_1.prisma.contactGroup.findMany({
            where: { workspaceId },
            orderBy: { updatedAt: "desc" },
        }),
        buildStatsMap(workspaceId),
    ]);
    return groups.map((g) => ({
        id: g.id,
        name: g.name,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        stats: statsMap.get(g.id) ?? {
            total: 0,
            verified: 0,
            unverified: 0,
            invalid: 0,
        },
    }));
}
async function getGroupDetail(workspaceId, groupId) {
    const g = await assertGroupInWorkspace(workspaceId, groupId);
    const statsMap = await buildStatsMap(workspaceId);
    const contacts = await prisma_1.prisma.contact.findMany({
        where: { groupId },
        orderBy: { createdAt: "desc" },
    });
    return {
        group: {
            id: g.id,
            name: g.name,
            createdAt: g.createdAt.toISOString(),
            updatedAt: g.updatedAt.toISOString(),
            stats: statsMap.get(g.id) ?? {
                total: 0,
                verified: 0,
                unverified: 0,
                invalid: 0,
            },
        },
        contacts: contacts.map(contactToRow),
    };
}
async function createGroup(workspaceId, name) {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new errors_1.AppError(400, "Group name is required", "VALIDATION");
    }
    const g = await prisma_1.prisma.contactGroup.create({
        data: {
            workspaceId,
            name: trimmed.slice(0, 200),
        },
    });
    return {
        id: g.id,
        name: g.name,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        stats: { total: 0, verified: 0, unverified: 0, invalid: 0 },
    };
}
async function updateGroup(workspaceId, groupId, name) {
    await assertGroupInWorkspace(workspaceId, groupId);
    const trimmed = name.trim();
    if (!trimmed) {
        throw new errors_1.AppError(400, "Group name is required", "VALIDATION");
    }
    const g = await prisma_1.prisma.contactGroup.update({
        where: { id: groupId },
        data: { name: trimmed.slice(0, 200) },
    });
    const statsMap = await buildStatsMap(workspaceId);
    return {
        id: g.id,
        name: g.name,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        stats: statsMap.get(g.id) ?? {
            total: 0,
            verified: 0,
            unverified: 0,
            invalid: 0,
        },
    };
}
async function deleteGroup(workspaceId, groupId) {
    await assertGroupInWorkspace(workspaceId, groupId);
    await prisma_1.prisma.contactGroup.delete({ where: { id: groupId } });
}
async function createContact(workspaceId, groupId, input) {
    await assertGroupInWorkspace(workspaceId, groupId);
    const name = input.name.trim() || "Contact";
    const v = (0, phone_1.validateAndFormatPhone)(input.phone);
    if (!v.valid) {
        throw new errors_1.AppError(400, v.message, "INVALID_PHONE");
    }
    try {
        const c = await prisma_1.prisma.contact.create({
            data: {
                groupId,
                name: name.slice(0, 200),
                phone: v.e164,
                status: client_1.ContactStatus.UNVERIFIED,
            },
        });
        return contactToRow(c);
    }
    catch (e) {
        if (e instanceof client_1.Prisma.PrismaClientKnownRequestError &&
            e.code === "P2002") {
            throw new errors_1.AppError(409, "This phone number is already in the group", "DUPLICATE_PHONE");
        }
        throw e;
    }
}
/** Prisma/Postgres parameter budget: keep chunks moderate. */
const BULK_INSERT_CHUNK = 300;
function parseBulkLine(line) {
    const t = line.trim();
    if (!t)
        return { name: "Contact", phoneRaw: "" };
    const parts = t.split(/\t/);
    if (parts.length >= 2) {
        return {
            name: parts[0].trim() || "Contact",
            phoneRaw: parts[parts.length - 1].trim(),
        };
    }
    const sepPriority = [";", "\uFF1B", ",", "،", "\uFF0C"];
    let bestIdx = -1;
    let bestLen = 1;
    for (const sep of sepPriority) {
        const idx = t.indexOf(sep);
        if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
            bestIdx = idx;
            bestLen = sep.length;
        }
    }
    if (bestIdx !== -1) {
        return {
            name: t.slice(0, bestIdx).trim() || "Contact",
            phoneRaw: t.slice(bestIdx + bestLen).trim(),
        };
    }
    return { name: "Contact", phoneRaw: t };
}
async function bulkCreateContacts(workspaceId, groupId, lines, options) {
    await assertGroupInWorkspace(workspaceId, groupId);
    const phoneMode = options?.phoneMode ?? "strict";
    const validatePhone = phoneMode === "grabber"
        ? phone_1.validatePhoneForGrabberImport
        : phone_1.validateAndFormatPhone;
    const skipped = [];
    const validated = [];
    const seenInBatch = new Set();
    for (const line of lines) {
        const { name, phoneRaw } = parseBulkLine(line);
        if (!phoneRaw) {
            const hint = line.trim();
            if (hint.length > 0) {
                skipped.push({
                    phone: hint.length > 96 ? `${hint.slice(0, 96)}…` : hint,
                    reason: "Empty phone — wrong column or separator (use tab, comma, or semicolon between name and phone)",
                });
            }
            continue;
        }
        const v = validatePhone(phoneRaw);
        if (!v.valid) {
            skipped.push({ phone: phoneRaw, reason: v.message });
            continue;
        }
        if (seenInBatch.has(v.e164)) {
            skipped.push({ phone: phoneRaw, reason: "Duplicate in paste" });
            continue;
        }
        seenInBatch.add(v.e164);
        validated.push({
            name: name.slice(0, 200),
            e164: v.e164,
            phoneRaw,
        });
    }
    if (validated.length === 0) {
        return { created: [], skipped };
    }
    const dbSkipped = [];
    const created = await prisma_1.prisma.$transaction(async (tx) => {
        const phones = [...new Set(validated.map((r) => r.e164))];
        const existing = await tx.contact.findMany({
            where: { groupId, phone: { in: phones } },
            select: { phone: true },
        });
        const existingSet = new Set(existing.map((r) => r.phone));
        const rowsToInsert = [];
        for (const r of validated) {
            if (existingSet.has(r.e164)) {
                dbSkipped.push({
                    phone: r.phoneRaw,
                    reason: "Already in this group",
                });
                continue;
            }
            rowsToInsert.push({
                groupId,
                name: r.name,
                phone: r.e164,
                status: client_1.ContactStatus.UNVERIFIED,
            });
        }
        const out = [];
        for (let i = 0; i < rowsToInsert.length; i += BULK_INSERT_CHUNK) {
            const chunk = rowsToInsert.slice(i, i + BULK_INSERT_CHUNK);
            if (chunk.length === 0)
                continue;
            const inserted = await tx.contact.createManyAndReturn({
                data: chunk,
            });
            for (const c of inserted) {
                out.push(contactToRow(c));
            }
        }
        return out;
    }, {
        maxWait: 10_000,
        timeout: 60_000,
    });
    return { created, skipped: [...skipped, ...dbSkipped] };
}
async function importMembersFromGrabber(workspaceId, groupId, members) {
    const lines = members
        .map((m) => {
        const phone = m.phone.trim();
        if (!phone)
            return null;
        const name = (m.name || "Contact").trim() || "Contact";
        return `${name}\t${phone}`;
    })
        .filter((x) => x !== null);
    return bulkCreateContacts(workspaceId, groupId, lines, {
        phoneMode: "grabber",
    });
}
async function removeInvalidContactsInGroup(workspaceId, groupId) {
    await assertGroupInWorkspace(workspaceId, groupId);
    const res = await prisma_1.prisma.contact.deleteMany({
        where: { groupId, status: client_1.ContactStatus.INVALID },
    });
    return { removed: res.count };
}
async function revalidateContactRows(workspaceId, rows) {
    let updated = 0;
    const valid = [];
    for (const c of rows) {
        const strict = (0, phone_1.validateAndFormatPhone)(c.phone);
        const v = strict.valid
            ? strict
            : (0, phone_1.validatePhoneForGrabberImport)(c.phone);
        if (!v.valid) {
            if (c.status !== client_1.ContactStatus.INVALID) {
                await prisma_1.prisma.contact.update({
                    where: { id: c.id },
                    data: { status: client_1.ContactStatus.INVALID },
                });
                updated += 1;
            }
            continue;
        }
        valid.push({
            id: c.id,
            e164: v.e164,
            prevPhone: c.phone,
            prevStatus: c.status,
        });
    }
    let whatsappChecked = false;
    let waByE164 = null;
    if (valid.length > 0 && env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        const unique = [...new Set(valid.map((x) => x.e164))];
        waByE164 = await (0, wa_phone_presence_service_1.checkE164RegisteredOnWhatsApp)(workspaceId, unique);
        whatsappChecked = waByE164 !== null;
    }
    for (const c of valid) {
        let nextStatus;
        if (waByE164 !== null) {
            nextStatus = waByE164.get(c.e164)
                ? client_1.ContactStatus.VERIFIED
                : client_1.ContactStatus.UNVERIFIED;
        }
        else {
            nextStatus =
                c.prevStatus === client_1.ContactStatus.INVALID
                    ? client_1.ContactStatus.UNVERIFIED
                    : c.prevStatus;
        }
        if (c.prevPhone !== c.e164 || c.prevStatus !== nextStatus) {
            await prisma_1.prisma.contact.update({
                where: { id: c.id },
                data: { phone: c.e164, status: nextStatus },
            });
            updated += 1;
        }
    }
    return { updated, whatsappChecked };
}
async function revalidateAllContactsInWorkspace(workspaceId) {
    const contacts = await prisma_1.prisma.contact.findMany({
        where: { group: { workspaceId } },
        select: { id: true, phone: true, status: true },
    });
    return revalidateContactRows(workspaceId, contacts);
}
async function revalidateContactsInGroup(workspaceId, groupId) {
    await assertGroupInWorkspace(workspaceId, groupId);
    const contacts = await prisma_1.prisma.contact.findMany({
        where: { groupId },
        select: { id: true, phone: true, status: true },
    });
    return revalidateContactRows(workspaceId, contacts);
}
async function updateContact(workspaceId, contactId, input) {
    const c = await prisma_1.prisma.contact.findFirst({
        where: {
            id: contactId,
            group: { workspaceId },
        },
    });
    if (!c) {
        throw new errors_1.AppError(404, "Contact not found", "NOT_FOUND");
    }
    let phone = c.phone;
    let status = c.status;
    let name = c.name;
    if (input.name !== undefined) {
        const t = input.name.trim();
        if (!t) {
            throw new errors_1.AppError(400, "Name cannot be empty", "VALIDATION");
        }
        name = t.slice(0, 200);
    }
    let phoneChanged = false;
    if (input.phone !== undefined) {
        const v = (0, phone_1.validateAndFormatPhone)(input.phone);
        if (!v.valid) {
            throw new errors_1.AppError(400, v.message, "INVALID_PHONE");
        }
        phone = v.e164;
        phoneChanged = phone !== c.phone;
    }
    if (phoneChanged) {
        status = client_1.ContactStatus.UNVERIFIED;
    }
    else if (input.status !== undefined) {
        status = apiToStatus(input.status);
    }
    try {
        const next = await prisma_1.prisma.contact.update({
            where: { id: contactId },
            data: { name, phone, status },
        });
        return contactToRow(next);
    }
    catch (e) {
        if (e instanceof client_1.Prisma.PrismaClientKnownRequestError &&
            e.code === "P2002") {
            throw new errors_1.AppError(409, "This phone number is already in the group", "DUPLICATE_PHONE");
        }
        throw e;
    }
}
async function deleteContact(workspaceId, contactId) {
    const c = await prisma_1.prisma.contact.findFirst({
        where: {
            id: contactId,
            group: { workspaceId },
        },
        select: { id: true },
    });
    if (!c) {
        throw new errors_1.AppError(404, "Contact not found", "NOT_FOUND");
    }
    await prisma_1.prisma.contact.delete({ where: { id: contactId } });
}

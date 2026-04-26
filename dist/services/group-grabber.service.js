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
exports.listWaGroupsForDevice = listWaGroupsForDevice;
exports.scrapeGroupMembers = scrapeGroupMembers;
const client_1 = require("@prisma/client");
const env_1 = require("../env");
const errors_1 = require("../lib/errors");
const devices_service_1 = require("./devices.service");
const waSession = __importStar(require("./wa-device-session.service"));
function formatListDate(ts) {
    if (!ts || typeof ts !== "number") {
        return new Date().toLocaleDateString();
    }
    return new Date(ts * 1000).toLocaleDateString();
}
function jidToE164ish(jid) {
    if (!jid)
        return null;
    const base = jid.split("@")[0] ?? "";
    const num = base.includes(":") ? base.split(":")[0] : base;
    if (!/^\d{6,15}$/.test(num))
        return null;
    return `+${num}`;
}
/** Only PN (or legacy @c.us) JIDs encode a real phone; @lid is an internal link ID — never treat as +E.164. */
function isPhoneNetworkJid(jid) {
    const j = jid.toLowerCase();
    return j.endsWith("@s.whatsapp.net") || j.endsWith("@c.us");
}
function isLidJid(jid) {
    const j = jid.toLowerCase();
    return j.endsWith("@lid") || j.endsWith("@hosted.lid");
}
function participantPhone(p) {
    const pn = p.phoneNumber;
    if (pn) {
        const raw = pn.includes("@") ? pn : `${pn}@s.whatsapp.net`;
        if (isPhoneNetworkJid(raw) && !isLidJid(raw)) {
            const e = jidToE164ish(raw);
            if (e)
                return e;
        }
    }
    const id = p.id;
    if (!id || isLidJid(id) || !isPhoneNetworkJid(id)) {
        return null;
    }
    return jidToE164ish(id);
}
function participantDisplayName(p) {
    const n = [p.name, p.notify, p.verifiedName].find((x) => typeof x === "string" && x.trim());
    return n?.trim() || "Contact";
}
function isParticipantAdmin(p) {
    return (p.admin === "admin" ||
        p.admin === "superadmin" ||
        p.isAdmin === true ||
        p.isSuperAdmin === true);
}
/**
 * WhatsApp Community: phone numbers usually appear on linked discussion groups, not on the
 * community root. When `groupJid` is the community root, merge members from all sub-groups.
 * When `groupJid` is a subgroup (`linkedParent` set), keep only that chat's participants.
 */
async function resolveGroupParticipants(sock, groupJid, meta) {
    let participants = [...(meta.participants ?? [])];
    const sockExt = sock;
    if (typeof sockExt.communityFetchLinkedGroups !== "function") {
        return participants;
    }
    try {
        const res = await sockExt.communityFetchLinkedGroups(groupJid);
        if (res.communityJid !== groupJid || !res.linkedGroups?.length) {
            return participants;
        }
        const byId = new Map();
        for (const p of participants) {
            byId.set(p.id, p);
        }
        for (const g of res.linkedGroups) {
            if (!g?.id)
                continue;
            try {
                const sub = await sock.groupMetadata(g.id);
                for (const p of sub.participants ?? []) {
                    if (!byId.has(p.id)) {
                        byId.set(p.id, p);
                    }
                }
            }
            catch (e) {
                console.warn(`[group-grabber] subgroup metadata failed for ${g.id}`, e);
            }
        }
        return [...byId.values()];
    }
    catch (err) {
        console.warn("[group-grabber] communityFetchLinkedGroups failed", err);
        return participants;
    }
}
function normalizeJid(j) {
    if (!j)
        return null;
    return j.split(":")[0] ?? j;
}
function isUserAdminInGroup(sock, meta) {
    const myRaw = sock.user?.id;
    if (!myRaw)
        return false;
    const myNorm = normalizeJid(myRaw);
    for (const p of meta.participants) {
        const pid = normalizeJid(p.id);
        const ppn = p.phoneNumber ? normalizeJid(p.phoneNumber) : null;
        const match = pid === myNorm ||
            (ppn && ppn === myNorm) ||
            (myRaw && p.id === myRaw);
        if (match) {
            return (p.admin === "admin" ||
                p.admin === "superadmin" ||
                p.isAdmin === true ||
                p.isSuperAdmin === true);
        }
    }
    return false;
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/**
 * WhatsApp sometimes returns an empty participating list right after the socket
 * opens; retry a few times before giving up.
 */
async function fetchParticipatingGroups(sock) {
    const maxAttempts = 5;
    const pauseMs = 1800;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const map = await sock.groupFetchAllParticipating();
            const keys = Object.keys(map ?? {});
            if (keys.length > 0 || attempt === maxAttempts) {
                return map ?? {};
            }
            await sleep(pauseMs);
        }
        catch (e) {
            if (attempt === maxAttempts) {
                throw e;
            }
            await sleep(pauseMs);
        }
    }
    return {};
}
/**
 * Some WhatsApp Communities only appear in `communityFetchAllParticipating`, not in
 * `groupFetchAllParticipating`. Merge so the Communities tab can open member scrape.
 */
async function fetchParticipatingMerged(sock) {
    const map = {
        ...(await fetchParticipatingGroups(sock)),
    };
    const sockExt = sock;
    if (typeof sockExt.communityFetchAllParticipating !== "function") {
        return map;
    }
    try {
        const communities = await sockExt.communityFetchAllParticipating();
        for (const [id, meta] of Object.entries(communities ?? {})) {
            if (meta?.id && map[id] === undefined) {
                map[id] = meta;
            }
        }
    }
    catch (e) {
        console.warn("[group-grabber] communityFetchAllParticipating failed", e);
    }
    return map;
}
function metadataToRow(meta, sock) {
    const jid = meta.id;
    if (!jid || typeof jid !== "string") {
        throw new Error("missing group id");
    }
    const isCommunity = meta.isCommunity === true;
    const kind = isCommunity ? "community" : "group";
    const n = meta.participants?.length ?? meta.size ?? 0;
    const role = isUserAdminInGroup(sock, meta) ? "admin" : "member";
    return {
        id: jid,
        jid,
        name: (meta.subject || "Unnamed group").slice(0, 200),
        kind,
        participants: n,
        role,
        createdAtLabel: formatListDate(meta.creation),
        linkedParentJid: meta.linkedParent ?? null,
    };
}
async function listWaGroupsForDevice(workspaceId, deviceId) {
    const device = await (0, devices_service_1.getDeviceOrThrow)(deviceId, workspaceId);
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        return {
            bridgeEnabled: false,
            deviceConnected: device.status === client_1.DeviceStatus.CONNECTED,
            socketOpen: false,
            hint: "WhatsApp bridge is disabled on the server. Enable WHATSAPP_BRIDGE_ENABLED and link a device via QR to list groups.",
            groups: [],
        };
    }
    if (device.status !== client_1.DeviceStatus.CONNECTED) {
        return {
            bridgeEnabled: true,
            deviceConnected: false,
            socketOpen: false,
            hint: "Link this device with WhatsApp (QR) on the Devices page before grabbing groups.",
            groups: [],
        };
    }
    await waSession.ensureWaDeviceSession(deviceId, workspaceId);
    const sock = await waSession.waitForOpenWaSocket(deviceId, workspaceId, 52000);
    if (!sock) {
        return {
            bridgeEnabled: true,
            deviceConnected: true,
            socketOpen: false,
            hint: "Session is not connected yet. Open the Devices page, confirm this session shows Connected (or scan QR again), wait a few seconds, then refresh groups.",
            groups: [],
        };
    }
    try {
        const map = await fetchParticipatingMerged(sock);
        const list = [];
        for (const m of Object.values(map)) {
            try {
                if (!m?.id)
                    continue;
                list.push(metadataToRow(m, sock));
            }
            catch {
                /* skip malformed group node */
            }
        }
        list.sort((a, b) => a.name.localeCompare(b.name));
        return {
            bridgeEnabled: true,
            deviceConnected: true,
            socketOpen: true,
            hint: null,
            groups: list,
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new errors_1.AppError(502, `Could not fetch groups from WhatsApp: ${msg}`, "WA_GROUPS_FAILED");
    }
}
async function scrapeGroupMembers(workspaceId, deviceId, groupJid, options) {
    const trimmed = groupJid.trim();
    if (!trimmed || !trimmed.endsWith("@g.us")) {
        throw new errors_1.AppError(400, "Invalid WhatsApp group JID", "VALIDATION");
    }
    await (0, devices_service_1.getDeviceOrThrow)(deviceId, workspaceId);
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        throw new errors_1.AppError(503, "WhatsApp bridge is disabled", "BRIDGE_DISABLED");
    }
    const sock = await waSession.waitForOpenWaSocket(deviceId, workspaceId, 52000);
    if (!sock) {
        throw new errors_1.AppError(503, "WhatsApp session not connected", "WA_NOT_CONNECTED");
    }
    let meta;
    try {
        meta = await sock.groupMetadata(trimmed);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new errors_1.AppError(502, `Could not load group members: ${msg}`, "WA_GROUP_METADATA_FAILED");
    }
    let participants = await resolveGroupParticipants(sock, trimmed, meta);
    if (options?.excludeAdmins) {
        participants = participants.filter((p) => !isParticipantAdmin(p));
    }
    const members = participants.map((p) => ({
        jid: p.id,
        phone: participantPhone(p),
        name: participantDisplayName(p),
        isAdmin: isParticipantAdmin(p),
    }));
    return { members };
}

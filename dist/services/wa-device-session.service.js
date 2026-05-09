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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deviceSessionPath = deviceSessionPath;
exports.getOpenSocketProfilePictureUrl = getOpenSocketProfilePictureUrl;
exports.fetchAndPersistProfilePicture = fetchAndPersistProfilePicture;
exports.getWaQr = getWaQr;
exports.getWaConnection = getWaConnection;
exports.getWaStartError = getWaStartError;
exports.getOpenWaSocket = getOpenWaSocket;
exports.waitForOpenWaSocket = waitForOpenWaSocket;
exports.resolveOpenWaSocketForWorkspace = resolveOpenWaSocketForWorkspace;
exports.ensureConnectedWaSessionsOnStartup = ensureConnectedWaSessionsOnStartup;
exports.ensureWaDeviceSession = ensureWaDeviceSession;
exports.stopWaDeviceSession = stopWaDeviceSession;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const baileys_1 = require("@whiskeysockets/baileys");
const pino_1 = __importDefault(require("pino"));
const client_1 = require("@prisma/client");
const env_1 = require("../env");
const prisma_1 = require("../lib/prisma");
const auto_reply_inbound_service_1 = require("./auto_reply_inbound.service");
const chatbot_inbound_service_1 = require("./chatbot_inbound.service");
const live_chat_inbound_ingest_service_1 = require("./live_chat_inbound_ingest.service");
/** Repo root: `server/src/services` → `../../../` */
const REPO_ROOT = path_1.default.resolve(__dirname, "../../..");
const silentLogger = (0, pino_1.default)({ level: "silent" });
const sessions = new Map();
const startLocks = new Map();
function sessionsBaseDir() {
    if (env_1.env.WA_SESSIONS_DIR?.trim()) {
        const raw = env_1.env.WA_SESSIONS_DIR.trim();
        return path_1.default.isAbsolute(raw) ? raw : path_1.default.resolve(REPO_ROOT, raw);
    }
    return path_1.default.join(REPO_ROOT, ".wa-sessions");
}
function deviceSessionPath(workspaceId, deviceId) {
    return path_1.default.join(sessionsBaseDir(), workspaceId, deviceId);
}
function jidToPhone(jid) {
    if (!jid)
        return null;
    const m = jid.match(/^(\d+)@/);
    return m ? `+${m[1]}` : null;
}
const PROFILE_PIC_QUERY_MS = 14_000;
const PROFILE_FETCH_DEFER_MS = 1_200;
function staticProfileImageUrlFromCreds(sock) {
    const raw = sock.authState.creds.me?.imgUrl;
    if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
        return raw;
    }
    return null;
}
/** PN / LID / phone variants — WhatsApp may only resolve DP for one of them. */
function profilePictureJidCandidates(sock) {
    const me = sock.authState.creds.me;
    if (!me?.id)
        return [];
    const raw = [me.id];
    if (me.phoneNumber)
        raw.push(me.phoneNumber);
    if (me.lid)
        raw.push(me.lid);
    const normalized = raw
        .map((j) => (0, baileys_1.jidNormalizedUser)(j))
        .filter((j) => Boolean(j));
    return [...new Set(normalized)];
}
/**
 * Own profile photo: try low-res preview first (more reliable right after login),
 * then full image. Tries multiple JIDs when PN/LID split applies.
 */
async function fetchOwnProfilePictureUrl(sock, options) {
    const direct = staticProfileImageUrlFromCreds(sock);
    if (direct)
        return direct;
    const jids = profilePictureJidCandidates(sock);
    if (jids.length === 0) {
        console.warn("[wa-session] profile picture: missing creds.me.id");
        return null;
    }
    const deferMs = options?.deferMs ?? PROFILE_FETCH_DEFER_MS;
    if (deferMs > 0) {
        await new Promise((r) => setTimeout(r, deferMs));
    }
    for (const jid of jids) {
        for (const type of ["preview", "image"]) {
            try {
                const url = await sock.profilePictureUrl(jid, type, PROFILE_PIC_QUERY_MS);
                if (url)
                    return url;
            }
            catch (err) {
                console.warn(`[wa-session] profilePictureUrl jid=${jid} (${type})`, err);
            }
        }
    }
    return null;
}
/**
 * Latest profile picture URL from an open Baileys socket (for API / proxy use).
 */
async function getOpenSocketProfilePictureUrl(deviceId) {
    const sock = getOpenWaSocket(deviceId);
    if (!sock)
        return null;
    return fetchOwnProfilePictureUrl(sock, { deferMs: 0 });
}
/**
 * When the Baileys socket is open, fetch the latest profile picture URL and
 * persist it (WhatsApp CDN links are signed and expire; callers may refresh periodically).
 */
async function fetchAndPersistProfilePicture(deviceId) {
    const url = await getOpenSocketProfilePictureUrl(deviceId);
    if (!url)
        return null;
    try {
        await prisma_1.prisma.device.update({
            where: { id: deviceId },
            data: { profilePictureUrl: url },
        });
    }
    catch (err) {
        console.warn("[wa-session] persist profile picture URL failed", err);
    }
    return url;
}
function getWaQr(deviceId) {
    return sessions.get(deviceId)?.qr ?? null;
}
function getWaConnection(deviceId) {
    return sessions.get(deviceId)?.connection ?? null;
}
function getWaStartError(deviceId) {
    return sessions.get(deviceId)?.startError ?? null;
}
/** Active socket when the session is fully connected (can send messages). */
function getOpenWaSocket(deviceId) {
    const e = sessions.get(deviceId);
    if (e?.connection === "open" && e.sock) {
        return e.sock;
    }
    return null;
}
/**
 * Ensures the session is running and waits until the socket is open (e.g. after API restart with saved creds).
 */
async function waitForOpenWaSocket(deviceId, workspaceId, timeoutMs = 28000) {
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        return null;
    }
    await ensureWaDeviceSession(deviceId, workspaceId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const sock = getOpenWaSocket(deviceId);
        if (sock) {
            return sock;
        }
        const err = getWaStartError(deviceId);
        if (err) {
            return null;
        }
        await new Promise((r) => setTimeout(r, 280));
    }
    return getOpenWaSocket(deviceId);
}
const DEFAULT_RESOLVE_MAX_DEVICES = 8;
const DEFAULT_RESOLVE_PER_DEVICE_MS = 18_000;
/**
 * Finds a workspace device whose Baileys socket is actually open (not only CONNECTED in DB).
 * Tries DB-connected devices first, then any other device (e.g. creds on disk while status lags).
 */
async function resolveOpenWaSocketForWorkspace(workspaceId, options) {
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        return null;
    }
    const maxDevices = options?.maxDevices ?? DEFAULT_RESOLVE_MAX_DEVICES;
    const perMs = options?.perDeviceTimeoutMs ?? DEFAULT_RESOLVE_PER_DEVICE_MS;
    const [connected, rest] = await Promise.all([
        prisma_1.prisma.device.findMany({
            where: { workspaceId, status: client_1.DeviceStatus.CONNECTED },
            orderBy: { updatedAt: "desc" },
            select: { id: true },
        }),
        prisma_1.prisma.device.findMany({
            where: {
                workspaceId,
                status: { not: client_1.DeviceStatus.CONNECTED },
            },
            orderBy: { updatedAt: "desc" },
            select: { id: true },
        }),
    ]);
    const orderedIds = [...connected, ...rest]
        .map((r) => r.id)
        .slice(0, maxDevices);
    for (const id of orderedIds) {
        const hot = getOpenWaSocket(id);
        if (hot) {
            return { deviceId: id, sock: hot };
        }
    }
    for (const id of orderedIds) {
        await ensureWaDeviceSession(id, workspaceId);
        const quick = getOpenWaSocket(id);
        if (quick) {
            return { deviceId: id, sock: quick };
        }
        const sock = await waitForOpenWaSocket(id, workspaceId, perMs);
        if (sock) {
            return { deviceId: id, sock };
        }
    }
    return null;
}
/**
 * Rehydrates Baileys sessions for devices already marked CONNECTED in DB.
 * This ensures inbound listeners (live chat + auto-reply) are attached after API restart.
 */
async function ensureConnectedWaSessionsOnStartup() {
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        return;
    }
    const connected = await prisma_1.prisma.device.findMany({
        where: { status: client_1.DeviceStatus.CONNECTED },
        select: { id: true, workspaceId: true },
        orderBy: { updatedAt: "desc" },
    });
    if (connected.length === 0) {
        return;
    }
    await Promise.all(connected.map(async (d) => {
        try {
            await ensureWaDeviceSession(d.id, d.workspaceId);
        }
        catch (err) {
            console.error(`[wa-session] startup restore failed for device ${d.id}`, err);
        }
    }));
}
/**
 * Starts (or reuses) a Baileys WhatsApp Web socket for this device so the UI can show a real scan QR.
 */
async function ensureWaDeviceSession(deviceId, workspaceId) {
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        return;
    }
    const existing = sessions.get(deviceId);
    if (existing?.sock &&
        (existing.connection === "open" || existing.connection === "connecting")) {
        return;
    }
    if (startLocks.has(deviceId)) {
        await startLocks.get(deviceId);
        return;
    }
    const startPromise = (async () => {
        if (existing?.sock) {
            try {
                existing.sock.ev.removeAllListeners("connection.update");
                existing.sock.ev.removeAllListeners("creds.update");
                existing.sock.ev.removeAllListeners("messages.upsert");
                existing.sock.end(undefined);
            }
            catch {
                /* ignore */
            }
        }
        sessions.set(deviceId, {
            sock: null,
            qr: null,
            connection: "connecting",
            startError: null,
        });
        const dir = deviceSessionPath(workspaceId, deviceId);
        fs_1.default.mkdirSync(dir, { recursive: true });
        try {
            const baileys = await Promise.resolve().then(() => __importStar(require("@whiskeysockets/baileys")));
            const makeWASocket = baileys.default;
            const { Browsers, DisconnectReason, downloadMediaMessage, extractMessageContent, fetchLatestBaileysVersion, fetchLatestWaWebVersion, useMultiFileAuthState, } = baileys;
            /** Match real WhatsApp Web so the mobile app accepts the QR (Linked devices → Link). */
            let version;
            try {
                const wa = await fetchLatestWaWebVersion();
                version = wa.version;
            }
            catch {
                const b = await fetchLatestBaileysVersion();
                version = b.version;
            }
            const { state, saveCreds } = await useMultiFileAuthState(dir);
            const sock = makeWASocket({
                version,
                auth: state,
                logger: silentLogger,
                syncFullHistory: false,
                browser: Browsers.appropriate("Chrome"),
            });
            const entry = sessions.get(deviceId);
            if (!entry)
                return;
            entry.sock = sock;
            sock.ev.on("connection.update", (update) => {
                const ent = sessions.get(deviceId);
                if (!ent)
                    return;
                const { connection, lastDisconnect, qr } = update;
                if (qr) {
                    ent.qr = qr;
                }
                if (connection === "connecting") {
                    ent.connection = "connecting";
                }
                if (connection === "open") {
                    ent.qr = null;
                    ent.connection = "open";
                    const jid = sock.authState.creds.me?.id ?? sock.user?.id;
                    const phone = jidToPhone(jid);
                    void prisma_1.prisma.device
                        .update({
                        where: { id: deviceId },
                        data: {
                            status: client_1.DeviceStatus.CONNECTED,
                            phone,
                        },
                    })
                        .catch((err) => {
                        console.error("[wa-session] failed to persist connected device", err);
                    });
                    void (async () => {
                        const profilePictureUrl = await fetchOwnProfilePictureUrl(sock);
                        if (!profilePictureUrl)
                            return;
                        try {
                            await prisma_1.prisma.device.update({
                                where: { id: deviceId },
                                data: { profilePictureUrl },
                            });
                        }
                        catch (err) {
                            console.error("[wa-session] failed to persist profile picture URL", err);
                        }
                    })();
                }
                if (connection === "close") {
                    ent.qr = null;
                    ent.connection = "close";
                    try {
                        sock.end(undefined);
                    }
                    catch {
                        /* ignore */
                    }
                    ent.sock = null;
                    const code = lastDisconnect?.error?.output
                        ?.statusCode;
                    if (code === DisconnectReason.loggedOut) {
                        void prisma_1.prisma.device
                            .update({
                            where: { id: deviceId },
                            data: {
                                status: client_1.DeviceStatus.QR_READY,
                                phone: null,
                                profilePictureUrl: null,
                            },
                        })
                            .catch(() => { });
                        void stopWaDeviceSession(deviceId, workspaceId).catch(() => { });
                    }
                }
            });
            sock.ev.on("creds.update", saveCreds);
            sock.ev.on("messages.upsert", async ({ messages, type }) => {
                if (!messages?.length)
                    return;
                if (type !== "notify" && type !== "append")
                    return;
                try {
                    await (0, live_chat_inbound_ingest_service_1.ingestInboundLiveChatMessages)(workspaceId, deviceId, messages, extractMessageContent, async (msg) => (await downloadMediaMessage(msg, "buffer", {}, {
                        logger: silentLogger,
                        reuploadRequest: sock.updateMediaMessage,
                    })));
                }
                catch (err) {
                    console.error("[wa-session] live-chat ingest error", err);
                }
                try {
                    await (0, auto_reply_inbound_service_1.dispatchAutoRepliesForInbound)(deviceId, workspaceId, sock, messages, extractMessageContent, type);
                }
                catch (err) {
                    console.error("[wa-session] auto-reply handler error", err);
                }
                try {
                    await (0, chatbot_inbound_service_1.dispatchChatbotFlowForInbound)(deviceId, workspaceId, sock, messages, extractMessageContent, type);
                }
                catch (err) {
                    console.error("[wa-session] chatbot handler error", err);
                }
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const ent = sessions.get(deviceId);
            if (ent) {
                ent.startError = msg;
                ent.connection = "close";
            }
            console.error("[wa-session] start failed", e);
        }
    })();
    startLocks.set(deviceId, startPromise);
    try {
        await startPromise;
    }
    finally {
        startLocks.delete(deviceId);
    }
}
async function stopWaDeviceSession(deviceId, workspaceId) {
    const entry = sessions.get(deviceId);
    if (entry?.sock) {
        try {
            entry.sock.ev.removeAllListeners("connection.update");
            entry.sock.ev.removeAllListeners("creds.update");
            entry.sock.ev.removeAllListeners("messages.upsert");
            entry.sock.end(undefined);
        }
        catch {
            /* ignore */
        }
    }
    sessions.delete(deviceId);
    const dir = deviceSessionPath(workspaceId, deviceId);
    try {
        fs_1.default.rmSync(dir, { recursive: true, force: true });
    }
    catch {
        /* ignore */
    }
}

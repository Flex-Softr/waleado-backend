import fs from "fs";
import path from "path";
import type { Boom } from "@hapi/boom";
import type { WASocket } from "@whiskeysockets/baileys";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import pino from "pino";
import { DeviceStatus } from "@prisma/client";
import { env } from "../env";
import { prisma } from "../lib/prisma";
import { dispatchAutoRepliesForInbound } from "./auto_reply_inbound.service";
import {
  recordCampaignMessageReceiptUpdates,
  recordCampaignMessageStatusUpdates,
} from "./campaign_engagement.service";
import { dispatchChatbotFlowForInbound } from "./chatbot_inbound.service";
import { ingestInboundLiveChatMessages } from "./live_chat_inbound_ingest.service";

/** Repo root: `src/services` (or `dist/services`) → `../..` */
const REPO_ROOT = path.resolve(__dirname, "../..");

const silentLogger = pino({ level: "silent" });

type WaConnection = "connecting" | "open" | "close" | null;

type SessionEntry = {
  sock: WASocket | null;
  qr: string | null;
  connection: WaConnection;
  startError: string | null;
};

const sessions = new Map<string, SessionEntry>();
const startLocks = new Map<string, Promise<void>>();

function sessionsBaseDir(): string {
  if (env.WA_SESSIONS_DIR?.trim()) {
    const raw = env.WA_SESSIONS_DIR.trim();
    return path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
  }
  return path.join(REPO_ROOT, ".wa-sessions");
}

export function deviceSessionPath(
  workspaceId: string,
  deviceId: string
): string {
  return path.join(sessionsBaseDir(), workspaceId, deviceId);
}

/**
 * Extract E.164 from a WhatsApp JID.
 * Own-device JIDs often include a device suffix (`8801…:1@s.whatsapp.net`).
 */
function jidToPhone(jid: string | undefined): string | null {
  if (!jid) return null;
  try {
    const normalized = jidNormalizedUser(jid);
    if (normalized) {
      const m = normalized.match(/^(\d+)@/);
      if (m) return `+${m[1]}`;
    }
  } catch {
    /* fall through */
  }
  const m = jid.match(/^(\d+)(?::\d+)?@/);
  return m ? `+${m[1]}` : null;
}

function isLidJid(jid: string): boolean {
  const j = jid.toLowerCase();
  return j.endsWith("@lid") || j.endsWith("@hosted.lid");
}

function isPhoneNetworkJid(jid: string): boolean {
  const j = jid.toLowerCase();
  return j.endsWith("@s.whatsapp.net") || j.endsWith("@c.us");
}

/** Normalize bare digits or a phone JID into …@s.whatsapp.net; reject LIDs. */
function toPhoneNetworkJid(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  if (isLidJid(trimmed)) return null;
  if (/^\d{6,15}$/.test(trimmed)) {
    return `${trimmed}@s.whatsapp.net`;
  }
  if (isPhoneNetworkJid(trimmed)) {
    return jidNormalizedUser(trimmed) || null;
  }
  return null;
}

/** Prefer creds.me.phoneNumber when me.id is a LID (LID digits are not E.164). */
function phoneFromAuthStateMe(me: {
  id?: string;
  phoneNumber?: string;
} | null | undefined): string | null {
  if (!me) return null;
  const fromPn = toPhoneNetworkJid(me.phoneNumber);
  if (fromPn) return jidToPhone(fromPn);

  if (me.id && !isLidJid(me.id) && isPhoneNetworkJid(me.id)) {
    return jidToPhone(me.id);
  }
  return null;
}

function ownPhoneFromCreds(sock: WASocket): string | null {
  const fromMe = phoneFromAuthStateMe(sock.authState.creds.me);
  if (fromMe) return fromMe;

  const id = sock.user?.id;
  if (id && !isLidJid(id) && isPhoneNetworkJid(id)) {
    return jidToPhone(id);
  }
  return null;
}

function readPhoneFromCredsFile(
  workspaceId: string,
  deviceId: string
): string | null {
  try {
    const credsPath = path.join(
      deviceSessionPath(workspaceId, deviceId),
      "creds.json"
    );
    if (!fs.existsSync(credsPath)) return null;
    const raw = JSON.parse(fs.readFileSync(credsPath, "utf8")) as {
      me?: { id?: string; phoneNumber?: string };
    };
    return phoneFromAuthStateMe(raw.me ?? null);
  } catch {
    return null;
  }
}

const PROFILE_PIC_QUERY_MS = 14_000;
const PROFILE_FETCH_DEFER_MS = 1_200;

function staticProfileImageUrlFromCreds(sock: WASocket): string | null {
  const raw = sock.authState.creds.me?.imgUrl;
  if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
    return raw;
  }
  return null;
}

function isProfilePictureNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: string; data?: unknown };
  if (e.message === "item-not-found") return true;
  return e.data === 404;
}

/** PN first, then LID only if no PN — WhatsApp may only resolve DP for one of them. */
function profilePictureJidCandidates(sock: WASocket): string[] {
  const me = sock.authState.creds.me;
  if (!me?.id) return [];

  const raw: string[] = [];
  const pn = toPhoneNetworkJid(me.phoneNumber);
  if (pn) raw.push(pn);

  if (!isLidJid(me.id) && isPhoneNetworkJid(me.id)) {
    raw.push(me.id);
  }

  if (raw.length === 0) {
    if (me.lid) raw.push(me.lid);
    else if (isLidJid(me.id)) raw.push(me.id);
  }

  const normalized = raw
    .map((j) => jidNormalizedUser(j))
    .filter((j): j is string => Boolean(j));
  return [...new Set(normalized)];
}

/**
 * Own profile photo: try low-res preview first (more reliable right after login),
 * then full image. Tries multiple JIDs when PN/LID split applies.
 */
async function fetchOwnProfilePictureUrl(
  sock: WASocket,
  options?: { deferMs?: number }
): Promise<string | null> {
  const direct = staticProfileImageUrlFromCreds(sock);
  if (direct) return direct;

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
    for (const type of ["preview", "image"] as const) {
      try {
        const url = await sock.profilePictureUrl(
          jid,
          type,
          PROFILE_PIC_QUERY_MS
        );
        if (url) return url;
      } catch (err) {
        if (isProfilePictureNotFound(err)) {
          console.warn(
            `[wa-session] profilePictureUrl jid=${jid} (${type}): item-not-found`
          );
        } else {
          console.warn(
            `[wa-session] profilePictureUrl jid=${jid} (${type})`,
            err
          );
        }
      }
    }
  }
  return null;
}

/**
 * Latest profile picture URL from an open Baileys socket (for API / proxy use).
 */
export async function getOpenSocketProfilePictureUrl(
  deviceId: string
): Promise<string | null> {
  const sock = getOpenWaSocket(deviceId);
  if (!sock) return null;
  return fetchOwnProfilePictureUrl(sock, { deferMs: 0 });
}

/**
 * When the Baileys socket is open, fetch the latest profile picture URL and
 * persist it (WhatsApp CDN links are signed and expire; callers may refresh periodically).
 */
export async function fetchAndPersistProfilePicture(
  deviceId: string
): Promise<string | null> {
  const url = await getOpenSocketProfilePictureUrl(deviceId);
  if (!url) return null;

  try {
    await prisma.device.update({
      where: { id: deviceId },
      data: { profilePictureUrl: url },
    });
  } catch (err) {
    console.warn("[wa-session] persist profile picture URL failed", err);
  }
  return url;
}

/**
 * Resolve the linked WhatsApp account phone from an open socket or saved creds,
 * then persist it when found (backfills devices connected before phone parsing worked).
 */
export async function fetchAndPersistOwnPhone(
  deviceId: string,
  workspaceId: string
): Promise<string | null> {
  const sock = getOpenWaSocket(deviceId);
  const phone =
    (sock ? ownPhoneFromCreds(sock) : null) ??
    readPhoneFromCredsFile(workspaceId, deviceId);
  if (!phone) return null;

  try {
    await prisma.device.update({
      where: { id: deviceId },
      data: { phone },
    });
  } catch (err) {
    console.warn("[wa-session] persist own phone failed", err);
  }
  return phone;
}

export function getWaQr(deviceId: string): string | null {
  return sessions.get(deviceId)?.qr ?? null;
}

export function getWaConnection(deviceId: string): WaConnection {
  return sessions.get(deviceId)?.connection ?? null;
}

export function getWaStartError(deviceId: string): string | null {
  return sessions.get(deviceId)?.startError ?? null;
}

/** Active socket when the session is fully connected (can send messages). */
export function getOpenWaSocket(deviceId: string): WASocket | null {
  const e = sessions.get(deviceId);
  if (e?.connection === "open" && e.sock) {
    return e.sock;
  }
  return null;
}

/**
 * Ensures the session is running and waits until the socket is open (e.g. after API restart with saved creds).
 */
export async function waitForOpenWaSocket(
  deviceId: string,
  workspaceId: string,
  timeoutMs = 28000
): Promise<WASocket | null> {
  if (!env.WHATSAPP_BRIDGE_ENABLED) {
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
export async function resolveOpenWaSocketForWorkspace(
  workspaceId: string,
  options?: { maxDevices?: number; perDeviceTimeoutMs?: number }
): Promise<{ deviceId: string; sock: WASocket } | null> {
  if (!env.WHATSAPP_BRIDGE_ENABLED) {
    return null;
  }

  const maxDevices = options?.maxDevices ?? DEFAULT_RESOLVE_MAX_DEVICES;
  const perMs = options?.perDeviceTimeoutMs ?? DEFAULT_RESOLVE_PER_DEVICE_MS;

  const [connected, rest] = await Promise.all([
    prisma.device.findMany({
      where: { workspaceId, status: DeviceStatus.CONNECTED },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    }),
    prisma.device.findMany({
      where: {
        workspaceId,
        status: { not: DeviceStatus.CONNECTED },
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
export async function ensureConnectedWaSessionsOnStartup(): Promise<void> {
  if (!env.WHATSAPP_BRIDGE_ENABLED) {
    return;
  }

  let connected: Array<{ id: string; workspaceId: string }>;
  try {
    connected = await prisma.device.findMany({
      where: { status: DeviceStatus.CONNECTED },
      select: { id: true, workspaceId: true },
      orderBy: { updatedAt: "desc" },
    });
  } catch (err) {
    console.error("[wa-session] startup restore skipped because the database is unavailable", err);
    return;
  }

  if (connected.length === 0) {
    return;
  }

  await Promise.all(
    connected.map(async (d) => {
      try {
        await ensureWaDeviceSession(d.id, d.workspaceId);
      } catch (err) {
        console.error(`[wa-session] startup restore failed for device ${d.id}`, err);
      }
    })
  );
}

/**
 * Starts (or reuses) a Baileys WhatsApp Web socket for this device so the UI can show a real scan QR.
 */
export async function ensureWaDeviceSession(
  deviceId: string,
  workspaceId: string
): Promise<void> {
  if (!env.WHATSAPP_BRIDGE_ENABLED) {
    return;
  }

  const existing = sessions.get(deviceId);
  if (
    existing?.sock &&
    (existing.connection === "open" || existing.connection === "connecting")
  ) {
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
        existing.sock.ev.removeAllListeners("messages.update");
        existing.sock.ev.removeAllListeners("message-receipt.update");
        existing.sock.end(undefined);
      } catch {
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
    fs.mkdirSync(dir, { recursive: true });

    try {
      const baileys = await import("@whiskeysockets/baileys");
      const makeWASocket = baileys.default;
      const {
        Browsers,
        DisconnectReason,
        downloadMediaMessage,
        extractMessageContent,
        fetchLatestBaileysVersion,
        fetchLatestWaWebVersion,
        useMultiFileAuthState,
      } = baileys;

      /** Match real WhatsApp Web so the mobile app accepts the QR (Linked devices → Link). */
      let version: import("@whiskeysockets/baileys").WAVersion;
      try {
        const wa = await fetchLatestWaWebVersion();
        version = wa.version;
      } catch {
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
      if (!entry) return;
      entry.sock = sock;

      sock.ev.on("connection.update", (update) => {
        const ent = sessions.get(deviceId);
        if (!ent) return;

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
          const phone = ownPhoneFromCreds(sock);

          void prisma.device
            .update({
              where: { id: deviceId },
              data: {
                status: DeviceStatus.CONNECTED,
                ...(phone ? { phone } : {}),
              },
            })
            .catch((err) => {
              console.error(
                "[wa-session] failed to persist connected device",
                err
              );
            });

          void (async () => {
            const profilePictureUrl = await fetchOwnProfilePictureUrl(sock);
            if (!profilePictureUrl) return;
            try {
              await prisma.device.update({
                where: { id: deviceId },
                data: { profilePictureUrl },
              });
            } catch (err) {
              console.error(
                "[wa-session] failed to persist profile picture URL",
                err
              );
            }
          })();
        }

        if (connection === "close") {
          ent.qr = null;
          ent.connection = "close";
          try {
            sock.end(undefined);
          } catch {
            /* ignore */
          }
          ent.sock = null;

          const code = (lastDisconnect?.error as Boom | undefined)?.output
            ?.statusCode;
          if (code === DisconnectReason.loggedOut) {
            void prisma.device
              .update({
                where: { id: deviceId },
                data: {
                  status: DeviceStatus.QR_READY,
                  phone: null,
                  profilePictureUrl: null,
                },
              })
              .catch(() => {});
            void stopWaDeviceSession(deviceId, workspaceId).catch(() => {});
          }
        }
      });

      sock.ev.on("creds.update", () => {
        void saveCreds().then(() => {
          const phone = ownPhoneFromCreds(sock);
          if (!phone) return;
          return prisma.device.update({
            where: { id: deviceId },
            data: { phone },
          });
        }).catch((err) => {
          console.warn("[wa-session] creds.update phone persist failed", err);
        });
      });

      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (!messages?.length) return;
        if (type !== "notify" && type !== "append") return;
        try {
          await ingestInboundLiveChatMessages(
            workspaceId,
            deviceId,
            messages,
            extractMessageContent,
            async (msg) =>
              (await downloadMediaMessage(
                msg,
                "buffer",
                {},
                {
                  logger: silentLogger,
                  reuploadRequest: sock.updateMediaMessage,
                }
              )) as Buffer | null
          );
        } catch (err) {
          console.error("[wa-session] live-chat ingest error", err);
        }
        try {
          await dispatchAutoRepliesForInbound(
            deviceId,
            workspaceId,
            sock,
            messages,
            extractMessageContent,
            type
          );
        } catch (err) {
          console.error("[wa-session] auto-reply handler error", err);
        }
        try {
          await dispatchChatbotFlowForInbound(
            deviceId,
            workspaceId,
            sock,
            messages,
            extractMessageContent,
            type
          );
        } catch (err) {
          console.error("[wa-session] chatbot handler error", err);
        }
      });

      sock.ev.on("messages.update", async (updates) => {
        if (!updates?.length) return;
        try {
          await recordCampaignMessageStatusUpdates(workspaceId, deviceId, updates);
        } catch (err) {
          console.error("[wa-session] campaign message status update error", err);
        }
      });

      sock.ev.on("message-receipt.update", async (updates) => {
        if (!updates?.length) return;
        try {
          await recordCampaignMessageReceiptUpdates(workspaceId, deviceId, updates);
        } catch (err) {
          console.error("[wa-session] campaign message receipt update error", err);
        }
      });
    } catch (e) {
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
  } finally {
    startLocks.delete(deviceId);
  }
}

export async function stopWaDeviceSession(
  deviceId: string,
  workspaceId: string
): Promise<void> {
  const entry = sessions.get(deviceId);
  if (entry?.sock) {
    try {
      entry.sock.ev.removeAllListeners("connection.update");
      entry.sock.ev.removeAllListeners("creds.update");
      entry.sock.ev.removeAllListeners("messages.upsert");
      entry.sock.ev.removeAllListeners("messages.update");
      entry.sock.ev.removeAllListeners("message-receipt.update");
      entry.sock.end(undefined);
    } catch {
      /* ignore */
    }
  }
  sessions.delete(deviceId);

  const dir = deviceSessionPath(workspaceId, deviceId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

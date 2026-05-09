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
import { dispatchChatbotFlowForInbound } from "./chatbot_inbound.service";
import { ingestInboundLiveChatMessages } from "./live_chat_inbound_ingest.service";

/** Repo root: `server/src/services` → `../../../` */
const REPO_ROOT = path.resolve(__dirname, "../../..");

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

function jidToPhone(jid: string | undefined): string | null {
  if (!jid) return null;
  const m = jid.match(/^(\d+)@/);
  return m ? `+${m[1]}` : null;
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

/** PN / LID / phone variants — WhatsApp may only resolve DP for one of them. */
function profilePictureJidCandidates(sock: WASocket): string[] {
  const me = sock.authState.creds.me;
  if (!me?.id) return [];
  const raw: string[] = [me.id];
  if (me.phoneNumber) raw.push(me.phoneNumber);
  if (me.lid) raw.push(me.lid);
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
        console.warn(
          `[wa-session] profilePictureUrl jid=${jid} (${type})`,
          err
        );
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

  const connected = await prisma.device.findMany({
    where: { status: DeviceStatus.CONNECTED },
    select: { id: true, workspaceId: true },
    orderBy: { updatedAt: "desc" },
  });

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
          const jid = sock.authState.creds.me?.id ?? sock.user?.id;
          const phone = jidToPhone(jid);

          void prisma.device
            .update({
              where: { id: deviceId },
              data: {
                status: DeviceStatus.CONNECTED,
                phone,
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

      sock.ev.on("creds.update", saveCreds);

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

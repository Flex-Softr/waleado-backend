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
exports.deviceToJson = deviceToJson;
exports.listDevices = listDevices;
exports.createDevice = createDevice;
exports.getDeviceOrThrow = getDeviceOrThrow;
exports.getDeviceProfilePhotoBytes = getDeviceProfilePhotoBytes;
exports.getDeviceLinkState = getDeviceLinkState;
exports.disconnectDevice = disconnectDevice;
exports.simulateDeviceConnected = simulateDeviceConnected;
exports.deleteDevice = deleteDevice;
const crypto_1 = require("crypto");
const client_1 = require("@prisma/client");
const prisma_1 = require("../lib/prisma");
const errors_1 = require("../lib/errors");
const env_1 = require("../env");
const waSession = __importStar(require("./wa-device-session.service"));
const DEMO_PHONE = "+917261902348";
function maxDevicesForPlan(plan) {
    switch (plan) {
        case client_1.Plan.FREE:
            return 1;
        case client_1.Plan.PRO:
            return 5;
        case client_1.Plan.BUSINESS:
            return 100;
        default:
            return 1;
    }
}
function newSessionId() {
    return `sess_${(0, crypto_1.randomBytes)(18).toString("base64url")}`;
}
function statusToApi(s) {
    return s === client_1.DeviceStatus.QR_READY ? "qr_ready" : "connected";
}
function deviceToJson(d) {
    return {
        id: d.id,
        workspaceId: d.workspaceId,
        name: d.name,
        sessionId: d.sessionId,
        status: statusToApi(d.status),
        phone: d.phone,
        profilePictureUrl: d.profilePictureUrl,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
    };
}
async function listDevices(workspaceId) {
    const rows = await prisma_1.prisma.device.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
    });
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        return rows.map(deviceToJson);
    }
    const mapped = await Promise.all(rows.map(async (row) => {
        const json = deviceToJson(row);
        if (row.status !== client_1.DeviceStatus.CONNECTED ||
            row.profilePictureUrl != null) {
            return json;
        }
        const fresh = await waSession.fetchAndPersistProfilePicture(row.id);
        if (fresh) {
            return { ...json, profilePictureUrl: fresh };
        }
        return json;
    }));
    return mapped;
}
async function createDevice(workspaceId, name) {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new errors_1.AppError(400, "Device name is required", "VALIDATION");
    }
    const workspace = await prisma_1.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true },
    });
    if (!workspace) {
        throw new errors_1.AppError(404, "Workspace not found", "NOT_FOUND");
    }
    const count = await prisma_1.prisma.device.count({ where: { workspaceId } });
    const max = maxDevicesForPlan(workspace.plan);
    if (count >= max) {
        throw new errors_1.AppError(403, `Your plan allows up to ${max} device(s). Upgrade billing to add more.`, "PLAN_DEVICE_LIMIT");
    }
    const device = await prisma_1.prisma.device.create({
        data: {
            workspaceId,
            name: trimmed.slice(0, 120),
            sessionId: newSessionId(),
            status: client_1.DeviceStatus.QR_READY,
        },
    });
    return deviceToJson(device);
}
async function getDeviceOrThrow(deviceId, workspaceId) {
    const d = await prisma_1.prisma.device.findFirst({
        where: { id: deviceId, workspaceId },
    });
    if (!d) {
        throw new errors_1.AppError(404, "Device not found", "NOT_FOUND");
    }
    return d;
}
const WA_PROFILE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
async function downloadProfilePhotoFromCdn(url) {
    try {
        const res = await fetch(url, {
            redirect: "follow",
            headers: {
                Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                "User-Agent": WA_PROFILE_UA,
            },
        });
        if (!res.ok)
            return null;
        const ab = await res.arrayBuffer();
        const rawType = res.headers.get("content-type");
        const contentType = rawType?.split(";")[0]?.trim() || "image/jpeg";
        return { body: Buffer.from(ab), contentType };
    }
    catch (err) {
        console.warn("[devices] profile photo CDN download failed", err);
        return null;
    }
}
/**
 * Fetches bytes for the linked WhatsApp account photo (server-side CDN fetch).
 * Browsers often cannot load signed pps.whatsapp.net URLs directly.
 */
async function getDeviceProfilePhotoBytes(deviceId, workspaceId) {
    const d = await getDeviceOrThrow(deviceId, workspaceId);
    if (d.status !== client_1.DeviceStatus.CONNECTED) {
        throw new errors_1.AppError(400, "Device not connected", "DEVICE_NOT_CONNECTED");
    }
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        throw new errors_1.AppError(503, "WhatsApp bridge is not enabled", "BRIDGE_DISABLED");
    }
    await waSession.ensureWaDeviceSession(deviceId, workspaceId);
    let url = await waSession.getOpenSocketProfilePictureUrl(deviceId);
    if (!url && d.profilePictureUrl) {
        url = d.profilePictureUrl;
    }
    if (!url) {
        throw new errors_1.AppError(404, "No profile photo from WhatsApp (check privacy: who can see your photo).", "PROFILE_PHOTO_UNAVAILABLE");
    }
    let downloaded = await downloadProfilePhotoFromCdn(url);
    if (!downloaded) {
        const fresh = await waSession.getOpenSocketProfilePictureUrl(deviceId);
        if (fresh && fresh !== url) {
            downloaded = await downloadProfilePhotoFromCdn(fresh);
            if (downloaded) {
                void prisma_1.prisma.device
                    .update({
                    where: { id: deviceId },
                    data: { profilePictureUrl: fresh },
                })
                    .catch(() => { });
            }
        }
    }
    if (!downloaded) {
        throw new errors_1.AppError(502, "Could not download profile photo from WhatsApp.", "PROFILE_PHOTO_DOWNLOAD_FAILED");
    }
    return downloaded;
}
async function getDeviceLinkState(deviceId, workspaceId) {
    const d = await getDeviceOrThrow(deviceId, workspaceId);
    if (d.status === client_1.DeviceStatus.CONNECTED) {
        if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
            return {
                bridgeEnabled: false,
                qr: null,
                connection: null,
                status: "connected",
                startError: null,
            };
        }
        await waSession.ensureWaDeviceSession(deviceId, workspaceId);
        return {
            bridgeEnabled: true,
            qr: waSession.getWaQr(deviceId),
            connection: waSession.getWaConnection(deviceId),
            status: "connected",
            startError: waSession.getWaStartError(deviceId),
        };
    }
    if (!env_1.env.WHATSAPP_BRIDGE_ENABLED) {
        return {
            bridgeEnabled: false,
            qr: null,
            connection: null,
            status: "qr_ready",
            startError: null,
        };
    }
    await waSession.ensureWaDeviceSession(deviceId, workspaceId);
    const refreshed = await prisma_1.prisma.device.findFirst({
        where: { id: deviceId, workspaceId },
    });
    if (!refreshed) {
        throw new errors_1.AppError(404, "Device not found", "NOT_FOUND");
    }
    return {
        bridgeEnabled: true,
        qr: waSession.getWaQr(deviceId),
        connection: waSession.getWaConnection(deviceId),
        status: statusToApi(refreshed.status),
        startError: waSession.getWaStartError(deviceId),
    };
}
async function disconnectDevice(deviceId, workspaceId) {
    await getDeviceOrThrow(deviceId, workspaceId);
    await waSession.stopWaDeviceSession(deviceId, workspaceId);
    const updated = await prisma_1.prisma.device.update({
        where: { id: deviceId },
        data: {
            status: client_1.DeviceStatus.QR_READY,
            phone: null,
            profilePictureUrl: null,
        },
    });
    return deviceToJson(updated);
}
/** Simulates a successful QR scan until a real WhatsApp bridge is wired. */
async function simulateDeviceConnected(deviceId, workspaceId) {
    await getDeviceOrThrow(deviceId, workspaceId);
    await waSession.stopWaDeviceSession(deviceId, workspaceId);
    const updated = await prisma_1.prisma.device.update({
        where: { id: deviceId },
        data: {
            status: client_1.DeviceStatus.CONNECTED,
            phone: DEMO_PHONE,
            profilePictureUrl: null,
        },
    });
    return deviceToJson(updated);
}
async function deleteDevice(deviceId, workspaceId) {
    const d = await getDeviceOrThrow(deviceId, workspaceId);
    await waSession.stopWaDeviceSession(d.id, d.workspaceId);
    await prisma_1.prisma.device.delete({ where: { id: d.id } });
}

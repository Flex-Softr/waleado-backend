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
exports.devicesRouter = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const devices = __importStar(require("../services/devices.service"));
const router = (0, express_1.Router)();
exports.devicesRouter = router;
router.use(auth_1.requireAuth);
const createBody = zod_1.z.object({
    name: zod_1.z.string().min(1).max(120),
});
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res)).catch(next);
    };
}
router.get("/", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const list = await devices.listDevices(auth.wid);
    res.json({ devices: list });
}));
router.post("/", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = createBody.parse(req.body);
    const device = await devices.createDevice(auth.wid, body.name);
    res.status(201).json(device);
}));
/** Proxied WhatsApp profile image (Bearer auth); browsers cannot rely on signed CDN URLs alone. */
router.get("/:deviceId/profile-photo", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const deviceId = req.params.deviceId;
    if (!deviceId) {
        throw new errors_1.AppError(400, "deviceId required", "VALIDATION");
    }
    const { body, contentType } = await devices.getDeviceProfilePhotoBytes(deviceId, auth.wid);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=120");
    res.send(body);
}));
router.get("/:deviceId/link", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const deviceId = req.params.deviceId;
    if (!deviceId) {
        throw new errors_1.AppError(400, "deviceId required", "VALIDATION");
    }
    const state = await devices.getDeviceLinkState(deviceId, auth.wid);
    res.json(state);
}));
router.post("/:deviceId/disconnect", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const deviceId = req.params.deviceId;
    if (!deviceId) {
        throw new errors_1.AppError(400, "deviceId required", "VALIDATION");
    }
    const device = await devices.disconnectDevice(deviceId, auth.wid);
    res.json(device);
}));
router.post("/:deviceId/simulate-connect", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const deviceId = req.params.deviceId;
    if (!deviceId) {
        throw new errors_1.AppError(400, "deviceId required", "VALIDATION");
    }
    const device = await devices.simulateDeviceConnected(deviceId, auth.wid);
    res.json(device);
}));
router.delete("/:deviceId", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const deviceId = req.params.deviceId;
    if (!deviceId) {
        throw new errors_1.AppError(400, "deviceId required", "VALIDATION");
    }
    await devices.deleteDevice(deviceId, auth.wid);
    res.status(204).send();
}));

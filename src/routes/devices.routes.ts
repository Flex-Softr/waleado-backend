import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as devices from "../services/devices.service";

const router = Router();
router.use(requireAuth);

const createBody = z.object({
  name: z.string().min(1).max(120),
});

function asyncHandler(
  fn: (req: AuthedRequest, res: import("express").Response) => Promise<void>
) {
  return (
    req: AuthedRequest,
    res: import("express").Response,
    next: import("express").NextFunction
  ) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const list = await devices.listDevices(auth.wid);
    res.json({ devices: list });
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = createBody.parse(req.body);
    const device = await devices.createDevice(auth.wid, body.name);
    res.status(201).json(device);
  })
);

/** Proxied WhatsApp profile image (Bearer auth); browsers cannot rely on signed CDN URLs alone. */
router.get(
  "/:deviceId/profile-photo",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const deviceId = req.params.deviceId;
    if (!deviceId) {
      throw new AppError(400, "deviceId required", "VALIDATION");
    }
    const { body, contentType } = await devices.getDeviceProfilePhotoBytes(
      deviceId,
      auth.wid
    );
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=120");
    res.send(body);
  })
);

router.get(
  "/:deviceId/link",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const deviceId = req.params.deviceId;
    if (!deviceId) {
      throw new AppError(400, "deviceId required", "VALIDATION");
    }
    const state = await devices.getDeviceLinkState(deviceId, auth.wid);
    res.json(state);
  })
);

router.post(
  "/:deviceId/set-default",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const deviceId = req.params.deviceId;
    if (!deviceId) {
      throw new AppError(400, "deviceId required", "VALIDATION");
    }
    const device = await devices.setDefaultDevice(deviceId, auth.wid);
    res.json(device);
  })
);

router.post(
  "/:deviceId/disconnect",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const deviceId = req.params.deviceId;
    if (!deviceId) {
      throw new AppError(400, "deviceId required", "VALIDATION");
    }
    const device = await devices.disconnectDevice(deviceId, auth.wid);
    res.json(device);
  })
);

router.post(
  "/:deviceId/simulate-connect",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const deviceId = req.params.deviceId;
    if (!deviceId) {
      throw new AppError(400, "deviceId required", "VALIDATION");
    }
    const device = await devices.simulateDeviceConnected(deviceId, auth.wid);
    res.json(device);
  })
);

router.delete(
  "/:deviceId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const deviceId = req.params.deviceId;
    if (!deviceId) {
      throw new AppError(400, "deviceId required", "VALIDATION");
    }
    await devices.deleteDevice(deviceId, auth.wid);
    res.status(204).send();
  })
);

export { router as devicesRouter };

import { Router } from "express";
import { AppError } from "../../lib/errors";
import { openApiSuccess } from "../../lib/open-api-response";
import type { ApiClientRequest } from "../../middleware/api-client-auth";
import * as devices from "../../services/devices.service";

const router = Router();

function asyncHandler(
  fn: (req: ApiClientRequest, res: import("express").Response) => Promise<void>
) {
  return (
    req: ApiClientRequest,
    res: import("express").Response,
    next: import("express").NextFunction
  ) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspaceId = req.apiClient?.workspaceId;
    if (!workspaceId) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const list = await devices.listDevices(workspaceId);
    openApiSuccess(res, "Devices retrieved successfully.", {
      devices: list.map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status,
        phone: d.phone,
        isDefault: d.isDefault,
      })),
    });
  })
);

export { router as openDevicesRouter };

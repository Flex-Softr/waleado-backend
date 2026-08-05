import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as apiCredentials from "../services/api_credentials.service";

const router = Router();
router.use(requireAuth);

const createBody = z.object({
  name: z.string().min(1).max(200),
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

function requireOwnerOrAdmin(role: string | undefined): void {
  if (role !== "OWNER" && role !== "ADMIN") {
    throw new AppError(
      403,
      "Only workspace owners and admins can manage API credentials",
      "FORBIDDEN"
    );
  }
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const list = await apiCredentials.listApiCredentials(auth.wid);
    res.json({ credentials: list });
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireOwnerOrAdmin(auth.role);
    const body = createBody.parse(req.body);
    const created = await apiCredentials.createApiCredential(auth.wid, {
      name: body.name,
      createdByUserId: auth.sub,
    });
    res.status(201).json({ credential: created });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    requireOwnerOrAdmin(auth.role);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const revoked = await apiCredentials.revokeApiCredential(auth.wid, id);
    res.json({ credential: revoked });
  })
);

export { router as apiCredentialsRouter };

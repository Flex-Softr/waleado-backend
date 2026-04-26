import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as contacts from "../services/contacts.service";
import * as grabber from "../services/group-grabber.service";

const router = Router();
router.use(requireAuth);

const scrapeBody = z.object({
  groupJid: z.string().min(5).max(120),
  /** When true, only non-admin participants are returned (for contact lists without admins). */
  excludeAdmins: z.boolean().optional(),
});

const importBody = z.object({
  targetContactGroupId: z.string().uuid(),
  members: z
    .array(
      z.object({
        name: z.string().max(200).optional(),
        phone: z.string().min(3).max(32),
      })
    )
    .min(1)
    .max(2000),
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
  "/devices/:deviceId/groups",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(req.params);
    const out = await grabber.listWaGroupsForDevice(auth.wid, deviceId);
    res.json(out);
  })
);

router.post(
  "/devices/:deviceId/scrape-members",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(req.params);
    const body = scrapeBody.parse(req.body);
    const out = await grabber.scrapeGroupMembers(auth.wid, deviceId, body.groupJid, {
      excludeAdmins: body.excludeAdmins === true,
    });
    res.json(out);
  })
);

router.post(
  "/import-members",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = importBody.parse(req.body);
    const out = await contacts.importMembersFromGrabber(
      auth.wid,
      body.targetContactGroupId,
      body.members.map((m) => ({
        name: m.name?.trim() || "Contact",
        phone: m.phone.trim(),
      }))
    );
    res.status(201).json(out);
  })
);

export { router as groupGrabberRouter };

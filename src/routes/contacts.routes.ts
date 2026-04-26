import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as contacts from "../services/contacts.service";

const router = Router();
router.use(requireAuth);

const updateContactBody = z.object({
  name: z.string().min(1).max(200).optional(),
  phone: z.string().min(3).max(32).optional(),
  status: z.enum(["verified", "unverified", "invalid"]).optional(),
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

router.patch(
  "/:contactId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { contactId } = z
      .object({ contactId: z.string().uuid() })
      .parse(req.params);
    const body = updateContactBody.parse(req.body);
    const row = await contacts.updateContact(auth.wid, contactId, body);
    res.json({ contact: row });
  })
);

router.delete(
  "/:contactId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { contactId } = z
      .object({ contactId: z.string().uuid() })
      .parse(req.params);
    await contacts.deleteContact(auth.wid, contactId);
    res.status(204).send();
  })
);

export { router as contactsRouter };

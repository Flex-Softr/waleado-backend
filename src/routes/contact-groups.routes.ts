import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as contacts from "../services/contacts.service";

const router = Router();
router.use(requireAuth);

const createGroupBody = z.object({
  name: z.string().min(1).max(200),
});

const updateGroupBody = z.object({
  name: z.string().min(1).max(200),
});

const createContactBody = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().min(3).max(32),
});

const bulkContactsBody = z.object({
  lines: z.array(z.string().max(4096)).max(2000),
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
    const list = await contacts.listGroups(auth.wid);
    res.json({ groups: list });
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = createGroupBody.parse(req.body);
    const g = await contacts.createGroup(auth.wid, body.name);
    res.status(201).json({ group: g });
  })
);

router.post(
  "/actions/revalidate-phones",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const out = await contacts.revalidateAllContactsInWorkspace(auth.wid);
    res.json(out);
  })
);

router.get(
  "/:groupId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.params);
    const detail = await contacts.getGroupDetail(auth.wid, groupId);
    res.json(detail);
  })
);

router.patch(
  "/:groupId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.params);
    const body = updateGroupBody.parse(req.body);
    const g = await contacts.updateGroup(auth.wid, groupId, body.name);
    res.json({ group: g });
  })
);

router.delete(
  "/:groupId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.params);
    await contacts.deleteGroup(auth.wid, groupId);
    res.status(204).send();
  })
);

router.post(
  "/:groupId/contacts/bulk",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.params);
    const body = bulkContactsBody.parse(req.body);
    const out = await contacts.bulkCreateContacts(auth.wid, groupId, body.lines);
    res.status(201).json(out);
  })
);

router.post(
  "/:groupId/contacts",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.params);
    const body = createContactBody.parse(req.body);
    const row = await contacts.createContact(auth.wid, groupId, {
      name: body.name ?? "Contact",
      phone: body.phone,
    });
    res.status(201).json({ contact: row });
  })
);

router.post(
  "/:groupId/actions/remove-invalid",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.params);
    const out = await contacts.removeInvalidContactsInGroup(auth.wid, groupId);
    res.json(out);
  })
);

router.post(
  "/:groupId/actions/revalidate-phones",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.params);
    const out = await contacts.revalidateContactsInGroup(auth.wid, groupId);
    res.json(out);
  })
);

export { router as contactGroupsRouter };

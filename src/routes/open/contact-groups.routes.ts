import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { openApiSuccess } from "../../lib/open-api-response";
import type { ApiClientRequest } from "../../middleware/api-client-auth";
import * as contacts from "../../services/contacts.service";

const router = Router();

const createGroupBody = z.object({
  name: z.string().min(1).max(200),
  /** Phone numbers with country code (+ optional). Duplicates and invalids are skipped/rejected. */
  phones: z.array(z.string().min(3).max(32)).max(2000).default([]),
});

const createContactBody = z.object({
  name: z.string().max(200).optional(),
  phone: z.string().min(3).max(32),
});

const bulkContactsBody = z.object({
  lines: z.array(z.string().max(4096)).max(2000),
});

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

function requireWorkspace(req: ApiClientRequest): string {
  const workspaceId = req.apiClient?.workspaceId;
  if (!workspaceId) {
    throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
  }
  return workspaceId;
}

/** List contact groups with verification stats. */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const workspaceId = requireWorkspace(req);
    const groups = await contacts.listGroups(workspaceId);
    openApiSuccess(res, "Contact groups retrieved successfully.", { groups });
  })
);

/** Create a contact group with validated, unique phone numbers. */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const workspaceId = requireWorkspace(req);
    const body = createGroupBody.parse(req.body);
    const out = await contacts.createGroupWithPhones(
      workspaceId,
      body.name,
      body.phones
    );
    openApiSuccess(res, "Contact group created successfully.", out, 201);
  })
);

/** Group detail + contacts (check verified status before campaign). */
router.get(
  "/:groupId",
  asyncHandler(async (req, res) => {
    const workspaceId = requireWorkspace(req);
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.params);
    const detail = await contacts.getGroupDetail(workspaceId, groupId);
    openApiSuccess(res, "Contact group retrieved successfully.", detail);
  })
);

router.post(
  "/:groupId/contacts/bulk",
  asyncHandler(async (req, res) => {
    const workspaceId = requireWorkspace(req);
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.params);
    const body = bulkContactsBody.parse(req.body);
    const out = await contacts.bulkCreateContacts(workspaceId, groupId, body.lines);
    openApiSuccess(res, "Contacts imported successfully.", out, 201);
  })
);

router.post(
  "/:groupId/contacts",
  asyncHandler(async (req, res) => {
    const workspaceId = requireWorkspace(req);
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.params);
    const body = createContactBody.parse(req.body);
    const row = await contacts.createContact(workspaceId, groupId, {
      name: body.name ?? "Contact",
      phone: body.phone,
    });
    openApiSuccess(res, "Contact created successfully.", { contact: row }, 201);
  })
);

/** Validate/verify phones in the group (campaigns use VERIFIED contacts only). */
router.post(
  "/:groupId/actions/revalidate-phones",
  asyncHandler(async (req, res) => {
    const workspaceId = requireWorkspace(req);
    const { groupId } = z.object({ groupId: z.string().uuid() }).parse(req.params);
    const out = await contacts.revalidateContactsInGroup(workspaceId, groupId);
    openApiSuccess(res, "Contact phones revalidated successfully.", out);
  })
);

export { router as openContactGroupsRouter };

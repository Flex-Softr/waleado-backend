import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as callResponder from "../services/call_responder_rules.service";

const router = Router();
router.use(requireAuth);

const callType = z.enum(["received", "outgoing", "missed", "rejected"]);

const createBody = z.object({
  name: z.string().min(1).max(200),
  deviceId: z.string().uuid(),
  callTypes: z.array(callType).min(1).max(4),
  responseDelayMinutes: z.coerce.number().min(0).max(1440).default(0),
  messageFormType: z.enum(["text", "template"]),
  messageBody: z.string().max(4096).optional().nullable(),
  templateId: z.string().uuid().optional().nullable(),
  active: z.boolean().optional(),
});

const patchBody = createBody.partial().extend({
  callTypes: z.array(callType).min(1).max(4).optional(),
});

const idParams = z.object({ id: z.string().uuid() });

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
    const rules = await callResponder.listCallResponderRules(auth.wid);
    res.json({ rules });
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
    const rule = await callResponder.createCallResponderRule(auth.wid, body);
    res.status(201).json({ rule });
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { id } = idParams.parse(req.params);
    const body = patchBody.parse(req.body);
    const rule = await callResponder.updateCallResponderRule(auth.wid, id, body);
    res.json({ rule });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { id } = idParams.parse(req.params);
    await callResponder.deleteCallResponderRule(auth.wid, id);
    res.status(204).send();
  })
);

export { router as callResponderRulesRouter };

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as chatbotFlows from "../services/chatbot_flows.service";

const router = Router();
router.use(requireAuth);

const nodeKind = z.enum(["message", "question", "action", "condition"]);

const nodeSchema = z.object({
  name: z.string().min(1).max(200),
  kind: nodeKind,
  sortOrder: z.number().int().min(0),
  payload: z.record(z.string(), z.unknown()).optional().nullable(),
});

const createBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(""),
  deviceId: z.string().uuid(),
  triggerKeywords: z.string().min(1).max(1000),
  cooldownMinutes: z.number().int().min(0).max(10080),
  active: z.boolean(),
  nodes: z.array(nodeSchema).max(100),
});

const patchBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    deviceId: z.string().uuid().optional(),
    triggerKeywords: z.string().min(1).max(1000).optional(),
    cooldownMinutes: z.number().int().min(0).max(10080).optional(),
    active: z.boolean().optional(),
    nodes: z.array(nodeSchema).max(100).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: "At least one field is required",
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
    const flows = await chatbotFlows.listChatbotFlows(auth.wid);
    res.json({ flows });
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
    const flow = await chatbotFlows.createChatbotFlow(auth.wid, body);
    res.status(201).json({ flow });
  })
);

router.patch(
  "/:flowId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { flowId } = z.object({ flowId: z.string().uuid() }).parse(req.params);
    const body = patchBody.parse(req.body);
    const flow = await chatbotFlows.updateChatbotFlow(auth.wid, flowId, body);
    res.json({ flow });
  })
);

router.delete(
  "/:flowId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { flowId } = z.object({ flowId: z.string().uuid() }).parse(req.params);
    await chatbotFlows.deleteChatbotFlow(auth.wid, flowId);
    res.status(204).send();
  })
);

export { router as chatbotFlowsRouter };

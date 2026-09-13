import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as aiSkills from "../services/ai_skills.service";

const router = Router();
router.use(requireAuth);

const createBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  rolePrompt: z.string().min(1).max(10000),
  servicesDescription: z.string().min(1).max(10000),
  businessKnowledge: z.string().min(1).max(20000),
  customInstructions: z.string().max(10000).optional().nullable(),
  aiCredentialId: z.string().uuid().optional().nullable(),
  model: z.string().max(200).optional().nullable(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional().nullable(),
  continuousChat: z.boolean().optional(),
  active: z.boolean().optional(),
});

const patchBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional().nullable(),
    rolePrompt: z.string().min(1).max(10000).optional(),
    servicesDescription: z.string().min(1).max(10000).optional(),
    businessKnowledge: z.string().min(1).max(20000).optional(),
    customInstructions: z.string().max(10000).optional().nullable(),
    aiCredentialId: z.string().uuid().optional().nullable(),
    model: z.string().max(200).optional().nullable(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional().nullable(),
    continuousChat: z.boolean().optional(),
    active: z.boolean().optional(),
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
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const skills = await aiSkills.listAiSkills(auth.wid);
    res.json({ skills });
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const body = createBody.parse(req.body);
    const skill = await aiSkills.createAiSkill(auth.wid, body);
    res.status(201).json({ skill });
  })
);

router.get(
  "/:skillId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const { skillId } = z.object({ skillId: z.string().uuid() }).parse(req.params);
    const skill = await aiSkills.getAiSkill(auth.wid, skillId);
    res.json({ skill });
  })
);

router.patch(
  "/:skillId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const { skillId } = z.object({ skillId: z.string().uuid() }).parse(req.params);
    const body = patchBody.parse(req.body);
    const skill = await aiSkills.updateAiSkill(auth.wid, skillId, body);
    res.json({ skill });
  })
);

router.delete(
  "/:skillId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const { skillId } = z.object({ skillId: z.string().uuid() }).parse(req.params);
    await aiSkills.deleteAiSkill(auth.wid, skillId);
    res.status(204).send();
  })
);

export { router as aiSkillsRouter };

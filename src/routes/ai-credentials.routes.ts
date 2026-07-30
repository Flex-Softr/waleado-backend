import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as aiCredentials from "../services/ai_credentials.service";
import {
  AI_PROVIDERS,
  listCatalogModels,
  type AiModelTier,
} from "../config/ai-models";
import { providerFromApi } from "../services/ai_credentials.service";

const router = Router();
router.use(requireAuth);

const createBody = z.object({
  name: z.string().min(1).max(200),
  provider: z.enum(["gemini", "openrouter"]),
  apiKey: z.string().min(1).max(2000),
  model: z.string().min(1).max(200),
  apiEndpoint: z.string().max(500).optional().nullable(),
});

const patchBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    apiKey: z.string().min(1).max(2000).optional(),
    model: z.string().min(1).max(200).optional(),
    apiEndpoint: z.string().max(500).optional().nullable(),
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
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const credentials = await aiCredentials.listAiCredentials(auth.wid);
    res.json({ credentials });
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
    const credential = await aiCredentials.createAiCredential(auth.wid, body);
    res.status(201).json({ credential });
  })
);

router.patch(
  "/:credentialId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { credentialId } = z
      .object({ credentialId: z.string().uuid() })
      .parse(req.params);
    const body = patchBody.parse(req.body);
    const credential = await aiCredentials.updateAiCredential(
      auth.wid,
      credentialId,
      body
    );
    res.json({ credential });
  })
);

router.delete(
  "/:credentialId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { credentialId } = z
      .object({ credentialId: z.string().uuid() })
      .parse(req.params);
    await aiCredentials.deleteAiCredential(auth.wid, credentialId);
    res.status(204).send();
  })
);

export { router as aiCredentialsRouter };

/** Catalog routes mounted at /v1/ai */
const catalogRouter = Router();
catalogRouter.use(requireAuth);

catalogRouter.get(
  "/providers",
  asyncHandler(async (req, res) => {
    if (!req.auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    res.json({
      providers: AI_PROVIDERS.map((p) => ({
        id: p.id === "GEMINI" ? "gemini" : "openrouter",
        label: p.label,
        defaultApiEndpoint: p.baseUrl,
      })),
    });
  })
);

catalogRouter.get(
  "/models",
  asyncHandler(async (req, res) => {
    if (!req.auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const q = z
      .object({
        provider: z.enum(["gemini", "openrouter"]).optional(),
        tier: z.enum(["free", "paid"]).optional(),
      })
      .parse(req.query);

    const provider = q.provider ? providerFromApi(q.provider) : undefined;
    const tier = q.tier as AiModelTier | undefined;
    const models = listCatalogModels({ provider, tier }).map((m) => ({
      id: m.id,
      provider: m.provider === "GEMINI" ? "gemini" : "openrouter",
      label: m.label,
      tier: m.tier,
      modelId: m.modelId,
    }));
    res.json({ models });
  })
);

export { catalogRouter as aiCatalogRouter };

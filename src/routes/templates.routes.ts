import type { NextFunction, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as templates from "../services/templates.service";
import { rewriteTemplateText, TEMPLATE_AI_ACTIONS } from "../services/template_ai.service";
import {
  createTemplateMediaMulter,
  getAssetFilePath,
  listTemplateMediaAssets,
  recordUploadedTemplateFile,
} from "../services/template-media-assets.service";

const router = Router();
router.use(requireAuth);

const templateMediaUpload = createTemplateMediaMulter();

function templateMediaUploadSingle(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  templateMediaUpload.single("file")(req, res, (err) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(new AppError(413, "File too large (max 16 MB)", "VALIDATION"));
        return;
      }
      next(new AppError(400, err.message, "VALIDATION"));
      return;
    }
    next(err);
  });
}

const interactiveKind = z.enum([
  "quick_reply",
  "cta_url",
  "cta_phone",
  "copy_code",
]);

const buttonSchema = z.object({
  id: z.string().min(1).max(64),
  kind: interactiveKind,
  label: z.string().min(1).max(200),
});

const libraryFields = {
  tags: z.array(z.string().max(60)).max(20).optional(),
  versions: z.array(z.string().max(4096)).max(10).optional(),
  variables: z.array(z.object({ key: z.string().max(40), value: z.string().max(300) })).max(30).optional(),
  showIn: z.array(z.string().max(30)).max(10).optional(),
};

const createBody = z.object({
  ...libraryFields,
  name: z.string().min(1).max(200),
  /** Folder name (free text; empty → "general"). */
  category: z.string().max(60).optional(),
  typeId: z.string().min(1).max(64),
  content: z.string().max(4096).optional(),
  footer: z.string().max(500).optional().nullable(),
  buttons: z.array(buttonSchema).max(5).optional(),
  /** Type-specific JSON (file id, URLs, location, poll options, list rows, …). */
  media: z.record(z.string(), z.unknown()).optional(),
  waTemplateName: z.string().min(1).max(200).optional(),
  language: z.string().max(16).optional(),
});

const patchBody = z.object({
  ...libraryFields,
  name: z.string().min(1).max(200).optional(),
  category: z.string().max(60).optional(),
  content: z.string().max(4096).optional(),
  footer: z.string().max(500).optional().nullable(),
  buttons: z.array(buttonSchema).max(5).optional(),
  media: z.record(z.string(), z.unknown()).optional(),
  language: z.string().max(16).optional(),
  active: z.boolean().optional(),
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
  "/media",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const assets = await listTemplateMediaAssets(auth.wid);
    res.json({ assets });
  })
);

router.post(
  "/media",
  templateMediaUploadSingle,
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const file = req.file;
    if (!file) {
      throw new AppError(400, "Missing file (use field name \"file\")", "VALIDATION");
    }
    const meta = await recordUploadedTemplateFile(auth.wid, file);
    res.status(201).json(meta);
  })
);

router.get(
  "/media/:id",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const result = await getAssetFilePath(auth.wid, req.params.id);
    if (!result) {
      throw new AppError(404, "File not found", "NOT_FOUND");
    }
    res.setHeader("Content-Type", result.mimeType || "application/octet-stream");
    res.sendFile(result.absolutePath);
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const list = await templates.listTemplates(auth.wid);
    res.json({ templates: list });
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
    const row = await templates.createTemplate(auth.wid, {
      name: body.name,
      category: body.category ?? "general",
      typeId: body.typeId,
      content: body.content ?? "",
      footer: body.footer,
      buttons: body.buttons,
      media: body.media,
      waTemplateName: body.waTemplateName,
      language: body.language,
      tags: body.tags,
      versions: body.versions,
      variables: body.variables,
      showIn: body.showIn,
    });
    res.status(201).json({ template: row });
  })
);

const aiBody = z.object({
  action: z.enum(TEMPLATE_AI_ACTIONS),
  text: z.string().max(4096).optional(),
  prompt: z.string().max(1000).optional(),
  avoid: z.array(z.string().max(4096)).max(5).optional(),
});

router.post(
  "/ai",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    res.json(await rewriteTemplateText(auth.wid, aiBody.parse(req.body)));
  })
);

router.get(
  "/examples",
  asyncHandler(async (_req, res) => {
    res.json({
      examples: templates.TEMPLATE_EXAMPLES.map((e) => ({
        key: e.key,
        name: e.name,
        category: e.category,
        body: e.body,
        versions: e.versions.length + 1,
      })),
    });
  })
);

router.post(
  "/examples",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const { keys } = z.object({ keys: z.array(z.string().max(60)).min(1).max(20) }).parse(req.body);
    res.status(201).json({ templates: await templates.addTemplateExamples(auth.wid, keys) });
  })
);

router.post(
  "/:id/duplicate",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const { id } = idParams.parse(req.params);
    res.status(201).json({ template: await templates.duplicateTemplate(auth.wid, id) });
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
    const row = await templates.updateTemplate(auth.wid, id, body);
    res.json({ template: row });
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
    await templates.deleteTemplate(auth.wid, id);
    res.status(204).send();
  })
);

export { router as templatesRouter };

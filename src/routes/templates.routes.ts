import type { NextFunction, Response } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as templates from "../services/templates.service";
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

const createBody = z.object({
  name: z.string().min(1).max(200),
  category: z.enum(["general", "marketing", "transactional", "utility"]),
  typeId: z.string().min(1).max(64),
  content: z.string().min(1).max(4096),
  footer: z.string().max(500).optional().nullable(),
  buttons: z.array(buttonSchema).max(5).optional(),
  /** Type-specific JSON (file id, URLs, location, poll options, list rows, …). */
  media: z.record(z.string(), z.unknown()).optional(),
  waTemplateName: z.string().min(1).max(200).optional(),
  language: z.string().max(16).optional(),
});

const patchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  category: z.enum(["general", "marketing", "transactional", "utility"]).optional(),
  content: z.string().min(1).max(4096).optional(),
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
      category: body.category,
      typeId: body.typeId,
      content: body.content,
      footer: body.footer,
      buttons: body.buttons,
      media: body.media,
      waTemplateName: body.waTemplateName,
      language: body.language,
    });
    res.status(201).json({ template: row });
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

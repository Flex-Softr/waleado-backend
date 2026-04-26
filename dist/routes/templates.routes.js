"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.templatesRouter = void 0;
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const zod_1 = require("zod");
const errors_1 = require("../lib/errors");
const auth_1 = require("../middleware/auth");
const templates = __importStar(require("../services/templates.service"));
const template_media_assets_service_1 = require("../services/template-media-assets.service");
const router = (0, express_1.Router)();
exports.templatesRouter = router;
router.use(auth_1.requireAuth);
const templateMediaUpload = (0, template_media_assets_service_1.createTemplateMediaMulter)();
function templateMediaUploadSingle(req, res, next) {
    templateMediaUpload.single("file")(req, res, (err) => {
        if (!err) {
            next();
            return;
        }
        if (err instanceof multer_1.default.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
                next(new errors_1.AppError(413, "File too large (max 16 MB)", "VALIDATION"));
                return;
            }
            next(new errors_1.AppError(400, err.message, "VALIDATION"));
            return;
        }
        next(err);
    });
}
const interactiveKind = zod_1.z.enum([
    "quick_reply",
    "cta_url",
    "cta_phone",
    "copy_code",
]);
const buttonSchema = zod_1.z.object({
    id: zod_1.z.string().min(1).max(64),
    kind: interactiveKind,
    label: zod_1.z.string().min(1).max(200),
});
const createBody = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
    category: zod_1.z.enum(["general", "marketing", "transactional", "utility"]),
    typeId: zod_1.z.string().min(1).max(64),
    content: zod_1.z.string().min(1).max(4096),
    footer: zod_1.z.string().max(500).optional().nullable(),
    buttons: zod_1.z.array(buttonSchema).max(5).optional(),
    /** Type-specific JSON (file id, URLs, location, poll options, list rows, …). */
    media: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
    waTemplateName: zod_1.z.string().min(1).max(200).optional(),
    language: zod_1.z.string().max(16).optional(),
});
const patchBody = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200).optional(),
    category: zod_1.z.enum(["general", "marketing", "transactional", "utility"]).optional(),
    content: zod_1.z.string().min(1).max(4096).optional(),
    footer: zod_1.z.string().max(500).optional().nullable(),
    buttons: zod_1.z.array(buttonSchema).max(5).optional(),
    media: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
    language: zod_1.z.string().max(16).optional(),
    active: zod_1.z.boolean().optional(),
});
const idParams = zod_1.z.object({ id: zod_1.z.string().uuid() });
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res)).catch(next);
    };
}
router.get("/media", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const assets = await (0, template_media_assets_service_1.listTemplateMediaAssets)(auth.wid);
    res.json({ assets });
}));
router.post("/media", templateMediaUploadSingle, asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const file = req.file;
    if (!file) {
        throw new errors_1.AppError(400, "Missing file (use field name \"file\")", "VALIDATION");
    }
    const meta = await (0, template_media_assets_service_1.recordUploadedTemplateFile)(auth.wid, file);
    res.status(201).json(meta);
}));
router.get("/media/:id", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const result = await (0, template_media_assets_service_1.getAssetFilePath)(auth.wid, req.params.id);
    if (!result) {
        throw new errors_1.AppError(404, "File not found", "NOT_FOUND");
    }
    res.setHeader("Content-Type", result.mimeType || "application/octet-stream");
    res.sendFile(result.absolutePath);
}));
router.get("/", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const list = await templates.listTemplates(auth.wid);
    res.json({ templates: list });
}));
router.post("/", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
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
}));
router.patch("/:id", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { id } = idParams.parse(req.params);
    const body = patchBody.parse(req.body);
    const row = await templates.updateTemplate(auth.wid, id, body);
    res.json({ template: row });
}));
router.delete("/:id", asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
        throw new errors_1.AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { id } = idParams.parse(req.params);
    await templates.deleteTemplate(auth.wid, id);
    res.status(204).send();
}));

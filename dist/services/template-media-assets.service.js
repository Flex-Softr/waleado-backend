"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTemplateMediaRoot = getTemplateMediaRoot;
exports.createTemplateMediaMulter = createTemplateMediaMulter;
exports.recordUploadedTemplateFile = recordUploadedTemplateFile;
exports.recordTemplateMediaBuffer = recordTemplateMediaBuffer;
exports.listTemplateMediaAssets = listTemplateMediaAssets;
exports.getAssetFilePath = getAssetFilePath;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const multer_1 = __importDefault(require("multer"));
const env_1 = require("../env");
const prisma_1 = require("../lib/prisma");
function getTemplateMediaRoot() {
    return env_1.env.TEMPLATE_MEDIA_ROOT;
}
function createTemplateMediaMulter() {
    const root = getTemplateMediaRoot();
    return (0, multer_1.default)({
        storage: multer_1.default.diskStorage({
            destination: (req, _file, cb) => {
                const wid = req.auth?.wid;
                if (!wid) {
                    cb(new Error("Unauthorized"), "");
                    return;
                }
                const dir = path_1.default.join(root, wid);
                fs_1.default.mkdirSync(dir, { recursive: true });
                cb(null, dir);
            },
            filename: (_req, file, cb) => {
                const ext = path_1.default.extname(file.originalname).slice(0, 24) || "";
                cb(null, `${crypto_1.default.randomUUID()}${ext}`);
            },
        }),
        limits: { fileSize: 16 * 1024 * 1024 },
    });
}
async function recordUploadedTemplateFile(workspaceId, file) {
    const row = await prisma_1.prisma.templateMediaAsset.create({
        data: {
            workspaceId,
            fileName: file.filename,
            mimeType: file.mimetype.slice(0, 200),
            originalName: path_1.default.basename(file.originalname).slice(0, 500),
            byteSize: file.size,
        },
    });
    return {
        id: row.id,
        mimeType: row.mimeType,
        originalName: row.originalName,
        byteSize: row.byteSize,
    };
}
async function recordTemplateMediaBuffer(workspaceId, input) {
    const root = getTemplateMediaRoot();
    const dir = path_1.default.join(root, workspaceId);
    fs_1.default.mkdirSync(dir, { recursive: true });
    const ext = path_1.default.extname(input.originalName).slice(0, 24);
    const fileName = `${crypto_1.default.randomUUID()}${ext}`;
    const abs = path_1.default.join(dir, fileName);
    fs_1.default.writeFileSync(abs, input.buffer);
    const row = await prisma_1.prisma.templateMediaAsset.create({
        data: {
            workspaceId,
            fileName,
            mimeType: input.mimeType.slice(0, 200),
            originalName: path_1.default.basename(input.originalName).slice(0, 500),
            byteSize: input.buffer.byteLength,
        },
    });
    return {
        id: row.id,
        mimeType: row.mimeType,
        originalName: row.originalName,
        byteSize: row.byteSize,
    };
}
async function listTemplateMediaAssets(workspaceId) {
    const rows = await prisma_1.prisma.templateMediaAsset.findMany({
        where: { workspaceId },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
            id: true,
            mimeType: true,
            originalName: true,
            byteSize: true,
            createdAt: true,
        },
    });
    return rows.map((r) => ({
        id: r.id,
        mimeType: r.mimeType,
        originalName: r.originalName,
        byteSize: r.byteSize,
        createdAt: r.createdAt.toISOString(),
    }));
}
async function getAssetFilePath(workspaceId, assetId) {
    const asset = await prisma_1.prisma.templateMediaAsset.findFirst({
        where: { id: assetId, workspaceId },
    });
    if (!asset)
        return null;
    const base = path_1.default.resolve(path_1.default.join(getTemplateMediaRoot(), workspaceId));
    const safeName = path_1.default.basename(asset.fileName);
    const absolutePath = path_1.default.resolve(path_1.default.join(base, safeName));
    const rel = path_1.default.relative(base, absolutePath);
    if (rel.startsWith("..") || path_1.default.isAbsolute(rel)) {
        return null;
    }
    if (!fs_1.default.existsSync(absolutePath))
        return null;
    return {
        absolutePath,
        mimeType: asset.mimeType,
        originalName: asset.originalName,
    };
}

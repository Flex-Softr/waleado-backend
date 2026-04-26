import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Request } from "express";
import multer from "multer";

import { env } from "../env";
import { prisma } from "../lib/prisma";
import type { AuthedRequest } from "../middleware/auth";

export function getTemplateMediaRoot(): string {
  return env.TEMPLATE_MEDIA_ROOT;
}

export function createTemplateMediaMulter(): multer.Multer {
  const root = getTemplateMediaRoot();
  return multer({
    storage: multer.diskStorage({
      destination: (req: Request, _file, cb) => {
        const wid = (req as AuthedRequest).auth?.wid;
        if (!wid) {
          cb(new Error("Unauthorized"), "");
          return;
        }
        const dir = path.join(root, wid);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).slice(0, 24) || "";
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    limits: { fileSize: 16 * 1024 * 1024 },
  });
}

export async function recordUploadedTemplateFile(
  workspaceId: string,
  file: Express.Multer.File
): Promise<{
  id: string;
  mimeType: string;
  originalName: string;
  byteSize: number;
}> {
  const row = await prisma.templateMediaAsset.create({
    data: {
      workspaceId,
      fileName: file.filename,
      mimeType: file.mimetype.slice(0, 200),
      originalName: path.basename(file.originalname).slice(0, 500),
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

export async function recordTemplateMediaBuffer(
  workspaceId: string,
  input: {
    buffer: Buffer;
    mimeType: string;
    originalName: string;
  }
): Promise<{
  id: string;
  mimeType: string;
  originalName: string;
  byteSize: number;
}> {
  const root = getTemplateMediaRoot();
  const dir = path.join(root, workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(input.originalName).slice(0, 24);
  const fileName = `${crypto.randomUUID()}${ext}`;
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, input.buffer);
  const row = await prisma.templateMediaAsset.create({
    data: {
      workspaceId,
      fileName,
      mimeType: input.mimeType.slice(0, 200),
      originalName: path.basename(input.originalName).slice(0, 500),
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

export async function listTemplateMediaAssets(workspaceId: string): Promise<
  {
    id: string;
    mimeType: string;
    originalName: string;
    byteSize: number;
    createdAt: string;
  }[]
> {
  const rows = await prisma.templateMediaAsset.findMany({
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

export async function getAssetFilePath(
  workspaceId: string,
  assetId: string
): Promise<{
  absolutePath: string;
  mimeType: string;
  originalName: string;
} | null> {
  const asset = await prisma.templateMediaAsset.findFirst({
    where: { id: assetId, workspaceId },
  });
  if (!asset) return null;
  const base = path.resolve(path.join(getTemplateMediaRoot(), workspaceId));
  const safeName = path.basename(asset.fileName);
  const absolutePath = path.resolve(path.join(base, safeName));
  const rel = path.relative(base, absolutePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  if (!fs.existsSync(absolutePath)) return null;
  return {
    absolutePath,
    mimeType: asset.mimeType,
    originalName: asset.originalName,
  };
}

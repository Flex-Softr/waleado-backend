import { Router } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { requireAuth, type AuthedRequest } from "../middleware/auth";
import * as liveChat from "../services/live_chat.service";
import { getAssetFilePath } from "../services/template-media-assets.service";
import { verifyLiveChatMediaToken } from "../services/live_chat_media_sign.service";

const router = Router();

router.get(
  "/media/:assetId",
  asyncHandler(async (req, res) => {
    const { assetId } = z.object({ assetId: z.string().uuid() }).parse(req.params);
    const { wid, exp, sig } = z
      .object({
        wid: z.string().uuid(),
        exp: z.string(),
        sig: z.string().min(16),
      })
      .parse(req.query);
    const ok = verifyLiveChatMediaToken({ workspaceId: wid, assetId, exp, sig });
    if (!ok) {
      throw new AppError(401, "Invalid or expired media token", "UNAUTHORIZED");
    }
    const result = await getAssetFilePath(wid, assetId);
    if (!result) {
      throw new AppError(404, "File not found", "NOT_FOUND");
    }
    res.setHeader("Content-Type", result.mimeType || "application/octet-stream");
    res.sendFile(result.absolutePath);
  })
);

router.use(requireAuth);

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
  "/threads",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { deviceId } = z
      .object({ deviceId: z.string().uuid() })
      .parse(req.query);
    const threads = await liveChat.listLiveChatThreads(auth.wid, deviceId);
    res.json({ threads });
  })
);

router.post(
  "/threads",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const body = z
      .object({
        deviceId: z.string().uuid(),
        peerPhone: z.string().min(3),
        peerLabel: z.string().max(200).optional(),
      })
      .parse(req.body);
    const thread = await liveChat.createLiveChatThread(auth.wid, body);
    res.status(201).json({ thread });
  })
);

router.patch(
  "/threads/:threadId",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { threadId } = z
      .object({ threadId: z.string().uuid() })
      .parse(req.params);
    const body = z
      .object({
        peerLabel: z.string().max(200).optional(),
      })
      .refine((o) => Object.keys(o).length > 0, {
        message: "At least one field is required",
      })
      .parse(req.body);
    const thread = await liveChat.updateLiveChatThread(auth.wid, threadId, body);
    res.json({ thread });
  })
);

router.get(
  "/threads/:threadId/messages",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { threadId } = z
      .object({ threadId: z.string().uuid() })
      .parse(req.params);
    const query = z
      .object({
        cursor: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .parse(req.query);
    const page = await liveChat.listLiveChatMessages(auth.wid, threadId, {
      cursor: query.cursor,
      limit: query.limit,
    });
    res.json(page);
  })
);

router.post(
  "/threads/:threadId/messages",
  asyncHandler(async (req, res) => {
    const auth = req.auth;
    if (!auth) {
      throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    }
    const { threadId } = z
      .object({ threadId: z.string().uuid() })
      .parse(req.params);
    const body = z
      .object({
        bodyText: z.string().max(4096).optional(),
        mediaAssetId: z.string().uuid().optional(),
      })
      .refine((v) => Boolean(v.bodyText?.trim()) || Boolean(v.mediaAssetId), {
        message: "Message text or media is required",
      })
      .parse(req.body);
    const result = await liveChat.sendLiveChatMessage(
      auth.wid,
      threadId,
      { bodyText: body.bodyText, mediaAssetId: body.mediaAssetId }
    );
    res.status(201).json(result);
  })
);

export { router as liveChatRouter };

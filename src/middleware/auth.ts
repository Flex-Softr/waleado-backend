import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, type AccessPayload } from "../lib/jwt";
import { AppError } from "../lib/errors";
import { prisma } from "../lib/prisma";

export type AuthedRequest = Request & { auth?: AccessPayload };

/**
 * Re-checks the token's claims against the database so that blocking a user,
 * changing their platform role, or removing their workspace membership takes
 * effect immediately instead of when the access token expires.
 */
async function assertTokenStillValid(payload: AccessPayload): Promise<void> {
  const membership = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: payload.sub, workspaceId: payload.wid } },
    select: {
      role: true,
      user: { select: { role: true, blockedAt: true } },
    },
  });

  if (!membership) {
    throw new AppError(401, "Session is no longer valid", "TOKEN_INVALID");
  }
  if (membership.user.blockedAt) {
    throw new AppError(
      403,
      "This account has been blocked. Contact support.",
      "ACCOUNT_BLOCKED"
    );
  }
  if (
    membership.user.role !== payload.userRole ||
    membership.role !== payload.role
  ) {
    // Role changed since the token was issued: force a refresh to get fresh claims.
    throw new AppError(401, "Session is no longer valid", "TOKEN_INVALID");
  }
}

export function requireAuth(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction
): void {
  if (req.auth) {
    next();
    return;
  }
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(new AppError(401, "Missing or invalid authorization header", "UNAUTHORIZED"));
    return;
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    next(new AppError(401, "Missing access token", "UNAUTHORIZED"));
    return;
  }

  let payload: AccessPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    next(new AppError(401, "Invalid or expired access token", "TOKEN_INVALID"));
    return;
  }

  assertTokenStillValid(payload)
    .then(() => {
      req.auth = payload;
      next();
    })
    .catch(next);
}

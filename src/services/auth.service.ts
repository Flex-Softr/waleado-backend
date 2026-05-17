import type { MembershipRole, User } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { hashRefreshToken, generateRefreshToken } from "../lib/crypto-token";
import { hashPassword, verifyPassword } from "../lib/password";
import { signAccessToken } from "../lib/jwt";
import { AppError } from "../lib/errors";
import { env } from "../env";
import { randomUUID } from "crypto";

export type SafeUser = {
  id: string;
  email: string;
  name: string | null;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  role: MembershipRole;
};

export type AuthResponse = {
  user: SafeUser;
  workspace: WorkspaceSummary;
  accessToken: string;
};

async function pickPrimaryMembership(userId: string) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length === 0) return null;
  const owner = memberships.find((m) => m.role === "OWNER");
  const m = owner ?? memberships[0];
  return {
    role: m.role,
    workspace: m.workspace,
  };
}

function toSafeUser(user: User): SafeUser {
  return { id: user.id, email: user.email, name: user.name };
}

async function issueSession(
  user: User
): Promise<{ response: AuthResponse; rawRefresh: string }> {
  const primary = await pickPrimaryMembership(user.id);
  if (!primary) {
    throw new AppError(500, "User has no workspace", "NO_WORKSPACE");
  }

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    wid: primary.workspace.id,
    role: primary.role,
  });

  const rawRefresh = generateRefreshToken();
  const hashed = hashRefreshToken(rawRefresh);
  const expiresAt = new Date(
    Date.now() + env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000
  );

  await prisma.refreshToken.create({
    data: {
      hashedToken: hashed,
      userId: user.id,
      expiresAt,
    },
  });

  return {
    rawRefresh,
    response: {
      user: toSafeUser(user),
      workspace: {
        id: primary.workspace.id,
        name: primary.workspace.name,
        slug: primary.workspace.slug,
        role: primary.role,
      },
      accessToken,
    },
  };
}

export async function registerUser(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<AuthResponse & { rawRefresh: string }> {
  const email = input.email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, "Email already registered", "EMAIL_TAKEN");
  }

  const passwordHash = await hashPassword(input.password);
  const slug = `ws-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const workspaceName = input.name
    ? `${input.name}'s workspace`
    : "My workspace";

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email,
        passwordHash,
        name: input.name?.trim() || null,
      },
    });
    const ws = await tx.workspace.create({
      data: {
        name: workspaceName,
        slug,
      },
    });
    await tx.membership.create({
      data: {
        userId: u.id,
        workspaceId: ws.id,
        role: "OWNER",
      },
    });
    return u;
  });

  const { response, rawRefresh } = await issueSession(user);
  return { ...response, rawRefresh };
}

export async function loginUser(input: {
  email: string;
  password: string;
}): Promise<AuthResponse & { rawRefresh: string }> {
  const email = input.email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
  }
  if (!user.passwordHash) {
    throw new AppError(
      401,
      "This account uses Google sign-in",
      "USE_GOOGLE_AUTH"
    );
  }
  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) {
    throw new AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
  }

  const { response, rawRefresh } = await issueSession(user);
  return { ...response, rawRefresh };
}

export async function signInOrRegisterGoogleUser(input: {
  googleSub: string;
  email: string;
  name?: string | null;
}): Promise<AuthResponse & { rawRefresh: string }> {
  const email = input.email.toLowerCase().trim();

  let user = await prisma.user.findUnique({
    where: { googleId: input.googleSub },
  });

  if (!user) {
    user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      if (user.googleId && user.googleId !== input.googleSub) {
        throw new AppError(
          409,
          "This email is linked to a different Google account",
          "GOOGLE_LINK_MISMATCH"
        );
      }
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId: input.googleSub,
          name:
            user.name ??
            (input.name?.trim() ? input.name.trim() : undefined),
        },
      });
    }
  }

  if (!user) {
    const slug = `ws-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const workspaceName = input.name?.trim()
      ? `${input.name.trim()}'s workspace`
      : "My workspace";

    user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email,
          passwordHash: null,
          googleId: input.googleSub,
          name: input.name?.trim() || null,
        },
      });
      const ws = await tx.workspace.create({
        data: {
          name: workspaceName,
          slug,
        },
      });
      await tx.membership.create({
        data: {
          userId: u.id,
          workspaceId: ws.id,
          role: "OWNER",
        },
      });
      return u;
    });
  }

  const { response, rawRefresh } = await issueSession(user);
  return { ...response, rawRefresh };
}

export async function refreshSession(rawCookie: string | undefined): Promise<{
  response: AuthResponse;
  rawRefresh: string;
}> {
  if (!rawCookie) {
    throw new AppError(401, "Missing refresh session", "NO_REFRESH");
  }

  const hashed = hashRefreshToken(rawCookie);
  const record = await prisma.refreshToken.findUnique({
    where: { hashedToken: hashed },
    include: { user: true },
  });

  if (
    !record ||
    record.revokedAt ||
    record.expiresAt.getTime() < Date.now()
  ) {
    throw new AppError(401, "Invalid or expired session", "REFRESH_INVALID");
  }

  const user = record.user;

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    }),
  ]);

  const issued = await issueSession(user);
  return issued;
}

export async function logoutSession(rawCookie: string | undefined): Promise<void> {
  if (!rawCookie) return;
  const hashed = hashRefreshToken(rawCookie);
  await prisma.refreshToken.updateMany({
    where: { hashedToken: hashed, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function logoutAllSessions(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getMeForUser(userId: string, workspaceId: string) {
  const membership = await prisma.membership.findUnique({
    where: {
      userId_workspaceId: { userId, workspaceId },
    },
    include: { user: true, workspace: true },
  });
  if (!membership) {
    throw new AppError(403, "No access to this workspace", "FORBIDDEN");
  }
  return {
    user: toSafeUser(membership.user),
    workspace: {
      id: membership.workspace.id,
      name: membership.workspace.name,
      slug: membership.workspace.slug,
      role: membership.role,
    },
  };
}

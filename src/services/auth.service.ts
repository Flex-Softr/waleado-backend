import type { MembershipRole, User, UserRole } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  hashRefreshToken,
  generateRefreshToken,
} from "../lib/crypto-token";
import { hashPassword, verifyPassword } from "../lib/password";
import { signAccessToken } from "../lib/jwt";
import { AppError } from "../lib/errors";
import { validateAndFormatPhone } from "../lib/phone";
import { env } from "../env";
import { randomUUID } from "crypto";
import { sendPasswordResetEmail } from "./mail.service";
import { ensureTrialStarted, TRIAL_DURATION_MS } from "./billing.service";

export type SafeUser = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  role: UserRole;
  hasPassword?: boolean;
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
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone ?? null,
    role: user.role,
    hasPassword: Boolean(user.passwordHash),
  };
}

function assertUserNotBlocked(user: User): void {
  if (user.blockedAt) {
    throw new AppError(
      403,
      "This account has been blocked. Contact support.",
      "ACCOUNT_BLOCKED"
    );
  }
}

async function issueSession(
  user: User
): Promise<{ response: AuthResponse; rawRefresh: string }> {
  assertUserNotBlocked(user);
  const primary = await pickPrimaryMembership(user.id);
  if (!primary) {
    throw new AppError(500, "User has no workspace", "NO_WORKSPACE");
  }

  const accessToken = signAccessToken({
    sub: user.id,
    email: user.email,
    wid: primary.workspace.id,
    role: primary.role,
    userRole: user.role,
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

  await ensureTrialStarted(user.id, primary.workspace.id);

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
  phone?: string | null;
}): Promise<AuthResponse & { rawRefresh: string }> {
  const email = input.email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, "Email already registered", "EMAIL_TAKEN");
  }

  let formattedPhone: string | null = null;
  if (input.phone && input.phone.trim()) {
    const v = validateAndFormatPhone(input.phone);
    if (!v.valid) {
      throw new AppError(400, v.message, "INVALID_PHONE");
    }
    formattedPhone = v.e164;
  }

  const passwordHash = await hashPassword(input.password);
  const slug = `ws-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const workspaceName = input.name
    ? `${input.name}'s workspace`
    : "My workspace";

  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_DURATION_MS);

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email,
        passwordHash,
        name: input.name?.trim() || null,
        phone: formattedPhone,
        trialUsed: true,
        trialStartedAt: now,
        trialEndsAt,
      },
    });
    const ws = await tx.workspace.create({
      data: {
        name: workspaceName,
        slug,
        trialUsed: true,
        trialStartedAt: now,
        trialEndsAt,
        subscriptionStatus: "trialing",
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

export async function requestPasswordReset(input: {
  email: string;
}): Promise<{ ok: true; resetUrl?: string; emailDelivered?: boolean }> {
  const email = input.email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || !user.passwordHash) {
    return { ok: true };
  }

  await prisma.passwordResetToken.updateMany({
    where: {
      userId: user.id,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { usedAt: new Date() },
  });

  const rawToken = generatePasswordResetToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      hashedToken: hashPasswordResetToken(rawToken),
      expiresAt: new Date(
        Date.now() + env.PASSWORD_RESET_TOKEN_MINUTES * 60 * 1000
      ),
    },
  });

  const resetUrl = `${env.APP_PUBLIC_URL.replace(
    /\/$/,
    ""
  )}/login?resetToken=${encodeURIComponent(rawToken)}`;
  const mail = await sendPasswordResetEmail({
    to: user.email,
    resetUrl,
    expiresMinutes: env.PASSWORD_RESET_TOKEN_MINUTES,
  });

  return {
    ok: true,
    // Never expose reset tokens outside local development.
    ...(env.NODE_ENV === "development" && !mail.delivered ? { resetUrl } : {}),
    emailDelivered: mail.delivered,
  };
}

export async function resetPassword(input: {
  token: string;
  password: string;
}): Promise<{ ok: true }> {
  const hashedToken = hashPasswordResetToken(input.token.trim());
  const record = await prisma.passwordResetToken.findUnique({
    where: { hashedToken },
    include: { user: true },
  });

  if (
    !record ||
    record.usedAt ||
    record.expiresAt.getTime() < Date.now()
  ) {
    throw new AppError(
      400,
      "This password reset link is invalid or expired",
      "RESET_TOKEN_INVALID"
    );
  }

  const passwordHash = await hashPassword(input.password);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.passwordResetToken.updateMany({
      where: {
        userId: record.userId,
        id: { not: record.id },
        usedAt: null,
      },
      data: { usedAt: new Date() },
    }),
  ]);

  return { ok: true };
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

    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + TRIAL_DURATION_MS);

    user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email,
          passwordHash: null,
          googleId: input.googleSub,
          name: input.name?.trim() || null,
          trialUsed: true,
          trialStartedAt: now,
          trialEndsAt,
        },
      });
      const ws = await tx.workspace.create({
        data: {
          name: workspaceName,
          slug,
          trialUsed: true,
          trialStartedAt: now,
          trialEndsAt,
          subscriptionStatus: "trialing",
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

export async function updateMeForUser(
  userId: string,
  workspaceId: string,
  input: {
    name?: string | null;
    phone?: string | null;
  }
) {
  const membership = await prisma.membership.findUnique({
    where: {
      userId_workspaceId: { userId, workspaceId },
    },
    include: { user: true, workspace: true },
  });
  if (!membership) {
    throw new AppError(403, "No access to this workspace", "FORBIDDEN");
  }

  const updateData: { name?: string | null; phone?: string | null } = {};
  if (input.name !== undefined) {
    updateData.name = input.name ? input.name.trim() : null;
  }
  if (input.phone !== undefined) {
    if (input.phone && input.phone.trim()) {
      const v = validateAndFormatPhone(input.phone);
      if (!v.valid) {
        throw new AppError(400, v.message, "INVALID_PHONE");
      }
      updateData.phone = v.e164;
    } else {
      updateData.phone = null;
    }
  }

  const updatedUser =
    Object.keys(updateData).length > 0
      ? await prisma.user.update({
          where: { id: userId },
          data: updateData,
        })
      : membership.user;

  return {
    user: toSafeUser(updatedUser),
    workspace: {
      id: membership.workspace.id,
      name: membership.workspace.name,
      slug: membership.workspace.slug,
      role: membership.role,
    },
  };
}

export async function changePasswordForUser(
  userId: string,
  input: {
    currentPassword?: string;
    newPassword: string;
  }
) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (!user) {
    throw new AppError(404, "User not found", "USER_NOT_FOUND");
  }
  assertUserNotBlocked(user);

  if (user.passwordHash) {
    if (!input.currentPassword) {
      throw new AppError(
        400,
        "Current password is required",
        "CURRENT_PASSWORD_REQUIRED"
      );
    }
    const matches = await verifyPassword(
      input.currentPassword,
      user.passwordHash
    );
    if (!matches) {
      throw new AppError(
        400,
        "Current password is incorrect",
        "INVALID_CURRENT_PASSWORD"
      );
    }
  }

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });

  return { ok: true, message: "Password updated successfully" };
}



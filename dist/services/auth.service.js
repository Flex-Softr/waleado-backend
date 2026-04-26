"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUser = registerUser;
exports.loginUser = loginUser;
exports.refreshSession = refreshSession;
exports.logoutSession = logoutSession;
exports.logoutAllSessions = logoutAllSessions;
exports.getMeForUser = getMeForUser;
const prisma_1 = require("../lib/prisma");
const crypto_token_1 = require("../lib/crypto-token");
const password_1 = require("../lib/password");
const jwt_1 = require("../lib/jwt");
const errors_1 = require("../lib/errors");
const env_1 = require("../env");
const crypto_1 = require("crypto");
async function pickPrimaryMembership(userId) {
    const memberships = await prisma_1.prisma.membership.findMany({
        where: { userId },
        include: { workspace: true },
        orderBy: { createdAt: "asc" },
    });
    if (memberships.length === 0)
        return null;
    const owner = memberships.find((m) => m.role === "OWNER");
    const m = owner ?? memberships[0];
    return {
        role: m.role,
        workspace: m.workspace,
    };
}
function toSafeUser(user) {
    return { id: user.id, email: user.email, name: user.name };
}
async function issueSession(user) {
    const primary = await pickPrimaryMembership(user.id);
    if (!primary) {
        throw new errors_1.AppError(500, "User has no workspace", "NO_WORKSPACE");
    }
    const accessToken = (0, jwt_1.signAccessToken)({
        sub: user.id,
        email: user.email,
        wid: primary.workspace.id,
        role: primary.role,
    });
    const rawRefresh = (0, crypto_token_1.generateRefreshToken)();
    const hashed = (0, crypto_token_1.hashRefreshToken)(rawRefresh);
    const expiresAt = new Date(Date.now() + env_1.env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
    await prisma_1.prisma.refreshToken.create({
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
async function registerUser(input) {
    const email = input.email.toLowerCase().trim();
    const existing = await prisma_1.prisma.user.findUnique({ where: { email } });
    if (existing) {
        throw new errors_1.AppError(409, "Email already registered", "EMAIL_TAKEN");
    }
    const passwordHash = await (0, password_1.hashPassword)(input.password);
    const slug = `ws-${(0, crypto_1.randomUUID)().replace(/-/g, "").slice(0, 12)}`;
    const workspaceName = input.name
        ? `${input.name}'s workspace`
        : "My workspace";
    const user = await prisma_1.prisma.$transaction(async (tx) => {
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
async function loginUser(input) {
    const email = input.email.toLowerCase().trim();
    const user = await prisma_1.prisma.user.findUnique({ where: { email } });
    if (!user) {
        throw new errors_1.AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
    }
    const ok = await (0, password_1.verifyPassword)(input.password, user.passwordHash);
    if (!ok) {
        throw new errors_1.AppError(401, "Invalid email or password", "INVALID_CREDENTIALS");
    }
    const { response, rawRefresh } = await issueSession(user);
    return { ...response, rawRefresh };
}
async function refreshSession(rawCookie) {
    if (!rawCookie) {
        throw new errors_1.AppError(401, "Missing refresh session", "NO_REFRESH");
    }
    const hashed = (0, crypto_token_1.hashRefreshToken)(rawCookie);
    const record = await prisma_1.prisma.refreshToken.findUnique({
        where: { hashedToken: hashed },
        include: { user: true },
    });
    if (!record ||
        record.revokedAt ||
        record.expiresAt.getTime() < Date.now()) {
        throw new errors_1.AppError(401, "Invalid or expired session", "REFRESH_INVALID");
    }
    const user = record.user;
    await prisma_1.prisma.$transaction([
        prisma_1.prisma.refreshToken.update({
            where: { id: record.id },
            data: { revokedAt: new Date() },
        }),
    ]);
    const issued = await issueSession(user);
    return issued;
}
async function logoutSession(rawCookie) {
    if (!rawCookie)
        return;
    const hashed = (0, crypto_token_1.hashRefreshToken)(rawCookie);
    await prisma_1.prisma.refreshToken.updateMany({
        where: { hashedToken: hashed, revokedAt: null },
        data: { revokedAt: new Date() },
    });
}
async function logoutAllSessions(userId) {
    await prisma_1.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
    });
}
async function getMeForUser(userId, workspaceId) {
    const membership = await prisma_1.prisma.membership.findUnique({
        where: {
            userId_workspaceId: { userId, workspaceId },
        },
        include: { user: true, workspace: true },
    });
    if (!membership) {
        throw new errors_1.AppError(403, "No access to this workspace", "FORBIDDEN");
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

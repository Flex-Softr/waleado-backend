import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import {
  generateApiClientId,
  generateApiClientSecret,
  hashApiClientSecret,
  verifyApiClientSecret,
} from "../lib/crypto-token";

export type ApiCredentialPublicJson = {
  id: string;
  name: string;
  clientId: string;
  clientSecretPrefix: string;
  active: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiCredentialCreatedJson = ApiCredentialPublicJson & {
  clientSecret: string;
};

export type AuthenticatedApiClient = {
  credentialId: string;
  workspaceId: string;
  name: string;
};

function toPublic(row: {
  id: string;
  name: string;
  clientId: string;
  clientSecretPrefix: string;
  active: boolean;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ApiCredentialPublicJson {
  return {
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    clientSecretPrefix: row.clientSecretPrefix,
    active: row.active,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listApiCredentials(
  workspaceId: string
): Promise<ApiCredentialPublicJson[]> {
  const rows = await prisma.apiCredential.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toPublic);
}

export async function createApiCredential(
  workspaceId: string,
  input: { name: string; createdByUserId?: string | null }
): Promise<ApiCredentialCreatedJson> {
  const name = input.name.trim();
  if (!name) {
    throw new AppError(400, "Name is required", "VALIDATION");
  }

  const clientId = generateApiClientId();
  const clientSecret = generateApiClientSecret();
  const clientSecretHash = hashApiClientSecret(clientSecret);
  const clientSecretPrefix = clientSecret.slice(0, 8);

  const row = await prisma.apiCredential.create({
    data: {
      workspaceId,
      name,
      clientId,
      clientSecretHash,
      clientSecretPrefix,
      createdByUserId: input.createdByUserId ?? null,
    },
  });

  return {
    ...toPublic(row),
    clientSecret,
  };
}

export async function revokeApiCredential(
  workspaceId: string,
  credentialId: string
): Promise<ApiCredentialPublicJson> {
  const existing = await prisma.apiCredential.findFirst({
    where: { id: credentialId, workspaceId },
  });
  if (!existing) {
    throw new AppError(404, "API credential not found", "NOT_FOUND");
  }
  if (existing.revokedAt || !existing.active) {
    throw new AppError(400, "API credential is already revoked", "ALREADY_REVOKED");
  }

  const row = await prisma.apiCredential.update({
    where: { id: existing.id },
    data: {
      active: false,
      revokedAt: new Date(),
    },
  });
  return toPublic(row);
}

export async function authenticateApiClient(
  clientId: string,
  clientSecret: string
): Promise<AuthenticatedApiClient> {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!id || !secret) {
    throw new AppError(401, "Missing client credentials", "UNAUTHORIZED");
  }

  const row = await prisma.apiCredential.findUnique({
    where: { clientId: id },
  });
  if (!row || !row.active || row.revokedAt) {
    throw new AppError(401, "Invalid client credentials", "UNAUTHORIZED");
  }
  if (!verifyApiClientSecret(secret, row.clientSecretHash)) {
    throw new AppError(401, "Invalid client credentials", "UNAUTHORIZED");
  }

  return {
    credentialId: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
  };
}

/** Best-effort last-used stamp; failures are ignored. */
export function touchApiCredentialLastUsed(credentialId: string): void {
  void prisma.apiCredential
    .update({
      where: { id: credentialId },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => undefined);
}

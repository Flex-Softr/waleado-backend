import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/errors";
import {
  authenticateApiClient,
  touchApiCredentialLastUsed,
  type AuthenticatedApiClient,
} from "../services/api_credentials.service";
import { checkWorkspaceSubscriptionAccess } from "../services/billing.service";

export type ApiClientRequest = Request & {
  apiClient?: AuthenticatedApiClient;
};

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

export async function requireApiClient(
  req: ApiClientRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const clientId = headerValue(req.headers["x-client-id"]);
    const clientSecret = headerValue(req.headers["x-client-secret"]);
    if (!clientId || !clientSecret) {
      throw new AppError(
        401,
        "Missing X-Client-Id or X-Client-Secret header",
        "UNAUTHORIZED"
      );
    }

    const apiClient = await authenticateApiClient(clientId, clientSecret);
    const access = await checkWorkspaceSubscriptionAccess(apiClient.workspaceId);
    if (!access.hasAccess) {
      throw new AppError(
        402,
        "Workspace 3-day free trial has expired. A paid subscription is required to use the API.",
        "SUBSCRIPTION_REQUIRED"
      );
    }

    req.apiClient = apiClient;
    touchApiCredentialLastUsed(apiClient.credentialId);
    next();
  } catch (err) {
    next(err);
  }
}

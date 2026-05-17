import { OAuth2Client } from "google-auth-library";
import { env, getGoogleOAuthRedirectUri, isGoogleOAuthConfigured } from "../env";
import { AppError } from "../lib/errors";

export type GoogleUserClaims = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

function getClient(): OAuth2Client {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new AppError(
      503,
      "Google sign-in is not configured",
      "GOOGLE_OAUTH_DISABLED"
    );
  }
  return new OAuth2Client(clientId, clientSecret, getGoogleOAuthRedirectUri());
}

export function assertGoogleOAuthConfigured(): void {
  if (!isGoogleOAuthConfigured()) {
    throw new AppError(
      503,
      "Google sign-in is not configured",
      "GOOGLE_OAUTH_DISABLED"
    );
  }
}

export function buildGoogleAuthorizeUrl(state: string): string {
  assertGoogleOAuthConfigured();
  const clientId = env.GOOGLE_CLIENT_ID!.trim();
  const redirectUri = getGoogleOAuthRedirectUri();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ["openid", "email", "profile"].join(" "),
    state,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleAuthCode(
  code: string
): Promise<GoogleUserClaims> {
  const client = getClient();
  let idToken: string | undefined;
  try {
    const { tokens } = await client.getToken(code);
    idToken = tokens.id_token ?? undefined;
    if (!idToken) {
      throw new AppError(
        502,
        "Google did not return an ID token",
        "GOOGLE_TOKEN_INVALID"
      );
    }
    const ticket = await client.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID!.trim(),
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      throw new AppError(
        502,
        "Google profile is incomplete",
        "GOOGLE_PROFILE_INVALID"
      );
    }
    if (payload.email_verified !== true) {
      throw new AppError(
        403,
        "Google email is not verified",
        "GOOGLE_EMAIL_UNVERIFIED"
      );
    }
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: true,
      name: payload.name ?? null,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      502,
      "Could not validate Google sign-in",
      "GOOGLE_OAUTH_FAILED"
    );
  }
}

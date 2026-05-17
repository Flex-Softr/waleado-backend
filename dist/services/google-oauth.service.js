"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertGoogleOAuthConfigured = assertGoogleOAuthConfigured;
exports.buildGoogleAuthorizeUrl = buildGoogleAuthorizeUrl;
exports.exchangeGoogleAuthCode = exchangeGoogleAuthCode;
const google_auth_library_1 = require("google-auth-library");
const env_1 = require("../env");
const errors_1 = require("../lib/errors");
function getClient() {
    const clientId = env_1.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = env_1.env.GOOGLE_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
        throw new errors_1.AppError(503, "Google sign-in is not configured", "GOOGLE_OAUTH_DISABLED");
    }
    return new google_auth_library_1.OAuth2Client(clientId, clientSecret, (0, env_1.getGoogleOAuthRedirectUri)());
}
function assertGoogleOAuthConfigured() {
    if (!(0, env_1.isGoogleOAuthConfigured)()) {
        throw new errors_1.AppError(503, "Google sign-in is not configured", "GOOGLE_OAUTH_DISABLED");
    }
}
function buildGoogleAuthorizeUrl(state) {
    assertGoogleOAuthConfigured();
    const clientId = env_1.env.GOOGLE_CLIENT_ID.trim();
    const redirectUri = (0, env_1.getGoogleOAuthRedirectUri)();
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
async function exchangeGoogleAuthCode(code) {
    const client = getClient();
    let idToken;
    try {
        const { tokens } = await client.getToken(code);
        idToken = tokens.id_token ?? undefined;
        if (!idToken) {
            throw new errors_1.AppError(502, "Google did not return an ID token", "GOOGLE_TOKEN_INVALID");
        }
        const ticket = await client.verifyIdToken({
            idToken,
            audience: env_1.env.GOOGLE_CLIENT_ID.trim(),
        });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email) {
            throw new errors_1.AppError(502, "Google profile is incomplete", "GOOGLE_PROFILE_INVALID");
        }
        if (payload.email_verified !== true) {
            throw new errors_1.AppError(403, "Google email is not verified", "GOOGLE_EMAIL_UNVERIFIED");
        }
        return {
            sub: payload.sub,
            email: payload.email,
            emailVerified: true,
            name: payload.name ?? null,
        };
    }
    catch (err) {
        if (err instanceof errors_1.AppError)
            throw err;
        throw new errors_1.AppError(502, "Could not validate Google sign-in", "GOOGLE_OAUTH_FAILED");
    }
}

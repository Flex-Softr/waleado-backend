"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRefreshCookieName = getRefreshCookieName;
exports.setRefreshCookie = setRefreshCookie;
exports.clearRefreshCookie = clearRefreshCookie;
exports.setGoogleOAuthCookies = setGoogleOAuthCookies;
exports.readGoogleOAuthCookies = readGoogleOAuthCookies;
exports.clearGoogleOAuthCookies = clearGoogleOAuthCookies;
const env_1 = require("../env");
const REFRESH_COOKIE = "fw_refresh";
/** Cookie scoped to auth routes only — not sent to other API paths. */
const REFRESH_PATH = "/v1/auth";
const OAUTH_GOOGLE_STATE = "fw_oauth_google_state";
const OAUTH_GOOGLE_NEXT = "fw_oauth_google_next";
function getRefreshCookieName() {
    return REFRESH_COOKIE;
}
function cookieSecure() {
    if (process.env.COOKIE_SECURE === "true")
        return true;
    if (process.env.COOKIE_SECURE === "false")
        return false;
    return env_1.env.NODE_ENV === "production";
}
function sameSite() {
    const s = env_1.env.COOKIE_SAME_SITE;
    if (s === "none")
        return "none";
    if (s === "strict")
        return "strict";
    return "lax";
}
function setRefreshCookie(res, rawToken) {
    const maxAgeMs = env_1.env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;
    res.cookie(REFRESH_COOKIE, rawToken, {
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: sameSite(),
        path: REFRESH_PATH,
        maxAge: maxAgeMs,
    });
}
function clearRefreshCookie(res) {
    res.clearCookie(REFRESH_COOKIE, {
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: sameSite(),
        path: REFRESH_PATH,
    });
}
const oauthCookieOpts = () => ({
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: sameSite(),
    path: REFRESH_PATH,
});
/** Short-lived CSRF state + optional post-login path for Google OAuth. */
function setGoogleOAuthCookies(res, state, nextPath) {
    clearGoogleOAuthCookies(res);
    const base = oauthCookieOpts();
    const maxAge = 10 * 60 * 1000;
    res.cookie(OAUTH_GOOGLE_STATE, state, { ...base, maxAge });
    if (nextPath) {
        res.cookie(OAUTH_GOOGLE_NEXT, nextPath, { ...base, maxAge });
    }
}
function readGoogleOAuthCookies(req) {
    return {
        state: req.cookies[OAUTH_GOOGLE_STATE],
        next: req.cookies[OAUTH_GOOGLE_NEXT],
    };
}
function clearGoogleOAuthCookies(res) {
    const base = oauthCookieOpts();
    res.clearCookie(OAUTH_GOOGLE_STATE, base);
    res.clearCookie(OAUTH_GOOGLE_NEXT, base);
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initiateHostedSession = initiateHostedSession;
exports.validateTransaction = validateTransaction;
const env_1 = require("../../env");
function baseUrl() {
    return env_1.env.SSLCOMMERZ_SANDBOX
        ? "https://sandbox.sslcommerz.com"
        : "https://securepay.sslcommerz.com";
}
function requireCredentials() {
    const storeId = env_1.env.SSLCOMMERZ_STORE_ID?.trim();
    const storePass = env_1.env.SSLCOMMERZ_STORE_PASSWORD?.trim();
    if (!storeId || !storePass) {
        throw new Error("SSLCOMMERZ_STORE_ID and SSLCOMMERZ_STORE_PASSWORD must be set");
    }
    return { storeId, storePass: storePass };
}
/**
 * Hosted checkout: create session and return the gateway URL for browser redirect.
 * @see https://developer.sslcommerz.com/doc/v4/#initPay-section
 */
async function initiateHostedSession(form) {
    requireCredentials();
    const url = `${baseUrl()}/gwprocess/v4/api.php`;
    const body = new URLSearchParams(form);
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    }
    catch {
        throw new Error(`SSLCommerz initiate returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    return json;
}
/**
 * Validates a completed transaction using SSLCommerz validation API (authoritative).
 */
async function validateTransaction(valId) {
    const { storeId, storePass } = requireCredentials();
    const q = new URLSearchParams({
        val_id: valId,
        store_id: storeId,
        store_passwd: storePass,
        format: "json",
    });
    const url = `${baseUrl()}/validator/api/validationserverAPI.php?${q.toString()}`;
    const res = await fetch(url);
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    }
    catch {
        throw new Error(`SSLCommerz validate returned non-JSON: ${text.slice(0, 200)}`);
    }
    return json;
}

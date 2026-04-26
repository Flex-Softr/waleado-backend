"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleSslCommerzBrowserReturn = handleSslCommerzBrowserReturn;
const env_1 = require("../../env");
const fulfill_sslcommerz_1 = require("../fulfill-sslcommerz");
function appPublicBase() {
    return env_1.env.APP_PUBLIC_URL.replace(/\/$/, "");
}
function pick(q, key) {
    const v = q[key];
    if (Array.isArray(v))
        return v[0];
    return v;
}
/**
 * Handles the customer's browser return from SSLCommerz (success, fail, or cancel).
 * SSLCommerz appends status, tran_id, val_id, etc. to the query string.
 */
async function handleSslCommerzBrowserReturn(query) {
    const statusRaw = (pick(query, "status") ?? "").toUpperCase();
    const tranId = pick(query, "tran_id") ?? "";
    const valId = pick(query, "val_id") ?? "";
    if (!tranId) {
        return { redirect: `${appPublicBase()}/billing?payment=invalid` };
    }
    const failedStatuses = new Set([
        "FAILED",
        "CANCELLED",
        "CANCELED",
        "EXPIRED",
        "UNATTEMPTED",
    ]);
    if (failedStatuses.has(statusRaw)) {
        if (statusRaw === "CANCELLED" || statusRaw === "CANCELED") {
            await (0, fulfill_sslcommerz_1.markTransactionCancelled)(tranId);
        }
        else {
            await (0, fulfill_sslcommerz_1.markTransactionFailed)(tranId);
        }
        return { redirect: `${appPublicBase()}/billing?payment=${statusRaw.toLowerCase()}` };
    }
    if (valId && (statusRaw === "VALID" || statusRaw === "")) {
        try {
            await (0, fulfill_sslcommerz_1.fulfillSslCommerzByValId)({ tranId, valId });
            return { redirect: `${appPublicBase()}/billing/success?gateway=sslcommerz` };
        }
        catch {
            return { redirect: `${appPublicBase()}/billing?payment=confirm_failed` };
        }
    }
    await (0, fulfill_sslcommerz_1.markTransactionFailed)(tranId);
    return { redirect: `${appPublicBase()}/billing?payment=unknown` };
}

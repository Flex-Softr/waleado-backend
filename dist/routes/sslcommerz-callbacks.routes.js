"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sslCommerzIpnRouter = exports.sslCommerzBrowserRouter = void 0;
const express_1 = require("express");
const fulfill_sslcommerz_1 = require("../payments/fulfill-sslcommerz");
const sslcommerz_browser_handler_1 = require("../payments/sslcommerz/sslcommerz-browser-handler");
const browserRouter = (0, express_1.Router)();
exports.sslCommerzBrowserRouter = browserRouter;
/**
 * SSLCommerz often POSTs application/x-www-form-urlencoded to success_url; some flows use GET + query.
 */
function mergeBrowserReturnParams(req) {
    const out = {
        ...req.query,
    };
    const body = req.body;
    if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
        for (const [k, v] of Object.entries(body)) {
            if (typeof v === "string")
                out[k] = v;
            else if (Array.isArray(v) && typeof v[0] === "string")
                out[k] = v[0];
        }
    }
    return out;
}
async function browserReturnHandler(req, res, next) {
    try {
        const q = mergeBrowserReturnParams(req);
        const { redirect } = await (0, sslcommerz_browser_handler_1.handleSslCommerzBrowserReturn)(q);
        res.redirect(302, redirect);
    }
    catch (e) {
        next(e);
    }
}
browserRouter.get("/browser-return", browserReturnHandler);
browserRouter.post("/browser-return", browserReturnHandler);
const ipnRouter = (0, express_1.Router)();
exports.sslCommerzIpnRouter = ipnRouter;
function ipnField(body, name) {
    const want = name.toLowerCase();
    for (const [k, v] of Object.entries(body)) {
        if (k.toLowerCase() !== want)
            continue;
        if (typeof v === "string")
            return v;
        if (Array.isArray(v) && typeof v[0] === "string")
            return v[0];
    }
    return "";
}
ipnRouter.post("/ipn", async (req, res) => {
    try {
        const body = req.body;
        const status = ipnField(body, "status").toUpperCase();
        const tranId = ipnField(body, "tran_id");
        const valId = ipnField(body, "val_id");
        if (status === "VALID" && tranId && valId) {
            await (0, fulfill_sslcommerz_1.fulfillSslCommerzByValId)({ tranId, valId });
        }
    }
    catch (e) {
        console.error("[sslcommerz ipn]", e);
    }
    res.status(200).send("OK");
});

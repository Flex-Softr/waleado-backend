"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sslCommerzIpnRouter = exports.sslCommerzBrowserRouter = void 0;
const express_1 = require("express");
const fulfill_sslcommerz_1 = require("../payments/fulfill-sslcommerz");
const sslcommerz_browser_handler_1 = require("../payments/sslcommerz/sslcommerz-browser-handler");
const browserRouter = (0, express_1.Router)();
exports.sslCommerzBrowserRouter = browserRouter;
browserRouter.get("/browser-return", async (req, res, next) => {
    try {
        const q = req.query;
        const { redirect } = await (0, sslcommerz_browser_handler_1.handleSslCommerzBrowserReturn)(q);
        res.redirect(302, redirect);
    }
    catch (e) {
        next(e);
    }
});
const ipnRouter = (0, express_1.Router)();
exports.sslCommerzIpnRouter = ipnRouter;
ipnRouter.post("/ipn", async (req, res) => {
    try {
        const body = req.body;
        const status = (body.status ?? "").toUpperCase();
        const tranId = body.tran_id ?? "";
        const valId = body.val_id ?? "";
        if (status === "VALID" && tranId && valId) {
            await (0, fulfill_sslcommerz_1.fulfillSslCommerzByValId)({ tranId, valId });
        }
    }
    catch (e) {
        console.error("[sslcommerz ipn]", e);
    }
    res.status(200).send("OK");
});

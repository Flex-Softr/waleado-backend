"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sslCommerzConfigured = sslCommerzConfigured;
exports.initiateSslCommerzCheckout = initiateSslCommerzCheckout;
const crypto_1 = require("crypto");
const prisma_1 = require("../../lib/prisma");
const errors_1 = require("../../lib/errors");
const env_1 = require("../../env");
const sslApi = __importStar(require("./sslcommerz-api"));
const fulfill_sslcommerz_1 = require("../fulfill-sslcommerz");
function apiPublicBase() {
    return env_1.env.API_PUBLIC_URL.replace(/\/$/, "");
}
function appPublicBase() {
    return env_1.env.APP_PUBLIC_URL.replace(/\/$/, "");
}
/** SSLCommerz allows max 30 chars for tran_id. */
function newTranId() {
    const part = `${Date.now().toString(36)}${(0, crypto_1.randomBytes)(6).toString("hex")}`;
    return `FW${part}`.slice(0, 30);
}
function sslCommerzConfigured() {
    return Boolean(env_1.env.SSLCOMMERZ_STORE_ID?.trim() && env_1.env.SSLCOMMERZ_STORE_PASSWORD?.trim());
}
async function initiateSslCommerzCheckout(input) {
    if (!sslCommerzConfigured()) {
        throw new errors_1.AppError(503, "SSLCommerz is not configured on this server", "SSLCOMMERZ_NOT_CONFIGURED");
    }
    const { amount, currency } = (0, fulfill_sslcommerz_1.planAmount)(input.planId);
    const tranId = newTranId();
    const successUrl = `${apiPublicBase()}/v1/payments/sslcommerz/browser-return`;
    const failUrl = `${apiPublicBase()}/v1/payments/sslcommerz/browser-return`;
    const cancelUrl = `${apiPublicBase()}/v1/payments/sslcommerz/browser-return`;
    const ipnUrl = `${apiPublicBase()}/v1/webhooks/payments/sslcommerz/ipn`;
    const phone = input.customerPhone.trim() || "01700000000";
    const cusName = (input.userName ?? input.userEmail).slice(0, 50);
    const cusEmail = input.userEmail.slice(0, 50);
    await prisma_1.prisma.paymentTransaction.create({
        data: {
            gateway: "sslcommerz",
            tranId,
            workspaceId: input.workspaceId,
            planId: input.planId,
            amount,
            currency,
            status: "pending",
        },
    });
    const form = {
        store_id: env_1.env.SSLCOMMERZ_STORE_ID.trim(),
        store_passwd: env_1.env.SSLCOMMERZ_STORE_PASSWORD.trim(),
        total_amount: amount,
        currency,
        tran_id: tranId,
        success_url: successUrl,
        fail_url: failUrl,
        cancel_url: cancelUrl,
        ipn_url: ipnUrl,
        product_category: "non-physical-goods",
        product_name: `FlexoWhats ${input.planId} plan`,
        cus_name: cusName,
        cus_email: cusEmail,
        cus_phone: phone.slice(0, 20),
        cus_add1: "N/A",
        cus_city: "Dhaka",
        cus_state: "Dhaka",
        cus_country: "Bangladesh",
        cus_postcode: "1000",
        value_a: input.workspaceId,
        value_b: input.planId,
        value_c: "flexowhats",
        value_d: tranId,
    };
    const res = await sslApi.initiateHostedSession(form);
    if (res.status !== "SUCCESS" || !res.GatewayPageURL) {
        await prisma_1.prisma.paymentTransaction.updateMany({
            where: { tranId },
            data: { status: "failed" },
        });
        throw new errors_1.AppError(502, res.failedreason || "SSLCommerz session creation failed", "SSLCOMMERZ_SESSION_FAILED");
    }
    await prisma_1.prisma.paymentTransaction.updateMany({
        where: { tranId },
        data: { sessionKey: res.sessionkey ?? null },
    });
    return { url: res.GatewayPageURL };
}

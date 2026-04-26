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
exports.fulfillSslCommerzByValId = fulfillSslCommerzByValId;
exports.markTransactionFailed = markTransactionFailed;
exports.markTransactionCancelled = markTransactionCancelled;
exports.planAmount = planAmount;
const prisma_1 = require("../lib/prisma");
const errors_1 = require("../lib/errors");
const env_1 = require("../env");
const plan_mapping_1 = require("../lib/plan-mapping");
const sslApi = __importStar(require("./sslcommerz/sslcommerz-api"));
const PAID_STATUSES = new Set(["VALID", "VALIDATED"]);
function amountsRoughlyEqual(a, b) {
    return Math.abs(a - b) < 0.02;
}
/**
 * Confirms payment with SSLCommerz validation API and upgrades the workspace plan.
 * Idempotent: if the transaction row is already `paid`, returns without error.
 */
async function fulfillSslCommerzByValId(input) {
    const row = await prisma_1.prisma.paymentTransaction.findUnique({
        where: { tranId: input.tranId },
    });
    if (!row || row.gateway !== "sslcommerz") {
        throw new errors_1.AppError(404, "Unknown transaction", "TRANSACTION_NOT_FOUND");
    }
    if (row.status === "paid") {
        const ws = await prisma_1.prisma.workspace.findUnique({
            where: { id: row.workspaceId },
            select: { plan: true },
        });
        return { planId: ws ? (0, plan_mapping_1.planToApi)(ws.plan) : "free" };
    }
    const validated = await sslApi.validateTransaction(input.valId);
    const st = (validated.status ?? "").toUpperCase();
    if (!PAID_STATUSES.has(st)) {
        throw new errors_1.AppError(400, "Payment not validated by SSLCommerz", "PAYMENT_INVALID");
    }
    if (validated.tran_id && validated.tran_id !== input.tranId) {
        throw new errors_1.AppError(400, "Transaction mismatch", "TRANSACTION_MISMATCH");
    }
    const expectedAmount = Number(row.amount);
    const gotAmount = Number(validated.amount ?? validated.currency_amount);
    if (!Number.isFinite(gotAmount) || !amountsRoughlyEqual(gotAmount, expectedAmount)) {
        throw new errors_1.AppError(400, "Amount mismatch", "AMOUNT_MISMATCH");
    }
    const plan = (0, plan_mapping_1.apiPaidPlanToDb)(row.planId);
    const periodEnd = new Date();
    periodEnd.setDate(periodEnd.getDate() + 30);
    await prisma_1.prisma.$transaction([
        prisma_1.prisma.workspace.update({
            where: { id: row.workspaceId },
            data: {
                plan,
                lastPaymentGateway: "sslcommerz",
                subscriptionStatus: "active",
                currentPeriodEnd: periodEnd,
                stripeCustomerId: null,
                stripeSubscriptionId: null,
            },
        }),
        prisma_1.prisma.paymentTransaction.update({
            where: { id: row.id },
            data: {
                status: "paid",
                valId: input.valId,
            },
        }),
    ]);
    return { planId: row.planId };
}
async function markTransactionFailed(tranId) {
    await prisma_1.prisma.paymentTransaction.updateMany({
        where: { tranId, status: "pending" },
        data: { status: "failed" },
    });
}
async function markTransactionCancelled(tranId) {
    await prisma_1.prisma.paymentTransaction.updateMany({
        where: { tranId, status: "pending" },
        data: { status: "cancelled" },
    });
}
function planAmount(plan) {
    const currency = env_1.env.SSLCOMMERZ_CURRENCY.trim().toUpperCase();
    const raw = plan === "pro" ? env_1.env.SSLCOMMERZ_PRO_AMOUNT : env_1.env.SSLCOMMERZ_BUSINESS_AMOUNT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0.5) {
        throw new errors_1.AppError(500, "Invalid SSLCOMMERZ plan amount in environment", "SSLCOMMERZ_CONFIG");
    }
    return { amount: n.toFixed(2), currency };
}

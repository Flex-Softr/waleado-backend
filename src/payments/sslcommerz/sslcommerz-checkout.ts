import { randomBytes } from "crypto";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { env } from "../../env";
import type { InitiateCheckoutInput } from "../types";
import type { PlanIdApi } from "../../lib/plan-mapping";
import * as sslApi from "./sslcommerz-api";
import { planAmount } from "../fulfill-sslcommerz";

function apiPublicBase(): string {
  return env.API_PUBLIC_URL.replace(/\/$/, "");
}

function appPublicBase(): string {
  return env.APP_PUBLIC_URL.replace(/\/$/, "");
}

/** SSLCommerz allows max 30 chars for tran_id. */
function newTranId(): string {
  const part = `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
  return `FW${part}`.slice(0, 30);
}

export function sslCommerzConfigured(): boolean {
  return Boolean(
    env.SSLCOMMERZ_STORE_ID?.trim() && env.SSLCOMMERZ_STORE_PASSWORD?.trim()
  );
}

export async function initiateSslCommerzCheckout(
  input: InitiateCheckoutInput
): Promise<{ url: string }> {
  if (!sslCommerzConfigured()) {
    throw new AppError(
      503,
      "SSLCommerz is not configured on this server",
      "SSLCOMMERZ_NOT_CONFIGURED"
    );
  }

  const { amount, currency } = planAmount(input.planId);
  const tranId = newTranId();

  const successUrl = `${apiPublicBase()}/v1/payments/sslcommerz/browser-return`;
  const failUrl = `${apiPublicBase()}/v1/payments/sslcommerz/browser-return`;
  const cancelUrl = `${apiPublicBase()}/v1/payments/sslcommerz/browser-return`;
  const ipnUrl = `${apiPublicBase()}/v1/webhooks/payments/sslcommerz/ipn`;

  const phone = input.customerPhone.trim() || "01700000000";
  const cusName = (input.userName ?? input.userEmail).slice(0, 50);
  const cusEmail = input.userEmail.slice(0, 50);

  await prisma.paymentTransaction.create({
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

  const form: Record<string, string> = {
    store_id: env.SSLCOMMERZ_STORE_ID!.trim(),
    store_passwd: env.SSLCOMMERZ_STORE_PASSWORD!.trim(),
    total_amount: amount,
    currency,
    tran_id: tranId,
    success_url: successUrl,
    fail_url: failUrl,
    cancel_url: cancelUrl,
    ipn_url: ipnUrl,
    product_category: "non-physical-goods",
    product_name: `Waleado ${input.planId} plan`,
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
    value_c: "waleado",
    value_d: tranId,
  };

  const res = await sslApi.initiateHostedSession(form);
  if (res.status !== "SUCCESS" || !res.GatewayPageURL) {
    await prisma.paymentTransaction.updateMany({
      where: { tranId },
      data: { status: "failed" },
    });
    throw new AppError(
      502,
      res.failedreason || "SSLCommerz session creation failed",
      "SSLCOMMERZ_SESSION_FAILED"
    );
  }

  await prisma.paymentTransaction.updateMany({
    where: { tranId },
    data: { sessionKey: res.sessionkey ?? null },
  });

  return { url: res.GatewayPageURL };
}

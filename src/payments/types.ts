import type { PlanIdApi } from "../lib/plan-mapping";

export type PaymentGatewayId = "stripe" | "sslcommerz";

export type InitiateCheckoutInput = {
  workspaceId: string;
  userEmail: string;
  userName: string | null;
  /** SSLCommerz requires a customer phone on file. */
  customerPhone: string;
  invoiceId: string;
  planId: PlanIdApi;
  /** What is charged, in the invoice currency (BDT). */
  amount: number;
  currency: string;
  /** Charged amount in USD for Stripe (null when the price has no USD amount). */
  amountUsd: number | null;
  description: string;
  /**
   * Where the customer lands after paying: the billing page (logged in) or the
   * public pay-link status page.
   */
  returnTo?: "billing" | "pay-link";
};

export type InitiateCheckoutResult =
  | { kind: "redirect"; url: string }
  /** Nothing to pay (credit covered it, or local demo mode): already activated. */
  | { kind: "activated" };

export type PaymentGatewayMeta = {
  id: PaymentGatewayId;
  displayName: string;
  description: string;
  configured: boolean;
};

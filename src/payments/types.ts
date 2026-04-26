import type { PlanIdApi } from "../lib/plan-mapping";

export type PaymentGatewayId = "stripe" | "sslcommerz";

export type InitiateCheckoutInput = {
  workspaceId: string;
  userEmail: string;
  userName: string | null;
  /** SSLCommerz requires a customer phone on file. */
  customerPhone: string;
  planId: Exclude<PlanIdApi, "free">;
};

export type InitiateCheckoutResult =
  | { kind: "redirect"; url: string }
  | { kind: "demo"; planId: PlanIdApi };

export type PaymentGatewayMeta = {
  id: PaymentGatewayId;
  displayName: string;
  description: string;
  configured: boolean;
};

import { env } from "../../env";
import {
  fulfillSslCommerzByValId,
  markTransactionCancelled,
  markTransactionFailed,
} from "../fulfill-sslcommerz";

function appPublicBase(): string {
  return env.APP_PUBLIC_URL.replace(/\/$/, "");
}

function pick(
  q: Record<string, string | string[] | undefined>,
  key: string
): string | undefined {
  const v = q[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Handles the customer's browser return from SSLCommerz (success, fail, or cancel).
 * SSLCommerz appends status, tran_id, val_id, etc. to the query string.
 */
export async function handleSslCommerzBrowserReturn(
  query: Record<string, string | string[] | undefined>
): Promise<{ redirect: string }> {
  const fromPayLink = pick(query, "return") === "pay-link";
  // Pay-link customers are not logged in, so they get the public status page instead of /billing.
  const target = (billingQuery: string, result: string) =>
    fromPayLink
      ? `${appPublicBase()}/pay/status?result=${result}`
      : `${appPublicBase()}/billing${billingQuery}`;

  const statusRaw = (pick(query, "status") ?? "").toUpperCase();
  const tranId = pick(query, "tran_id") ?? "";
  const valId = pick(query, "val_id") ?? "";

  if (!tranId) {
    return { redirect: target("?payment=invalid", "failed") };
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
      await markTransactionCancelled(tranId);
    } else {
      await markTransactionFailed(tranId);
    }
    const cancelled = statusRaw === "CANCELLED" || statusRaw === "CANCELED";
    return { redirect: target(`?payment=${statusRaw.toLowerCase()}`, cancelled ? "cancelled" : "failed") };
  }

  if (valId && (statusRaw === "VALID" || statusRaw === "")) {
    try {
      await fulfillSslCommerzByValId({ tranId, valId });
      return { redirect: target("/success?gateway=sslcommerz", "success") };
    } catch {
      return { redirect: target("?payment=confirm_failed", "failed") };
    }
  }

  await markTransactionFailed(tranId);
  return { redirect: target("?payment=unknown", "failed") };
}

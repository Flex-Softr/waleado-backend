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
      await markTransactionCancelled(tranId);
    } else {
      await markTransactionFailed(tranId);
    }
    return { redirect: `${appPublicBase()}/billing?payment=${statusRaw.toLowerCase()}` };
  }

  if (valId && (statusRaw === "VALID" || statusRaw === "")) {
    try {
      await fulfillSslCommerzByValId({ tranId, valId });
      return { redirect: `${appPublicBase()}/billing/success?gateway=sslcommerz` };
    } catch {
      return { redirect: `${appPublicBase()}/billing?payment=confirm_failed` };
    }
  }

  await markTransactionFailed(tranId);
  return { redirect: `${appPublicBase()}/billing?payment=unknown` };
}

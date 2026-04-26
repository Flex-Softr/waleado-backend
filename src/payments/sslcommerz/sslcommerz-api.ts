import { env } from "../../env";

export type SslCommerzInitResponse = {
  status: string;
  failedreason?: string;
  sessionkey?: string;
  GatewayPageURL?: string;
};

export type SslCommerzValidationResponse = {
  status?: string;
  tran_id?: string;
  val_id?: string;
  amount?: string;
  currency_type?: string;
  currency_amount?: string;
  tran_date?: string;
};

function baseUrl(): string {
  return env.SSLCOMMERZ_SANDBOX
    ? "https://sandbox.sslcommerz.com"
    : "https://securepay.sslcommerz.com";
}

function requireCredentials(): { storeId: string; storePass: string } {
  const storeId = env.SSLCOMMERZ_STORE_ID?.trim();
  const storePass = env.SSLCOMMERZ_STORE_PASSWORD?.trim();
  if (!storeId || !storePass) {
    throw new Error("SSLCOMMERZ_STORE_ID and SSLCOMMERZ_STORE_PASSWORD must be set");
  }
  return { storeId, storePass: storePass };
}

/**
 * Hosted checkout: create session and return the gateway URL for browser redirect.
 * @see https://developer.sslcommerz.com/doc/v4/#initPay-section
 */
export async function initiateHostedSession(
  form: Record<string, string>
): Promise<SslCommerzInitResponse> {
  requireCredentials();
  const url = `${baseUrl()}/gwprocess/v4/api.php`;
  const body = new URLSearchParams(form);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text) as SslCommerzInitResponse;
  } catch {
    throw new Error(`SSLCommerz initiate returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  return json as SslCommerzInitResponse;
}

/**
 * Validates a completed transaction using SSLCommerz validation API (authoritative).
 */
export async function validateTransaction(valId: string): Promise<SslCommerzValidationResponse> {
  const { storeId, storePass } = requireCredentials();
  const q = new URLSearchParams({
    val_id: valId,
    store_id: storeId,
    store_passwd: storePass,
    format: "json",
  });
  const url = `${baseUrl()}/validator/api/validationserverAPI.php?${q.toString()}`;
  const res = await fetch(url);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`SSLCommerz validate returned non-JSON: ${text.slice(0, 200)}`);
  }
  return json as SslCommerzValidationResponse;
}

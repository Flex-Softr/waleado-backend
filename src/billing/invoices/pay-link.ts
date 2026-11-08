import { createHmac, timingSafeEqual } from "crypto";
import { env } from "../../env";

/** Separate key derived from the app secret so pay-link signatures can't be reused elsewhere. */
function signingKey(): Buffer {
  return createHmac("sha256", env.JWT_ACCESS_SECRET).update("waleado:invoice-pay-link").digest();
}

function sign(invoiceId: string): string {
  return createHmac("sha256", signingKey()).update(invoiceId).digest("base64url");
}

/** Opaque token for paying an invoice without logging in: "<invoiceId>.<signature>". */
export function createPayToken(invoiceId: string): string {
  return `${invoiceId}.${sign(invoiceId)}`;
}

/** Returns the invoice id when the token is authentic, otherwise null. */
export function verifyPayToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const invoiceId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(invoiceId));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return invoiceId;
}

export function payLinkUrl(invoiceId: string): string {
  return `${env.APP_PUBLIC_URL.replace(/\/$/, "")}/pay/${createPayToken(invoiceId)}`;
}

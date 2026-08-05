import { createHash, randomBytes, timingSafeEqual } from "crypto";

export function generateRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generatePasswordResetToken(): string {
  return randomBytes(48).toString("base64url");
}

export function hashPasswordResetToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateApiClientId(): string {
  return `fw_cid_${randomBytes(18).toString("base64url")}`;
}

export function generateApiClientSecret(): string {
  return `fw_csec_${randomBytes(32).toString("base64url")}`;
}

export function hashApiClientSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function verifyApiClientSecret(raw: string, hash: string): boolean {
  const computed = hashApiClientSecret(raw);
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

import crypto from "crypto";
import { env } from "../env";

const SIGN_TTL_SEC = 15 * 60;

function signRaw(value: string): string {
  return crypto
    .createHmac("sha256", env.JWT_ACCESS_SECRET)
    .update(value)
    .digest("hex");
}

export function createLiveChatMediaToken(input: {
  workspaceId: string;
  assetId: string;
  ttlSec?: number;
}): { exp: string; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + (input.ttlSec ?? SIGN_TTL_SEC);
  const payload = `${input.workspaceId}:${input.assetId}:${exp}`;
  return { exp: String(exp), sig: signRaw(payload) };
}

export function verifyLiveChatMediaToken(input: {
  workspaceId: string;
  assetId: string;
  exp: string;
  sig: string;
}): boolean {
  const expNum = Number(input.exp);
  if (!Number.isFinite(expNum) || expNum <= Math.floor(Date.now() / 1000)) {
    return false;
  }
  const payload = `${input.workspaceId}:${input.assetId}:${input.exp}`;
  const expected = signRaw(payload);
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(input.sig);
  // timingSafeEqual throws when lengths differ — treat as invalid signature.
  if (expectedBuf.length !== sigBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, sigBuf);
}

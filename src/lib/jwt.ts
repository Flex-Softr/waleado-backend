import { randomUUID } from "crypto";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../env";

export type AccessPayload = {
  sub: string;
  email: string;
  wid: string;
  /** Workspace MembershipRole (OWNER | ADMIN | MEMBER). */
  role: string;
  /** Platform UserRole (ADMIN | CUSTOMER). */
  userRole: string;
  jti: string;
};

export function signAccessToken(payload: Omit<AccessPayload, "jti"> & { jti?: string }): string {
  const jti = payload.jti ?? randomUUID();
  const body: AccessPayload = {
    sub: payload.sub,
    email: payload.email,
    wid: payload.wid,
    role: payload.role,
    userRole: payload.userRole,
    jti,
  };
  const options: SignOptions = {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions["expiresIn"],
    issuer: "waleado-api",
    audience: "waleado-app",
  };
  return jwt.sign(body, env.JWT_ACCESS_SECRET, options);
}

export function verifyAccessToken(token: string): AccessPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: "waleado-api",
    audience: "waleado-app",
  });
  if (typeof decoded === "string" || !decoded.sub) {
    throw new Error("Invalid token payload");
  }
  return decoded as AccessPayload;
}

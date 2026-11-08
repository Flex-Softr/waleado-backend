import { createHash, randomInt, timingSafeEqual } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../lib/errors";
import { validateAndFormatPhone } from "../lib/phone";
import { getSystemSettings } from "../system-messages/settings.service";
import { isSystemWhatsAppReady } from "../system-messages/whatsapp-sender";
import { dispatchSystemMessage } from "../system-messages/dispatcher.service";

const CODE_TTL_MINUTES = 10;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_SENDS_PER_USER_PER_HOUR = 5;
const MAX_SENDS_PER_PHONE_PER_DAY = 10;
const MAX_ATTEMPTS = 5;

function hashCode(userId: string, code: string): string {
  return createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

export type PhoneVerificationState = {
  /** The user must verify before using the dashboard. */
  required: boolean;
  verified: boolean;
  phone: string | null;
};

/**
 * Verification is required for customers without a verified number, but only while a sender
 * device is actually connected — otherwise nobody could receive a code and sign-ups would stall.
 */
export async function getPhoneVerificationState(userId: string): Promise<PhoneVerificationState> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, phoneVerifiedAt: true, verifiedPhone: true },
  });
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  const verified = user.role === "ADMIN" || user.phoneVerifiedAt !== null;
  if (verified) return { required: false, verified: true, phone: user.verifiedPhone };
  const { requirePhoneVerification } = await getSystemSettings();
  const required = requirePhoneVerification && (await isSystemWhatsAppReady());
  return { required, verified: false, phone: null };
}

function tooMany(message: string, retryAfterSeconds?: number): AppError {
  return new AppError(429, message, "OTP_RATE_LIMITED", retryAfterSeconds ? { retryAfterSeconds } : undefined);
}

async function assertSendAllowed(userId: string, phone: string, now: Date): Promise<void> {
  const last = await prisma.phoneOtp.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
  if (last && now.getTime() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now.getTime() - last.createdAt.getTime())) / 1000);
    throw tooMany(`Please wait ${wait} seconds before requesting a new code.`, wait);
  }
  const [userHour, phoneDay] = await Promise.all([
    prisma.phoneOtp.count({ where: { userId, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } }),
    prisma.phoneOtp.count({ where: { phone, createdAt: { gte: new Date(now.getTime() - 86_400_000) } } }),
  ]);
  if (userHour >= MAX_SENDS_PER_USER_PER_HOUR || phoneDay >= MAX_SENDS_PER_PHONE_PER_DAY) {
    throw tooMany("Too many codes requested. Please try again later.");
  }
}

/** Sends a 6-digit code to the number over WhatsApp. One verified number per account. */
export async function sendPhoneOtp(userId: string, rawPhone: string): Promise<{ phone: string; expiresInSeconds: number }> {
  const parsed = validateAndFormatPhone(rawPhone);
  if (!parsed.valid) throw new AppError(400, parsed.message, "INVALID_PHONE");
  const phone = parsed.e164;

  const taken = await prisma.user.findFirst({
    where: { verifiedPhone: phone, id: { not: userId } },
    select: { id: true },
  });
  if (taken) {
    throw new AppError(409, "This WhatsApp number is already used by another account.", "PHONE_IN_USE");
  }

  const now = new Date();
  await assertSendAllowed(userId, phone, now);

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const otp = await prisma.phoneOtp.create({
    data: {
      userId,
      phone,
      codeHash: hashCode(userId, code),
      expiresAt: new Date(now.getTime() + CODE_TTL_MINUTES * 60_000),
    },
  });

  const result = await dispatchSystemMessage({
    key: "phone_otp",
    to: { name: null, email: null, phone },
    vars: { code, minutes: CODE_TTL_MINUTES },
    channels: ["whatsapp"],
  });
  if (result.status !== "done" || result.whatsapp !== "sent") {
    // Not delivered: drop it so the cooldown and hourly limits don't count it.
    await prisma.phoneOtp.delete({ where: { id: otp.id } });
    throw new AppError(503, "We couldn't send the code right now. Please try again in a minute.", "OTP_SEND_FAILED");
  }
  return { phone, expiresInSeconds: CODE_TTL_MINUTES * 60 };
}

/** Checks the latest code; on success the number becomes the account's verified phone. */
export async function verifyPhoneOtp(userId: string, code: string): Promise<{ phone: string }> {
  const otp = await prisma.phoneOtp.findFirst({
    where: { userId, consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) throw new AppError(400, "The code has expired. Please request a new one.", "OTP_EXPIRED");
  if (otp.attempts >= MAX_ATTEMPTS) throw tooMany("Too many wrong attempts. Please request a new code.");

  const given = Buffer.from(hashCode(userId, code.trim()));
  const expected = Buffer.from(otp.codeHash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    await prisma.phoneOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw new AppError(400, "That code is not correct.", "OTP_INVALID");
  }

  try {
    await prisma.$transaction([
      prisma.phoneOtp.update({ where: { id: otp.id }, data: { consumedAt: new Date() } }),
      prisma.user.update({
        where: { id: userId },
        data: { verifiedPhone: otp.phone, phone: otp.phone, phoneVerifiedAt: new Date() },
      }),
    ]);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new AppError(409, "This WhatsApp number is already used by another account.", "PHONE_IN_USE");
    }
    throw e;
  }
  markVerified(userId);
  return { phone: otp.phone };
}

// ---------------------------------------------------------------------------
// Request-time check with a small cache (verified users stay verified).
// ---------------------------------------------------------------------------

const verifiedUsers = new Set<string>();
const pendingCache = new Map<string, number>();
const PENDING_TTL_MS = 30_000;

function markVerified(userId: string): void {
  verifiedUsers.add(userId);
  pendingCache.delete(userId);
}

/** Throws PHONE_NOT_VERIFIED when the user still has to confirm a WhatsApp number. */
export async function assertPhoneVerified(userId: string): Promise<void> {
  if (verifiedUsers.has(userId)) return;
  const until = pendingCache.get(userId);
  if (until && until > Date.now()) {
    throw new AppError(403, "Please verify your WhatsApp number to continue.", "PHONE_NOT_VERIFIED");
  }
  const state = await getPhoneVerificationState(userId);
  if (state.verified) {
    markVerified(userId);
    return;
  }
  if (!state.required) return;
  pendingCache.set(userId, Date.now() + PENDING_TTL_MS);
  throw new AppError(403, "Please verify your WhatsApp number to continue.", "PHONE_NOT_VERIFIED");
}

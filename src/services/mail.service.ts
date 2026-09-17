import nodemailer from "nodemailer";
import { env } from "../env";

function isSmtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST?.trim() && env.SMTP_PORT);
}

export async function sendPasswordResetEmail(input: {
  to: string;
  resetUrl: string;
  expiresMinutes: number;
}): Promise<{ delivered: boolean }> {
  const subject = "Reset your Waleado password";
  const text = [
    "We received a request to reset your Waleado password.",
    "",
    `Open this link within ${input.expiresMinutes} minutes:`,
    input.resetUrl,
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n");
  const html = `
    <p>We received a request to reset your Waleado password.</p>
    <p><a href="${escapeHtml(input.resetUrl)}">Reset your password</a></p>
    <p>This link expires in ${input.expiresMinutes} minutes.</p>
    <p>If you did not request this, you can ignore this email.</p>
  `;

  if (!isSmtpConfigured()) {
    console.warn("[password-reset] SMTP is not configured. Reset link for %s: %s", input.to, input.resetUrl);
    return { delivered: false };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
      auth:
        env.SMTP_USER && env.SMTP_PASS
          ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
          : undefined,
    });

    await transporter.sendMail({
      from: env.SMTP_FROM,
      to: input.to,
      subject,
      text,
      html,
    });

    console.info(`[password-reset] Reset email sent to ${input.to}`);
    return { delivered: true };
  } catch (err) {
    console.error(`[password-reset] SMTP send failed for ${input.to}:`, err);
    console.warn("[password-reset] Fallback reset link for %s: %s", input.to, input.resetUrl);
    return { delivered: false };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

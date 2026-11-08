import { escapeHtml, sendMail } from "../system-messages/mailer";

export async function sendPasswordResetEmail(input: {
  to: string;
  resetUrl: string;
  expiresMinutes: number;
}): Promise<{ delivered: boolean }> {
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
  const result = await sendMail({ to: input.to, subject: "Reset your Waleado password", text, html });
  if (!result.delivered) {
    console.warn("[password-reset] email not delivered to %s", input.to);
  }
  return { delivered: result.delivered };
}

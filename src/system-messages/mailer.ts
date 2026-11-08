import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../env";

let transporter: Transporter | null = null;

export function isMailConfigured(): boolean {
  return Boolean(env.SMTP_HOST?.trim() && env.SMTP_PORT);
}

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
      auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

/** Sends through the platform's own SMTP server. Never throws; returns whether it was delivered. */
export async function sendMail(message: MailMessage): Promise<{ delivered: boolean; error?: string }> {
  if (!isMailConfigured()) {
    return { delivered: false, error: "SMTP is not configured" };
  }
  try {
    await getTransporter().sendMail({ from: env.SMTP_FROM, ...message });
    return { delivered: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[mailer] send to ${message.to} failed:`, error);
    return { delivered: false, error };
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text → simple HTML: escaped, links clickable, line breaks kept. */
export function textToHtml(text: string): string {
  const linked = escapeHtml(text).replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => `<a href="${url}" style="color:#047857">${url}</a>`
  );
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#0f172a">${linked.replace(/\n/g, "<br>")}</div>`;
}

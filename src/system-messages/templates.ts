/**
 * Built-in system message templates. Admins can override the text per template
 * (stored in NotificationTemplate); these defaults are used otherwise.
 * Placeholders look like {name} and are filled from the variables passed when sending.
 */

export type TemplateDefinition = {
  label: string;
  /** Placeholders available in this template, shown in the admin editor. */
  variables: string[];
  whatsapp: string | null;
  email: { subject: string; body: string } | null;
};

const COMMON = ["name", "workspace", "billing_link"];

export const TEMPLATES = {
  phone_otp: {
    label: "Phone verification code",
    variables: ["code", "minutes"],
    whatsapp: "Your Waleado verification code is {code}. It expires in {minutes} minutes. Do not share it with anyone.",
    email: null,
  },
  renewal_reminder: {
    label: "Renewal reminder (with pay link)",
    variables: [...COMMON, "plan", "days", "date", "amount", "invoice", "pay_link"],
    whatsapp:
      "Hi {name}, your Waleado {plan} plan ends in {days} day(s) ({date}).\nRenewal: {amount}. Pay here, no login needed:\n{pay_link}",
    email: {
      subject: "Your Waleado plan ends in {days} day(s)",
      body:
        "Hi {name},\n\nYour {plan} plan for {workspace} ends on {date}.\nRenewal amount: {amount} (invoice {invoice}).\n\nPay securely here, no login needed:\n{pay_link}\n\nRenewing early never loses days — the new period starts when the current one ends.",
    },
  },
  plan_expired: {
    label: "Plan ended (grace period)",
    variables: [...COMMON, "plan", "date", "pay_link"],
    whatsapp:
      "Hi {name}, your Waleado {plan} plan has ended. It keeps working until {date}, after that the workspace moves to the Free plan. Renew here:\n{pay_link}",
    email: {
      subject: "Your Waleado {plan} plan has ended",
      body:
        "Hi {name},\n\nYour {plan} plan for {workspace} has ended. Your features keep working until {date}; after that the workspace moves to the Free plan.\n\nRenew here:\n{pay_link}",
    },
  },
  payment_received: {
    label: "Payment received",
    variables: [...COMMON, "description", "amount", "invoice"],
    whatsapp: "Thank you {name}! We received {amount} for {description} (invoice {invoice}).",
    email: {
      subject: "Payment received — invoice {invoice}",
      body:
        "Hi {name},\n\nWe received {amount} for {description}.\nInvoice: {invoice}\n\nView your invoices: {billing_link}\n\nThank you for using Waleado.",
    },
  },
  usage_alert: {
    label: "Usage limit alert",
    variables: [...COMMON, "plan", "limit", "percent", "used", "max"],
    whatsapp:
      "Hi {name}, you have used {percent}% of your {limit} on the Waleado {plan} plan ({used}/{max}). Upgrade to avoid interruptions:\n{billing_link}",
    email: {
      subject: "You've used {percent}% of your {limit}",
      body:
        "Hi {name},\n\nYour workspace {workspace} has used {used} of {max} {limit} ({percent}%) on the {plan} plan.\n\nUpgrade any time: {billing_link}",
    },
  },
  auto_renew_success: {
    label: "Auto-renewed from wallet",
    variables: [...COMMON, "plan", "amount", "date", "balance"],
    whatsapp:
      "Hi {name}, your Waleado {plan} plan was renewed from your wallet ({amount}). Next renewal: {date}. Wallet balance: {balance}.",
    email: {
      subject: "Your Waleado plan was renewed",
      body:
        "Hi {name},\n\nYour {plan} plan for {workspace} was renewed from your wallet for {amount}. It now runs until {date}.\nRemaining wallet balance: {balance}.",
    },
  },
  auto_renew_failed: {
    label: "Auto-renew failed (low balance)",
    variables: [...COMMON, "plan", "amount", "balance"],
    whatsapp:
      "Hi {name}, we couldn't auto-renew your Waleado {plan} plan: it costs {amount} but your wallet has {balance}. Add funds or pay here:\n{billing_link}",
    email: {
      subject: "Auto-renew needs more wallet balance",
      body:
        "Hi {name},\n\nWe tried to renew {plan} for {workspace} from your wallet, but the renewal costs {amount} and your balance is {balance}.\n\nAdd funds or pay directly: {billing_link}",
    },
  },
  wallet_topup: {
    label: "Wallet top-up received",
    variables: [...COMMON, "amount", "balance"],
    whatsapp: "Hi {name}, {amount} was added to your Waleado wallet. New balance: {balance}.",
    email: {
      subject: "{amount} added to your Waleado wallet",
      body: "Hi {name},\n\n{amount} was added to the wallet of {workspace}.\nNew balance: {balance}.\n\n{billing_link}",
    },
  },
  device_idle_warning: {
    label: "Idle device warning (Free plan)",
    variables: [...COMMON, "device", "days"],
    whatsapp:
      "Hi {name}, your WhatsApp device \"{device}\" on Waleado hasn't been used for a while. Free plan devices that stay idle are disconnected in {days} day(s). Use it or upgrade to keep it connected:\n{billing_link}",
    email: {
      subject: "Your device \"{device}\" will be disconnected soon",
      body:
        "Hi {name},\n\nYour WhatsApp device \"{device}\" in {workspace} hasn't been used recently. On the Free plan, idle devices are disconnected after a while to keep the service fast for everyone. It will be disconnected in {days} day(s).\n\nSend a message or upgrade to keep it connected: {billing_link}",
    },
  },
  device_idle_disconnected: {
    label: "Idle device disconnected (Free plan)",
    variables: [...COMMON, "device"],
    whatsapp:
      "Hi {name}, your idle WhatsApp device \"{device}\" was disconnected from Waleado. Your data is safe — scan the QR code again in Devices to reconnect.",
    email: {
      subject: "Your device \"{device}\" was disconnected",
      body:
        "Hi {name},\n\nYour WhatsApp device \"{device}\" in {workspace} was disconnected because it was idle. Nothing was deleted — open Devices and scan the QR code to reconnect.",
    },
  },
} satisfies Record<string, TemplateDefinition>;

export type TemplateKey = keyof typeof TEMPLATES;
export const TEMPLATE_KEYS = Object.keys(TEMPLATES) as TemplateKey[];

export function isTemplateKey(value: string): value is TemplateKey {
  return value in TEMPLATES;
}

export type TemplateVars = Record<string, string | number | null | undefined>;

/** Replaces {placeholders}; unknown placeholders are left as-is so mistakes are visible. */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = vars[name];
    return v === undefined || v === null ? match : String(v);
  });
}

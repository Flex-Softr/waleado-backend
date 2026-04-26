import type { CountryCode } from "libphonenumber-js";
/** Full metadata — stricter than default build; avoids accepting LID-like digit strings as real mobiles. */
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { env } from "../env";

export type PhoneValidationResult =
  | { valid: true; e164: string }
  | { valid: false; e164: null; message: string };

const ZERO_WIDTH = /\u200b|\u200c|\u200d|\ufeff/g;

/** Split cells that list several numbers (ASCII/Arabic/fullwidth punctuation, newlines). */
const PHONE_VALUE_SPLIT = /[,،;\uFF0C\uFF1B|\r\n]+/u;

/**
 * Normalizes pasted / imported phone strings before libphonenumber parsing.
 * Handles WhatsApp exports: `digits@s.whatsapp.net`, `digits@c.us`, Excel floats, scientific notation.
 */
export function sanitizePhoneRawInput(raw: string): string {
  let s = raw.normalize("NFC").trim().replace(ZERO_WIDTH, "");

  const waMe = s.match(
    /(?:https?:\/\/)?(?:www\.)?wa\.me\/\+?(\d{6,18})(?:[/?#]|$)/i
  );
  if (waMe) {
    s = `+${waMe[1]}`;
  }

  const waPn = s.match(/^\+?(\d{6,18})(?::\d+)?@s\.whatsapp\.net$/i);
  if (waPn) {
    s = `+${waPn[1]}`;
  } else {
    const legacyUs = s.match(/^(\d{6,18})@c\.us$/i);
    if (legacyUs) {
      s = `+${legacyUs[1]}`;
    }
  }

  const apiPhone = s.match(/[?&]phone=\+?(\d{6,18})\b/i);
  if (apiPhone && /whatsapp\.com/i.test(s)) {
    s = `+${apiPhone[1]}`;
  }

  const intOnlyFloat = s.match(/^(\d+)\.0+$/);
  if (intOnlyFloat) {
    s = intOnlyFloat[1] ?? s;
  }

  if (/[eE][+-]?\d+$/.test(s.replace(/\s/g, "")) && /^[+-]?[\d.]+[eE]/i.test(s.trim())) {
    const n = Number(s.replace(/\s/g, ""));
    if (Number.isFinite(n) && n >= 1e7 && n < 1e16) {
      s = String(Math.round(n));
    }
  }

  s = s.replace(/[\u00a0\u202f]/g, " ");
  const compact = s.replace(/[\s().[\]{}_\-‑–—]/g, "");
  if (/^00\d/.test(compact)) {
    return `+${compact.slice(2)}`;
  }
  return s.replace(/\s+/g, " ").trim();
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, "");
}

function defaultCountry(): CountryCode | undefined {
  const r = env.PHONE_DEFAULT_REGION;
  return r && /^[A-Z]{2}$/.test(r) ? (r as CountryCode) : undefined;
}

const LID_MESSAGE =
  "WhatsApp export shows an internal ID (…@lid), not a phone number. Use a column with …@s.whatsapp.net, plain digits with country code, or set PHONE_DEFAULT_REGION for local numbers.";

const GUS_MESSAGE =
  "This value is a WhatsApp group id (@g.us), not a contact phone.";

const GENERIC_INVALID =
  "Use a valid international number (e.g. +880 1XXX-XXXXXX) or enable PHONE_DEFAULT_REGION for local numbers without country code.";

function splitIntoPhoneCandidates(trimmed: string): string[] {
  if (!PHONE_VALUE_SPLIT.test(trimmed)) {
    return [trimmed];
  }
  const parts = trimmed.split(PHONE_VALUE_SPLIT).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [trimmed];
}

function validateAndFormatPhoneSegment(segment: string): PhoneValidationResult {
  const trimmed = segment.normalize("NFC").trim();
  if (!trimmed) {
    return { valid: false, e164: null, message: "Enter a phone number" };
  }
  if (/@lid\b/i.test(trimmed)) {
    return { valid: false, e164: null, message: LID_MESSAGE };
  }
  if (/@g\.us\b/i.test(trimmed)) {
    return { valid: false, e164: null, message: GUS_MESSAGE };
  }

  const prepared = sanitizePhoneRawInput(segment);
  if (!prepared) {
    return { valid: false, e164: null, message: "Enter a phone number" };
  }

  const dc = defaultCountry();
  let parsed = parsePhoneNumberFromString(prepared, dc);
  if (!parsed?.isValid() && dc) {
    parsed = parsePhoneNumberFromString(prepared);
  }
  if (!parsed?.isValid()) {
    const d = digitsOnly(prepared);
    if (d.length >= 8 && d.length <= 15) {
      parsed = parsePhoneNumberFromString(`+${d}`);
    }
  }

  if (!parsed || !parsed.isValid()) {
    return {
      valid: false,
      e164: null,
      message: GENERIC_INVALID,
    };
  }
  return { valid: true, e164: parsed.format("E.164") };
}

export function validateAndFormatPhone(raw: string): PhoneValidationResult {
  const trimmed = raw.normalize("NFC").trim();
  if (!trimmed) {
    return { valid: false, e164: null, message: "Enter a phone number" };
  }
  if (/@lid\b/i.test(trimmed) && !PHONE_VALUE_SPLIT.test(trimmed)) {
    return { valid: false, e164: null, message: LID_MESSAGE };
  }
  if (/@g\.us\b/i.test(trimmed) && !PHONE_VALUE_SPLIT.test(trimmed)) {
    return { valid: false, e164: null, message: GUS_MESSAGE };
  }

  const candidates = splitIntoPhoneCandidates(trimmed);
  let last: PhoneValidationResult = {
    valid: false,
    e164: null,
    message: GENERIC_INVALID,
  };

  for (const c of candidates) {
    const r = validateAndFormatPhoneSegment(c);
    if (r.valid) {
      return r;
    }
    last = r;
  }

  return last;
}

/**
 * For **Group grabber → Contacts** import only: WhatsApp often exposes numbers that
 * `libphonenumber` (max metadata) rejects even though messaging works. We still try
 * strict validation first, then accept E.164-shaped strings: `+[1-9]…` with 8–15 total digits.
 */
export function validatePhoneForGrabberImport(raw: string): PhoneValidationResult {
  const strict = validateAndFormatPhone(raw);
  if (strict.valid) {
    return strict;
  }

  const prepared = sanitizePhoneRawInput(raw);
  const d = digitsOnly(prepared);
  if (d.length < 8 || d.length > 15) {
    return {
      valid: false,
      e164: null,
      message:
        "Phone must be 8–15 digits in international form (after + country code).",
    };
  }
  if (d.startsWith("0")) {
    return {
      valid: false,
      e164: null,
      message:
        "International numbers cannot start with 0; include country code (e.g. +880…).",
    };
  }

  return { valid: true, e164: `+${d}` };
}

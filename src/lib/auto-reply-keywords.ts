/**
 * Trigger values: one string field with multiple entries split by comma, newline,
 * tab, `;`, `|`, `/`, fullwidth variants, **or two-or-more spaces** (single spaces
 * inside one trigger are kept). For REGEX mode, use **one pattern per line** only.
 */

/** Split on punctuation/newlines/tabs, or on 2+ whitespace chars (not a single space). */
const KEYWORD_SPLIT = /(?:[\r\n\t,，;；|｜、／/]+)|(?:\s{2,})/u;

const ZERO_WIDTH = /\u200b|\u200c|\u200d|\ufeff|\u200e|\u200f/g;

export function normalizeKeywordField(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

/** Lowercased triggers (for case-insensitive matching). */
export function parseAutoReplyKeywords(raw: string): string[] {
  const normalized = normalizeKeywordField(raw);
  return normalized
    .split(KEYWORD_SPLIT)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Preserves casing (for case-sensitive rules). */
export function parseTriggerTokens(raw: string): string[] {
  const normalized = normalizeKeywordField(raw);
  return normalized
    .split(KEYWORD_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** REGEX mode: one pattern per line. */
export function parseRegexPatterns(raw: string): string[] {
  return normalizeKeywordField(raw)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type AutoReplyTriggerTypeName =
  | "KEYWORD"
  | "EXACT"
  | "CONTAINS"
  | "STARTS_WITH"
  | "ENDS_WITH"
  | "REGEX";

export type MatchAutoReplyParams = {
  triggerType: AutoReplyTriggerTypeName | string;
  caseSensitive: boolean;
  rawKeywordField: string;
};

function normalizeTriggerType(raw: unknown): AutoReplyTriggerTypeName {
  if (raw == null) return "CONTAINS";
  const s = String(raw)
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  switch (s) {
    case "KEYWORD":
    case "EXACT":
    case "CONTAINS":
    case "STARTS_WITH":
    case "ENDS_WITH":
    case "REGEX":
      return s;
    default:
      return "CONTAINS";
  }
}

/**
 * Returns the matched trigger token/pattern string for cooldown keys, or null.
 */
export function matchAutoReplyTriggers(
  inboundText: string,
  params: MatchAutoReplyParams
): string | null {
  const triggerType = normalizeTriggerType(params.triggerType);
  const { caseSensitive, rawKeywordField } = params;

  const inboundNorm = normalizeKeywordField(inboundText);

  if (triggerType === "REGEX") {
    const patterns = parseRegexPatterns(rawKeywordField);
    if (patterns.length === 0) return null;
    for (const pattern of patterns) {
      try {
        const flags = caseSensitive ? "g" : "gi";
        const re = new RegExp(pattern, flags);
        if (re.test(inboundNorm)) return pattern;
      } catch {
        continue;
      }
    }
    return null;
  }

  const tokens = caseSensitive
    ? parseTriggerTokens(rawKeywordField)
    : parseAutoReplyKeywords(rawKeywordField);
  if (tokens.length === 0) return null;

  const hLower = inboundNorm.toLowerCase();
  const inboundTrim = inboundNorm.trim();
  const byLength = [...tokens].sort((a, b) => b.length - a.length);

  for (const t of byLength) {
    const tLower = t.toLowerCase();
    switch (triggerType) {
      case "CONTAINS":
        if (caseSensitive) {
          if (inboundNorm.includes(t)) return t;
        } else if (hLower.includes(tLower)) {
          return t;
        }
        break;
      case "EXACT": {
        if (caseSensitive) {
          if (inboundTrim === t.trim()) return t;
        } else if (inboundTrim.toLowerCase() === tLower) {
          return t;
        }
        break;
      }
      case "STARTS_WITH":
        if (caseSensitive) {
          if (inboundNorm.startsWith(t)) return t;
        } else if (hLower.startsWith(tLower)) {
          return t;
        }
        break;
      case "ENDS_WITH":
        if (caseSensitive) {
          if (inboundNorm.endsWith(t)) return t;
        } else if (hLower.endsWith(tLower)) {
          return t;
        }
        break;
      case "KEYWORD": {
        // Unicode-aware "whole token" match:
        // start/end OR a non letter/number/underscore boundary around token.
        const pat = `(^|[^\\p{L}\\p{N}_])${escapeRegExp(
          caseSensitive ? t : tLower
        )}(?=$|[^\\p{L}\\p{N}_])`;
        const re = new RegExp(pat, caseSensitive ? "gu" : "giu");
        if (re.test(inboundNorm)) return t;
        break;
      }
      default:
        break;
    }
  }
  return null;
}

/**
 * @deprecated Use matchAutoReplyTriggers with triggerType CONTAINS.
 */
export function firstMatchedTrigger(
  lowerMessage: string,
  rawKeywordField: string
): string | null {
  return matchAutoReplyTriggers(lowerMessage, {
    triggerType: "CONTAINS",
    caseSensitive: false,
    rawKeywordField,
  });
}

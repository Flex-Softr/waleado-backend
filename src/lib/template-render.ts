/**
 * Template text helpers (pure, unit tested): message versions, variables and folders/tags.
 *
 * Placeholders use single braces: {name}, {phone}, {plan}, optionally with an inline fallback
 * {name|Sir}. WhatsApp-style {{1}} placeholders are left untouched.
 */

export const BUILT_IN_VARIABLES = ["name", "phone"] as const;
export const SHOW_IN_VALUES = ["follow_up", "auto_reply", "campaign", "live_chat"] as const;
export type ShowIn = (typeof SHOW_IN_VALUES)[number];

export const MAX_VERSIONS = 5;
export const MAX_TAGS = 10;
export const MAX_VARIABLES = 20;

/** A template variable: built-ins carry their fallback in `value`, custom ones their text. */
export type TemplateVariable = { key: string; value: string };

export type RenderContext = {
  name?: string | null;
  phone?: string | null;
};

const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
// {key} or {key|fallback}, but not {{1}}.
const PLACEHOLDER_RE = /(?<!\{)\{([a-zA-Z][a-zA-Z0-9_]{0,31})(?:\|([^{}\n]{0,100}))?\}(?!\})/g;

export function normalizeVariableKey(raw: string): string | null {
  const k = raw.trim().replace(/^\{|\}$/g, "").toLowerCase();
  return KEY_RE.test(k) ? k : null;
}

export function parseVariables(value: unknown): TemplateVariable[] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  const out: TemplateVariable[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const key = typeof o.key === "string" ? normalizeVariableKey(o.key) : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const value = typeof o.value === "string" ? o.value.trim().slice(0, 300) : "";
    out.push({ key, value });
    if (out.length >= MAX_VARIABLES) break;
  }
  return out;
}

/**
 * Fills placeholders. Order for each {key}: the contact's own value (name, phone), then the
 * inline fallback ({key|x}), then the template's variable value. A built-in with nothing to
 * fill is dropped together with the space before it ("Hi {name}," → "Hi,"); an unknown key
 * with no value is left as typed so ordinary braces survive.
 */
export function renderTemplateText(
  text: string,
  variables: TemplateVariable[],
  ctx: RenderContext = {}
): string {
  const byKey = new Map(variables.map((v) => [v.key, v.value]));
  const own: Record<string, string> = {
    name: ctx.name?.trim() ?? "",
    phone: ctx.phone?.trim() ?? "",
  };
  const DROP = "\u0000";
  const out = text.replace(PLACEHOLDER_RE, (whole, rawKey: string, inline?: string) => {
    const key = rawKey.toLowerCase();
    const value = own[key] || inline?.trim() || byKey.get(key) || "";
    if (value) return value;
    return (BUILT_IN_VARIABLES as readonly string[]).includes(key) ? DROP : whole;
  });
  return out.replace(/[ \t]*\u0000/g, "").replace(/\u0000/g, "");
}

/** Cleans a list of alternate message versions: trimmed, non-empty, unique, at most 4 extra. */
export function normalizeVersions(value: unknown, primary?: string | null): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>([primary?.trim() ?? ""]);
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const t = v.trim().slice(0, 4096);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_VERSIONS - 1) break;
  }
  return out;
}

/** One of the template's versions, at random, so repeated sends do not look identical. */
export function pickVersion(
  body: string | null,
  versions: string[] | null | undefined,
  random: () => number = Math.random
): string | null {
  const all = [body?.trim() ?? "", ...(versions ?? [])].filter((s) => s.length > 0);
  if (all.length === 0) return body;
  return all[Math.min(all.length - 1, Math.floor(random() * all.length))];
}

export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const t = v.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{M}\p{N}_-]/gu, "").slice(0, 30);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Folder name typed by the owner; empty falls back to "general". */
export function normalizeFolder(value: unknown): string {
  if (typeof value !== "string") return "general";
  const t = value.trim().replace(/\s+/g, " ").slice(0, 40);
  return t || "general";
}

export function normalizeShowIn(value: unknown): ShowIn[] {
  if (!Array.isArray(value)) return [...SHOW_IN_VALUES];
  const set = new Set(value.filter((v): v is ShowIn => (SHOW_IN_VALUES as readonly string[]).includes(v as string)));
  return SHOW_IN_VALUES.filter((v) => set.has(v));
}

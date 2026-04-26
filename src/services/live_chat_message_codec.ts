export type LiveChatMediaKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "unknown";

export type LiveChatStoredMeta = {
  kind: LiveChatMediaKind;
  assetId?: string;
  mimeType?: string;
  fileName?: string;
  lat?: number;
  lng?: number;
  vcard?: string;
  caption?: string;
};

const META_PREFIX = "[LIVECHAT_META]";

export function encodeLiveChatBodyText(
  plainText: string,
  meta?: LiveChatStoredMeta
): string {
  const text = plainText.trim();
  if (!meta || meta.kind === "text") return text;
  const json = JSON.stringify(meta);
  return `${META_PREFIX}${json}\n${text}`;
}

export function decodeLiveChatBodyText(input: string): {
  text: string;
  meta: LiveChatStoredMeta;
} {
  if (!input.startsWith(META_PREFIX)) {
    return { text: input, meta: { kind: "text" } };
  }
  const nl = input.indexOf("\n");
  const jsonPart =
    nl >= 0 ? input.slice(META_PREFIX.length, nl) : input.slice(META_PREFIX.length);
  const text = nl >= 0 ? input.slice(nl + 1) : "";
  try {
    const parsed = JSON.parse(jsonPart) as LiveChatStoredMeta;
    if (!parsed || typeof parsed !== "object") {
      return { text, meta: { kind: "unknown" } };
    }
    return { text, meta: parsed };
  } catch {
    return { text: input, meta: { kind: "unknown" } };
  }
}

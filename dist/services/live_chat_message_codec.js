"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeLiveChatBodyText = encodeLiveChatBodyText;
exports.decodeLiveChatBodyText = decodeLiveChatBodyText;
const META_PREFIX = "[LIVECHAT_META]";
function encodeLiveChatBodyText(plainText, meta) {
    const text = plainText.trim();
    if (!meta || meta.kind === "text")
        return text;
    const json = JSON.stringify(meta);
    return `${META_PREFIX}${json}\n${text}`;
}
function decodeLiveChatBodyText(input) {
    if (!input.startsWith(META_PREFIX)) {
        return { text: input, meta: { kind: "text" } };
    }
    const nl = input.indexOf("\n");
    const jsonPart = nl >= 0 ? input.slice(META_PREFIX.length, nl) : input.slice(META_PREFIX.length);
    const text = nl >= 0 ? input.slice(nl + 1) : "";
    try {
        const parsed = JSON.parse(jsonPart);
        if (!parsed || typeof parsed !== "object") {
            return { text, meta: { kind: "unknown" } };
        }
        return { text, meta: parsed };
    }
    catch {
        return { text: input, meta: { kind: "unknown" } };
    }
}

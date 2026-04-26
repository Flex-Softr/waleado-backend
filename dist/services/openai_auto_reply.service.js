"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateOpenAiReply = generateOpenAiReply;
/**
 * Chat completion against an OpenAI-compatible HTTP API.
 */
async function generateOpenAiReply(settings, userMessage) {
    const key = settings.apiKey.trim();
    if (!key) {
        throw new Error("OpenAI API key is missing");
    }
    const base = (settings.baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
    const url = `${base}/chat/completions`;
    const model = settings.model?.trim() || "gpt-3.5-turbo";
    const temperature = typeof settings.temperature === "number" &&
        Number.isFinite(settings.temperature)
        ? Math.min(2, Math.max(0, settings.temperature))
        : 0.7;
    const messages = [];
    const sys = settings.systemPrompt?.trim();
    if (sys) {
        messages.push({ role: "system", content: sys });
    }
    messages.push({ role: "user", content: userMessage });
    const body = {
        model,
        messages,
        temperature,
    };
    if (settings.maxTokens != null &&
        typeof settings.maxTokens === "number" &&
        settings.maxTokens > 0) {
        body.max_tokens = Math.min(4096, settings.maxTokens);
    }
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`OpenAI HTTP ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`);
    }
    const data = (await res.json());
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
        throw new Error("OpenAI returned empty content");
    }
    return text.slice(0, 4096);
}

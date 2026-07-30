export type OpenAiSettingsInput = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number | null;
};

/**
 * Chat completion against an OpenAI-compatible HTTP API.
 */
export async function generateOpenAiReply(
  settings: OpenAiSettingsInput,
  userMessage: string
): Promise<string> {
  const key = settings.apiKey.trim();
  if (!key) {
    throw new Error("OpenAI API key is missing");
  }
  const base = (settings.baseUrl?.trim() || "https://api.openai.com/v1").replace(
    /\/$/,
    ""
  );
  const url = `${base}/chat/completions`;
  const model = settings.model?.trim() || "gpt-3.5-turbo";
  const temperature =
    typeof settings.temperature === "number" &&
    Number.isFinite(settings.temperature)
      ? Math.min(2, Math.max(0, settings.temperature))
      : 0.7;

  const messages: { role: string; content: string }[] = [];
  const sys = settings.systemPrompt?.trim();
  if (sys) {
    messages.push({ role: "system", content: sys });
  }
  messages.push({ role: "user", content: userMessage });

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
  };
  if (
    settings.maxTokens != null &&
    typeof settings.maxTokens === "number" &&
    settings.maxTokens > 0
  ) {
    body.max_tokens = Math.min(4096, settings.maxTokens);
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      // OpenRouter recommends these; harmless for Gemini / other OpenAI-compat APIs.
      "HTTP-Referer": "https://leadwhats.app",
      "X-Title": "LeadWhats",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenAI HTTP ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`
    );
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const text = extractMessageContent(data.choices?.[0]?.message?.content);
  if (!text) {
    throw new Error("OpenAI returned empty content");
  }
  return text.slice(0, 4096);
}

function extractMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const o = part as { text?: unknown; content?: unknown };
          if (typeof o.text === "string") return o.text;
          if (typeof o.content === "string") return o.content;
        }
        return "";
      })
      .join("");
    return parts.trim();
  }
  return "";
}

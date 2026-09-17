export type OpenAiSettingsInput = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number | null;
};

export type ChatHistoryMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * Chat completion against an OpenAI-compatible HTTP API.
 */
export async function generateOpenAiReply(
  settings: OpenAiSettingsInput,
  userMessage: string,
  history?: ChatHistoryMessage[]
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

  if (history && history.length > 0) {
    for (const h of history) {
      const content = h.content?.trim();
      if (content) {
        messages.push({ role: h.role, content });
      }
    }
  }

  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== userMessage.trim()) {
    if (userMessage.trim()) {
      messages.push({ role: "user", content: userMessage.trim() });
    }
  }

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

  let res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      // OpenRouter recommends these; harmless for Gemini / other OpenAI-compat APIs.
      "HTTP-Referer": "https://waleado.com",
      "X-Title": "Waleado",
    },
    body: JSON.stringify(body),
  });

  if (
    !res.ok &&
    res.status === 404 &&
    base.includes("googleapis.com") &&
    body.model !== "gemini-1.5-flash"
  ) {
    console.warn(
      `[ai] Gemini model "${body.model}" returned 404; retrying with "gemini-1.5-flash"`
    );
    body.model = "gemini-1.5-flash";
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "https://waleado.com",
        "X-Title": "Waleado",
      },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `OpenAI HTTP ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`
    );
  }

  const data = (await res.json()) as {
    choices?: {
      message?: {
        content?: unknown;
        refusal?: unknown;
      };
      text?: unknown;
    }[];
    error?: { message?: unknown };
  };

  if (data.error?.message) {
    throw new Error(String(data.error.message).slice(0, 300));
  }

  const message = data.choices?.[0]?.message;
  const refusal =
    typeof message?.refusal === "string" ? message.refusal.trim() : "";
  if (refusal) {
    throw new Error(`Model refused: ${refusal.slice(0, 200)}`);
  }

  const rawText =
    extractMessageContent(message?.content) ||
    extractMessageContent(data.choices?.[0]?.text);
  if (!rawText) {
    throw new Error("OpenAI returned empty content");
  }

  // Strip <think>...</think> blocks from reasoning models (e.g. DeepSeek R1)
  const cleanedText = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const text = cleanedText || rawText;

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
          const o = part as {
            type?: unknown;
            text?: unknown;
            content?: unknown;
          };
          // Gemini / OpenAI-compat multimodal parts: { type: "text", text: "..." }
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

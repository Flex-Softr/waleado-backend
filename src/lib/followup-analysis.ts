/**
 * Pure helpers for the AI follow-up planner: build the prompt, parse the model's JSON,
 * and turn it into a follow-up date. No database or network access here (unit tested).
 */

export const LEAD_STAGES = [
  "NEW",
  "INTERESTED",
  "READY_TO_BUY",
  "OBJECTION",
  "CONVERTED",
  "LOST",
] as const;
export type LeadStageName = (typeof LEAD_STAGES)[number];

/** Stages that never get an automatic follow-up. */
export const CLOSED_STAGES: ReadonlySet<LeadStageName> = new Set(["CONVERTED", "LOST"]);

export const DEFAULT_IDLE_HOURS = 2;
export const DEFAULT_MAX_FOLLOW_UP_DAYS = 30;
export const MAX_FOLLOW_UPS_PER_CONTACT = 3;

export type TranscriptLine = { role: "customer" | "business"; text: string };

export type AnalysisResult = {
  summary: string;
  stage: LeadStageName;
  /** Days until the follow-up; null = no follow-up needed. */
  followUpDays: number | null;
  followUpMessage: string | null;
  needsHuman: boolean;
};

export function buildAnalysisSystemPrompt(opts: {
  /** What the business sells / its follow-up preferences (from the AI skill). */
  businessContext?: string | null;
  maxDays?: number;
  /** Nth follow-up for this contact (1 = first). */
  followUpNumber?: number;
}): string {
  const maxDays = opts.maxDays ?? DEFAULT_MAX_FOLLOW_UP_DAYS;
  const parts = [
    "You review a finished WhatsApp conversation between a business and a customer and decide the follow-up.",
    "Reply with ONE JSON object and nothing else, with exactly these keys:",
    '{"summary": string, "stage": string, "followUpDays": number|null, "followUpMessage": string|null, "needsHuman": boolean}',
    "",
    "Rules:",
    "- summary: 1-2 short sentences about what the customer wanted and where it ended. Write it in the language the customer used.",
    `- stage: one of ${LEAD_STAGES.join(", ")}. NEW = just said hello; INTERESTED = asked about the product or price; READY_TO_BUY = about to buy or asked how to pay; OBJECTION = hesitating (price, trust, timing); CONVERTED = already bought or paid; LOST = clearly not interested or asked to stop.`,
    `- followUpDays: whole days from now (1-${maxDays}) when the business should follow up, based on what the customer said (for example "I will decide next week" means about 7). null if no follow-up is needed (CONVERTED, LOST, or nothing to follow up on).`,
    "- followUpMessage: the WhatsApp message to send on that day. Short, friendly, specific to this conversation, written in the customer's language, no emojis spam, no invented prices or offers. null when followUpDays is null.",
    "- needsHuman: true if a person should step in (angry customer, complex question, something the business could not answer).",
    "- If the customer says they already paid or bought, use CONVERTED and no follow-up.",
  ];
  if (opts.followUpNumber && opts.followUpNumber > 1) {
    parts.push(
      `- This is follow-up number ${opts.followUpNumber} and the customer did not answer earlier ones: wait longer and keep the message lighter.`
    );
  }
  const ctx = opts.businessContext?.trim();
  if (ctx) {
    parts.push("", "Business context and follow-up preferences:", ctx.slice(0, 3000));
  }
  return parts.join("\n");
}

export function buildTranscript(lines: TranscriptLine[], maxChars = 6000): string {
  const rendered = lines
    .map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() }))
    .filter((l) => l.text.length > 0)
    .map((l) => `${l.role === "customer" ? "Customer" : "Business"}: ${l.text}`);
  // Keep the most recent lines when over budget.
  let total = 0;
  const kept: string[] = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    total += rendered[i].length + 1;
    if (total > maxChars && kept.length > 0) break;
    kept.push(rendered[i]);
  }
  return kept.reverse().join("\n");
}

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

export function parseAnalysis(
  raw: string,
  opts: { maxDays?: number } = {}
): AnalysisResult | null {
  const maxDays = opts.maxDays ?? DEFAULT_MAX_FOLLOW_UP_DAYS;
  const json = extractJsonObject(raw);
  if (!json) return null;
  let o: Record<string, unknown>;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const summary = typeof o.summary === "string" ? o.summary.trim().slice(0, 1000) : "";
  if (!summary) return null;

  const stageRaw = typeof o.stage === "string" ? o.stage.trim().toUpperCase().replace(/[\s-]+/g, "_") : "";
  const stage = (LEAD_STAGES as readonly string[]).includes(stageRaw)
    ? (stageRaw as LeadStageName)
    : "NEW";

  let followUpDays: number | null = null;
  const d = typeof o.followUpDays === "string" ? Number(o.followUpDays) : o.followUpDays;
  if (typeof d === "number" && Number.isFinite(d) && d > 0) {
    followUpDays = Math.min(maxDays, Math.max(1, Math.round(d)));
  }

  const msgRaw = typeof o.followUpMessage === "string" ? o.followUpMessage.trim() : "";
  const followUpMessage = msgRaw ? msgRaw.slice(0, 1500) : null;

  const closed = CLOSED_STAGES.has(stage);
  const schedule = !closed && followUpDays !== null && followUpMessage !== null;

  return {
    summary,
    stage,
    followUpDays: schedule ? followUpDays : null,
    followUpMessage: schedule ? followUpMessage : null,
    needsHuman: o.needsHuman === true,
  };
}

export function computeFollowUpAt(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 3_600_000);
}

/** Next wait grows for each unanswered follow-up: later reminders come less often. */
export function stretchDays(days: number, followUpsSent: number, maxDays = DEFAULT_MAX_FOLLOW_UP_DAYS): number {
  const factor = 1 + Math.max(0, followUpsSent) * 0.5;
  return Math.min(maxDays, Math.max(1, Math.round(days * factor)));
}

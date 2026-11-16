/**
 * Decides which auto-reply rule answers an inbound message.
 *
 * Order: an explicit keyword match always wins; otherwise, for private chats only, an
 * unexpired AI conversation keeps going without a keyword; otherwise the device's
 * "new chats" fallback AI rule (if any) answers.
 */

export const MAX_CONVERSATION_HOURS = 24 * 14;
export const DEFAULT_CONVERSATION_HOURS = 24;

export type RoutableRule = {
  id: string;
  /** True for rules that answer through an AI skill / OpenAI settings. */
  isAi: boolean;
  /** Hours the AI keeps answering after its last reply. 0 disables continuation. */
  conversationHours: number;
  /** Answers private chats that match no keyword. */
  fallbackForNewChats: boolean;
};

export type RouteSource = "keyword" | "conversation" | "fallback";

export type RouteDecision<T extends RoutableRule> = {
  rule: T;
  source: RouteSource;
};

/** Private 1:1 chats only: never groups, broadcast lists, status or newsletters. */
export function isPrivateChatJid(jid: string): boolean {
  const j = jid.toLowerCase();
  return j.endsWith("@s.whatsapp.net") || j.endsWith("@lid");
}

export function clampConversationHours(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_CONVERSATION_HOURS;
  return Math.min(MAX_CONVERSATION_HOURS, Math.max(0, Math.round(hours)));
}

export function conversationExpiry(now: number, hours: number): Date {
  return new Date(now + clampConversationHours(hours) * 3_600_000);
}

export function chooseRule<T extends RoutableRule>(args: {
  keywordRule: T | null;
  /** Rule id of the contact's active, unexpired AI conversation (if any). */
  activeRuleId: string | null;
  /** Active rules for the device, already ordered by priority. */
  rules: T[];
  privateChat: boolean;
}): RouteDecision<T> | null {
  if (args.keywordRule) {
    return { rule: args.keywordRule, source: "keyword" };
  }
  if (!args.privateChat) return null;

  if (args.activeRuleId) {
    const active = args.rules.find((r) => r.id === args.activeRuleId);
    if (active && active.isAi && active.conversationHours > 0) {
      return { rule: active, source: "conversation" };
    }
  }

  const fallback = args.rules.find((r) => r.isAi && r.fallbackForNewChats);
  if (fallback) {
    return { rule: fallback, source: "fallback" };
  }
  return null;
}

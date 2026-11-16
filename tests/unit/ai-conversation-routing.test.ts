import { describe, expect, it } from "vitest";
import {
  chooseRule,
  clampConversationHours,
  conversationExpiry,
  isPrivateChatJid,
  type RoutableRule,
} from "../../src/lib/ai-conversation-routing";

const rule = (over: Partial<RoutableRule> & { id: string }): RoutableRule => ({
  isAi: true,
  conversationHours: 24,
  fallbackForNewChats: false,
  ...over,
});

describe("isPrivateChatJid", () => {
  it("accepts 1:1 chats and rejects groups, status and broadcasts", () => {
    expect(isPrivateChatJid("8801700000000@s.whatsapp.net")).toBe(true);
    expect(isPrivateChatJid("12345@lid")).toBe(true);
    expect(isPrivateChatJid("12345-678@g.us")).toBe(false);
    expect(isPrivateChatJid("status@broadcast")).toBe(false);
    expect(isPrivateChatJid("123@newsletter")).toBe(false);
  });
});

describe("clampConversationHours / conversationExpiry", () => {
  it("clamps to 0..14 days and handles bad input", () => {
    expect(clampConversationHours(-5)).toBe(0);
    expect(clampConversationHours(24)).toBe(24);
    expect(clampConversationHours(10_000)).toBe(24 * 14);
    expect(clampConversationHours(Number.NaN)).toBe(24);
  });
  it("adds whole hours", () => {
    expect(conversationExpiry(0, 2).getTime()).toBe(2 * 3_600_000);
  });
});

describe("chooseRule", () => {
  const ai = rule({ id: "ai" });
  const other = rule({ id: "kw", isAi: false });
  const fb = rule({ id: "fb", fallbackForNewChats: true });

  it("keyword match always wins", () => {
    const d = chooseRule({ keywordRule: other, activeRuleId: "ai", rules: [ai, other], privateChat: true });
    expect(d).toEqual({ rule: other, source: "keyword" });
  });

  it("continues an active AI conversation without a keyword", () => {
    const d = chooseRule({ keywordRule: null, activeRuleId: "ai", rules: [ai, other], privateChat: true });
    expect(d).toEqual({ rule: ai, source: "conversation" });
  });

  it("does not continue when hours is 0, rule is gone, or rule is not AI", () => {
    expect(chooseRule({ keywordRule: null, activeRuleId: "ai", rules: [rule({ id: "ai", conversationHours: 0 })], privateChat: true })).toBeNull();
    expect(chooseRule({ keywordRule: null, activeRuleId: "gone", rules: [ai], privateChat: true })).toBeNull();
    expect(chooseRule({ keywordRule: null, activeRuleId: "kw", rules: [other], privateChat: true })).toBeNull();
  });

  it("uses the fallback AI rule for new private chats only", () => {
    expect(chooseRule({ keywordRule: null, activeRuleId: null, rules: [ai, fb], privateChat: true })).toEqual({ rule: fb, source: "fallback" });
    expect(chooseRule({ keywordRule: null, activeRuleId: null, rules: [ai, fb], privateChat: false })).toBeNull();
  });

  it("prefers the active conversation over the fallback", () => {
    const d = chooseRule({ keywordRule: null, activeRuleId: "ai", rules: [ai, fb], privateChat: true });
    expect(d?.source).toBe("conversation");
  });

  it("stays silent when nothing applies", () => {
    expect(chooseRule({ keywordRule: null, activeRuleId: null, rules: [ai, other], privateChat: true })).toBeNull();
  });
});

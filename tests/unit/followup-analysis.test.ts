import { describe, expect, it } from "vitest";
import {
  buildAnalysisSystemPrompt,
  buildTranscript,
  computeFollowUpAt,
  parseAnalysis,
  stretchDays,
} from "../../src/lib/followup-analysis";

describe("parseAnalysis", () => {
  it("parses a plain JSON answer", () => {
    const r = parseAnalysis(
      JSON.stringify({
        summary: "Asked for Business hosting price.",
        stage: "INTERESTED",
        followUpDays: 3,
        followUpMessage: "Hi! Any questions about the plan?",
        needsHuman: false,
      })
    );
    expect(r).toEqual({
      summary: "Asked for Business hosting price.",
      stage: "INTERESTED",
      followUpDays: 3,
      followUpMessage: "Hi! Any questions about the plan?",
      needsHuman: false,
    });
  });

  it("extracts JSON from a fenced code block with chatter around it", () => {
    const r = parseAnalysis('Sure!\n```json\n{"summary":"ok","stage":"ready to buy","followUpDays":"2","followUpMessage":"Ping","needsHuman":true}\n```');
    expect(r?.stage).toBe("READY_TO_BUY");
    expect(r?.followUpDays).toBe(2);
    expect(r?.needsHuman).toBe(true);
  });

  it("clamps days to the allowed range and rounds", () => {
    expect(parseAnalysis('{"summary":"s","stage":"OBJECTION","followUpDays":400,"followUpMessage":"m"}')?.followUpDays).toBe(30);
    expect(parseAnalysis('{"summary":"s","stage":"OBJECTION","followUpDays":0.2,"followUpMessage":"m"}')?.followUpDays).toBe(1);
  });

  it("drops the follow-up for closed stages or missing message", () => {
    const conv = parseAnalysis('{"summary":"bought","stage":"CONVERTED","followUpDays":5,"followUpMessage":"hi"}');
    expect(conv?.followUpDays).toBeNull();
    expect(conv?.followUpMessage).toBeNull();
    const noMsg = parseAnalysis('{"summary":"s","stage":"INTERESTED","followUpDays":5,"followUpMessage":""}');
    expect(noMsg?.followUpDays).toBeNull();
  });

  it("falls back to NEW for unknown stages and rejects bad output", () => {
    expect(parseAnalysis('{"summary":"s","stage":"weird","followUpDays":null,"followUpMessage":null}')?.stage).toBe("NEW");
    expect(parseAnalysis("not json")).toBeNull();
    expect(parseAnalysis('{"stage":"NEW"}')).toBeNull();
    expect(parseAnalysis("[1,2]")).toBeNull();
  });
});

describe("buildTranscript", () => {
  it("labels roles, skips empty lines and keeps the latest lines within budget", () => {
    const t = buildTranscript([
      { role: "customer", text: "a".repeat(50) },
      { role: "business", text: "   " },
      { role: "customer", text: "last   message" },
    ], 40);
    expect(t).toBe("Customer: last message");
    expect(buildTranscript([{ role: "business", text: "Hello" }, { role: "customer", text: "Hi" }])).toBe("Business: Hello\nCustomer: Hi");
  });
});

describe("dates and prompt", () => {
  it("adds whole days", () => {
    expect(computeFollowUpAt(new Date("2026-11-16T00:00:00Z"), 10).toISOString()).toBe("2026-11-26T00:00:00.000Z");
  });
  it("waits longer after each unanswered follow-up, capped", () => {
    expect(stretchDays(2, 0)).toBe(2);
    expect(stretchDays(2, 1)).toBe(3);
    expect(stretchDays(10, 5)).toBe(30);
  });
  it("includes business context only when given", () => {
    expect(buildAnalysisSystemPrompt({})).not.toContain("Business context");
    expect(buildAnalysisSystemPrompt({ businessContext: "Hosting seller" })).toContain("Hosting seller");
    expect(buildAnalysisSystemPrompt({ followUpNumber: 2 })).toContain("follow-up number 2");
  });
});

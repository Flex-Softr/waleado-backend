import { describe, expect, it } from "vitest";
import {
  normalizeFolder,
  normalizeShowIn,
  normalizeTags,
  normalizeVersions,
  parseVariables,
  pickVersion,
  renderTemplateText,
} from "../../src/lib/template-render";

describe("renderTemplateText", () => {
  const vars = [{ key: "name", value: "Sir" }, { key: "plan", value: "Business" }];

  it("fills contact values first, then inline fallback, then the template value", () => {
    expect(renderTemplateText("Hi {name}, the {plan} plan", vars, { name: "Rahim" })).toBe("Hi Rahim, the Business plan");
    expect(renderTemplateText("Hi {name}", vars, {})).toBe("Hi Sir");
    expect(renderTemplateText("Hi {name|bhai}", [], {})).toBe("Hi bhai");
    expect(renderTemplateText("Hi {NAME}", [], { name: "Karim" })).toBe("Hi Karim");
    expect(renderTemplateText("Call {phone}", [], { phone: "+8801700000000" })).toBe("Call +8801700000000");
  });

  it("drops empty built-ins cleanly and keeps unknown keys and {{1}}", () => {
    expect(renderTemplateText("Hi {name}, welcome", [], {})).toBe("Hi, welcome");
    expect(renderTemplateText("Code {order_id} and {{1}}", [], {})).toBe("Code {order_id} and {{1}}");
  });
});

describe("versions", () => {
  it("cleans and caps alternate versions", () => {
    expect(normalizeVersions([" a ", "", "a", "b", 3, "c", "d", "e"], "main")).toEqual(["a", "b", "c", "d"]);
    expect(normalizeVersions(["main", "x"], "main")).toEqual(["x"]);
    expect(normalizeVersions("nope")).toEqual([]);
  });
  it("picks any version", () => {
    expect(pickVersion("one", ["two", "three"], () => 0)).toBe("one");
    expect(pickVersion("one", ["two", "three"], () => 0.99)).toBe("three");
    expect(pickVersion(null, [], () => 0.5)).toBeNull();
  });
});

describe("variables, tags, folders, showIn", () => {
  it("parses variables safely", () => {
    expect(parseVariables([{ key: "{Plan}", value: " Pro " }, { key: "plan", value: "dup" }, { key: "9bad", value: "x" }, null]))
      .toEqual([{ key: "plan", value: "Pro" }]);
    expect(parseVariables("[]")).toEqual([]);
  });
  it("normalizes tags and folders", () => {
    expect(normalizeTags(["Eid Offer", "eid-offer", "  ", "হোস্টিং"])).toEqual(["eid-offer", "হোস্টিং"]);
    expect(normalizeFolder("  Follow   up ")).toBe("Follow up");
    expect(normalizeFolder("")).toBe("general");
  });
  it("defaults showIn to everywhere and drops unknown places", () => {
    expect(normalizeShowIn(undefined)).toEqual(["follow_up", "auto_reply", "campaign", "live_chat"]);
    expect(normalizeShowIn(["live_chat", "nope", "follow_up"])).toEqual(["follow_up", "live_chat"]);
  });
});

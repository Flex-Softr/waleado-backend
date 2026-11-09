import { describe, expect, it } from "vitest";
import { createPayToken, payLinkUrl, verifyPayToken } from "../../src/billing/invoices/pay-link";

const invoiceId = "0b6a3c1e-1111-4222-8333-944455556666";

describe("invoice pay links", () => {
  it("round-trips a genuine token", () => {
    expect(verifyPayToken(createPayToken(invoiceId))).toBe(invoiceId);
  });

  it("rejects a token pointed at another invoice", () => {
    const signature = createPayToken(invoiceId).split(".")[1];
    expect(verifyPayToken(`0b6a3c1e-1111-4222-8333-000000000000.${signature}`)).toBeNull();
  });

  it("rejects tampered, truncated and malformed tokens", () => {
    const token = createPayToken(invoiceId);
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyPayToken(flipped)).toBeNull();
    expect(verifyPayToken(token.slice(0, -4))).toBeNull();
    expect(verifyPayToken(invoiceId)).toBeNull();
    expect(verifyPayToken(".abc")).toBeNull();
    expect(verifyPayToken("")).toBeNull();
  });

  it("builds the public URL on the app domain", () => {
    expect(payLinkUrl(invoiceId)).toBe(`https://app.example.test/pay/${createPayToken(invoiceId)}`);
  });
});

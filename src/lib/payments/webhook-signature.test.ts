import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyWebhookSignature } from "./webhook-signature";

const SECRET = "whsec_test_abc123";
const BODY = '{"event":"payment.succeeded","amount":4500,"currency":"MZN"}';

const sign = (body: string, secret = SECRET, prefix = "") =>
  prefix + crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: sign(BODY),
        secret: SECRET,
      }),
    ).toBe(true);
  });

  it("accepts a prefixed digest when the provider uses one", () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: sign(BODY, SECRET, "sha256="),
        secret: SECRET,
        prefix: "sha256=",
      }),
    ).toBe(true);
  });

  it("rejects a body that was tampered with after signing", () => {
    const tampered = BODY.replace("4500", "1");
    expect(
      verifyWebhookSignature({
        rawBody: tampered,
        signatureHeader: sign(BODY),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: sign(BODY, "whsec_attacker"),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: null,
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("FAILS CLOSED when the secret is not configured", () => {
    // The whole point: an operator who forgets the env var gets a dead
    // webhook, never a forgeable one.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: sign(BODY),
        secret: undefined,
      }),
    ).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects a truncated signature without throwing", () => {
    // timingSafeEqual throws on a length mismatch — we must guard it.
    expect(() =>
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: sign(BODY).slice(0, 20),
        secret: SECRET,
      }),
    ).not.toThrow();
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: sign(BODY).slice(0, 20),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("rejects an empty-string signature", () => {
    expect(
      verifyWebhookSignature({
        rawBody: BODY,
        signatureHeader: "",
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it("is sensitive to key order — proving we must sign the RAW body", () => {
    // Re-serialising the parsed JSON changes the bytes, so a handler
    // that verifies against JSON.stringify(JSON.parse(body)) breaks.
    const reserialised = JSON.stringify(JSON.parse(BODY));
    const reordered = '{"currency":"MZN","amount":4500,"event":"payment.succeeded"}';
    expect(reserialised).not.toBe(reordered);
    expect(
      verifyWebhookSignature({
        rawBody: reordered,
        signatureHeader: sign(BODY),
        secret: SECRET,
      }),
    ).toBe(false);
  });
});

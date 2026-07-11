import crypto from "node:crypto";

/**
 * Verify the HMAC signature on an inbound payment-provider webhook.
 *
 * This is the ONLY thing standing between our billing system and
 * anyone who guesses the webhook URL. Without it, a stranger can POST
 * `{"status":"paid"}` and grant themselves a subscription — the
 * endpoint is public by necessity (the provider must reach it) and
 * carries no user session.
 *
 * Contract, deliberately strict:
 *
 *   - The secret is REQUIRED. If it isn't configured we reject every
 *     request rather than falling open. An operator who forgets the env
 *     var gets a dead webhook, not a forgeable one. (Same stance as
 *     verifyMetaWebhookSignature — see lib/whatsapp/webhook-signature.)
 *
 *   - Comparison is timing-safe. A byte-by-byte `===` leaks how much of
 *     a guessed signature was correct, which is enough to forge one.
 *
 *   - The signature MUST be computed over the RAW request body, before
 *     any JSON parsing. `JSON.parse` → `JSON.stringify` reorders keys
 *     and drops whitespace, producing a different digest and a
 *     verification that always fails (or, worse, one you "fix" by
 *     disabling the check).
 *
 * `algorithm` and `prefix` are parameters because providers differ:
 * Meta sends `sha256=<hex>`, Stripe sends `t=..,v1=..`, others send a
 * bare hex digest. Fill them in from the provider's spec — do not guess.
 */
export function verifyWebhookSignature({
  rawBody,
  signatureHeader,
  secret,
  algorithm = "sha256",
  prefix = "",
}: {
  rawBody: string;
  signatureHeader: string | null;
  secret: string | undefined;
  algorithm?: string;
  /** e.g. "sha256=" when the provider prefixes the digest. */
  prefix?: string;
}): boolean {
  if (!secret) {
    console.error(
      "[payments/webhook] signing secret is not configured — rejecting. " +
        "Set the provider's webhook secret in the environment to enable " +
        "signature verification.",
    );
    return false;
  }

  if (!signatureHeader) return false;

  const expected =
    prefix +
    crypto.createHmac(algorithm, secret).update(rawBody, "utf8").digest("hex");

  const a = Buffer.from(signatureHeader.trim());
  const b = Buffer.from(expected);

  // timingSafeEqual throws on length mismatch, so check first. Length
  // is not a secret — the digest length is fixed by the algorithm.
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

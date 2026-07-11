import { NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/payments/webhook-signature";
import { billingAdmin } from "@/lib/billing/admin-client";

/**
 * DebitoPay webhook — the authoritative "money arrived" signal for the
 * asynchronous methods (e-Mola, mKesh, cards). Registered in their
 * dashboard as https://app.byteboost.co.mz/api/debitopay/webhook.
 *
 * This endpoint is public and unauthenticated by nature, which makes it
 * the most attacked surface in the billing system. Its defenses, in the
 * order they run:
 *
 *   1. HMAC-SHA256 over the RAW body, compared timing-safe against the
 *      `x-webhook-signature` header (bare hex, per docs/debitopay.md).
 *      Fail-closed when the secret env var is missing.
 *   2. Replay protection: the (event, payment_id) pair is recorded in
 *      payment_webhook_events BEFORE acting; a duplicate delivery hits
 *      the unique constraint and is acknowledged without effect.
 *      DebitoPay retries for up to 24h, so duplicates are expected.
 *   3. Amount verification + idempotence live in the database:
 *      confirm_payment_service() raises on underpayment and on
 *      re-confirmation. Even a bug in this handler cannot double-credit
 *      or credit a short payment.
 *
 * Always answers 200 quickly (provider requires < 5s; retries on
 * anything else). Errors that WE should retry get a non-200 — that is
 * exactly the signature failure (maybe a secret rotation mid-flight)
 * and nothing else.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const valid = verifyWebhookSignature({
    rawBody,
    signatureHeader: request.headers.get("x-webhook-signature"),
    secret: process.env.DEBITOPAY_WEBHOOK_SECRET,
    // DebitoPay sends the bare hex digest — no "sha256=" prefix.
    prefix: "",
  });

  if (!valid) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: {
    event?: string;
    data?: {
      payment_id?: string;
      amount?: number;
      currency?: string;
      method?: string;
      reference?: string;
      paid_at?: string;
    };
    timestamp?: string;
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Signed but malformed — acknowledge so they stop retrying; there
    // is nothing a retry of the same bytes would fix.
    return NextResponse.json({ received: true, ignored: "malformed" });
  }

  const event = payload.event;
  const providerPaymentId = payload.data?.payment_id;

  if (!event || !providerPaymentId) {
    return NextResponse.json({ received: true, ignored: "incomplete" });
  }

  const admin = billingAdmin();

  // ---- Replay protection ------------------------------------------
  // DebitoPay's payload carries no event id of its own, so the dedupe
  // key is (event type, provider payment id) — "payment X completed"
  // can only ever be processed once, which is also the business rule.
  const { error: replayError } = await admin
    .from("payment_webhook_events")
    .insert({
      provider: "debitopay",
      event_id: `${event}:${providerPaymentId}`,
      payload,
    });

  if (replayError) {
    // 23505 = unique_violation → a retry of something already handled.
    if (replayError.code === "23505") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    console.error("[debitopay/webhook] event log failed:", replayError.message);
    // Fall through — losing the log must not lose a payment; the
    // database-side idempotence still protects against double-credit.
  }

  // ---- Correlate back to our payment row ---------------------------
  const { data: payment } = await admin
    .from("payments")
    .select("id, amount, status, account_id")
    .eq("provider", "debitopay")
    .eq("provider_reference", providerPaymentId)
    .maybeSingle();

  if (!payment) {
    // Not ours (another system on the same merchant account?) or the
    // create-route crashed before storing provider_reference. Log it —
    // an operator can reconcile via check-status — but acknowledge.
    console.warn(
      "[debitopay/webhook] no matching payment for",
      providerPaymentId,
      event,
    );
    return NextResponse.json({ received: true, unmatched: true });
  }

  switch (event) {
    case "payment.completed": {
      if (payment.status === "confirmed") {
        return NextResponse.json({ received: true, already: true });
      }

      const { error: confirmError } = await admin.rpc(
        "confirm_payment_service",
        {
          payment_id: payment.id,
          paid_amount: payload.data?.amount ?? null,
          provider_ref: payload.data?.reference ?? null,
        },
      );

      if (confirmError) {
        // Underpayment or a transient DB failure. Underpayment is a
        // permanent condition — flag the row for the operator instead
        // of letting the provider retry into the same wall forever.
        console.error(
          "[debitopay/webhook] confirm failed for",
          payment.id,
          confirmError.message,
        );
        await admin
          .from("payments")
          .update({ provider_status: "completed_unverified" })
          .eq("id", payment.id);
        return NextResponse.json({ received: true, flagged: true });
      }

      return NextResponse.json({ received: true, confirmed: true });
    }

    case "payment.failed": {
      // Never regress a confirmed payment on a late/failed duplicate.
      if (payment.status !== "confirmed") {
        await admin
          .from("payments")
          .update({ status: "rejected", provider_status: "failed" })
          .eq("id", payment.id);
      }
      return NextResponse.json({ received: true });
    }

    case "payment.refunded":
    case "payment.chargeback": {
      // Money went back out. Deciding what happens to the subscription
      // (revoke the period? suspend?) is an operator judgement call —
      // record the fact loudly and leave the decision to /admin.
      console.warn(
        `[debitopay/webhook] ${event} on payment`,
        payment.id,
        "account",
        payment.account_id,
      );
      await admin
        .from("payments")
        .update({ provider_status: event.replace("payment.", "") })
        .eq("id", payment.id);
      return NextResponse.json({ received: true });
    }

    default:
      return NextResponse.json({ received: true, ignored: event });
  }
}

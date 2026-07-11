import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { billingAdmin } from "@/lib/billing/admin-client";
import type { PaymentMethod } from "@/lib/billing/types";
import {
  createDebitopayPayment,
  getDebitopayConfig,
  type DebitopayMethod,
} from "@/lib/payments/debitopay";

const METHODS: PaymentMethod[] = [
  "mpesa",
  "emola",
  "bank_transfer",
  "cash",
  "other",
];

// Methods the popup can charge automatically through DebitoPay. `mkesh`
// and `visa_mastercard` ride on the provider but map onto our schema's
// method enum as "other" (adding enum values is a migration; the
// provider column already records the truth).
const AUTO_METHODS = ["mpesa", "emola", "mkesh", "visa_mastercard"] as const;
type AutoMethod = (typeof AUTO_METHODS)[number];

const toDbMethod = (m: AutoMethod): PaymentMethod =>
  m === "mpesa" || m === "emola" ? m : "other";

/**
 * Accept +258XXXXXXXXX / 258XXXXXXXXX / 8XXXXXXXX and normalise to
 * +258XXXXXXXXX. Anything else is rejected before it reaches the
 * provider — their error for a bad msisdn is less actionable than ours.
 */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (/^258[0-9]{9}$/.test(digits)) return `+${digits}`;
  if (/^8[0-9]{8}$/.test(digits)) return `+258${digits}`;
  return null;
}

// The M-Pesa charge is synchronous on the provider side — the HTTP call
// waits for the customer's PIN. Keep the route alive long enough.
export const maxDuration = 120;

/**
 * POST /api/billing/payments — a customer declares "I paid".
 *
 * This creates a PENDING claim, nothing more. It grants no access:
 * only `confirm_payment()` (platform-admin only, migration 039) moves
 * a subscription. The RLS policy on `payments` independently pins
 * inserts to status='pending' and to account admins, so a forged REST
 * call straight at PostgREST can't bypass this route either.
 *
 * The amount and plan are recorded as CLAIMED by the customer — they
 * are not trusted. The operator reconciles them against the M-Pesa
 * statement before confirming.
 */
export async function POST(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", user.id)
    .maybeSingle();

  const accountId = profile?.account_id as string | undefined;
  if (!accountId) {
    return NextResponse.json(
      { error: "Your profile is not linked to an account." },
      { status: 403 },
    );
  }

  if (!["owner", "admin"].includes(profile?.account_role ?? "")) {
    return NextResponse.json(
      { error: "Only account admins can submit a payment." },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { plan_id, method, reference, period_months, notes, pay_now, phone } =
    body as {
      plan_id?: string;
      method?: string;
      reference?: string;
      period_months?: number;
      notes?: string;
      /** True = charge through DebitoPay now (the popup). */
      pay_now?: boolean;
      /** Mobile-money wallet for the USSD push. */
      phone?: string;
    };

  if (!plan_id) {
    return NextResponse.json({ error: "plan_id is required" }, { status: 400 });
  }

  const isAutoMethod = AUTO_METHODS.includes(method as AutoMethod);

  if (pay_now && !isAutoMethod) {
    return NextResponse.json(
      { error: `pay_now supports: ${AUTO_METHODS.join(", ")}` },
      { status: 400 },
    );
  }
  if (pay_now && !getDebitopayConfig()) {
    return NextResponse.json(
      { error: "Automated payments are not configured on this server." },
      { status: 503 },
    );
  }

  let normalizedPhone: string | null = null;
  if (pay_now && method !== "visa_mastercard") {
    normalizedPhone = phone ? normalizePhone(phone) : null;
    if (!normalizedPhone) {
      return NextResponse.json(
        { error: "invalid_phone", code: "invalid_phone" },
        { status: 400 },
      );
    }
  }

  const payMethod: PaymentMethod = pay_now
    ? toDbMethod(method as AutoMethod)
    : ((method ?? "mpesa") as PaymentMethod);
  if (!METHODS.includes(payMethod)) {
    return NextResponse.json(
      { error: `method must be one of: ${METHODS.join(", ")}` },
      { status: 400 },
    );
  }

  const months = Number(period_months ?? 1);
  if (!Number.isInteger(months) || months < 1 || months > 36) {
    return NextResponse.json(
      { error: "period_months must be a whole number between 1 and 36" },
      { status: 400 },
    );
  }

  // Price the claim from the PLAN, not from anything the client sent.
  // Taking an amount off the request body would let a customer file a
  // "1 MT" claim for the unlimited plan and hope the operator rubber-
  // stamps it.
  const { data: plan } = await supabase
    .from("plans")
    .select("id, price, currency, is_active")
    .eq("id", plan_id)
    .maybeSingle();

  if (!plan || !plan.is_active) {
    return NextResponse.json(
      { error: "That plan does not exist or is no longer offered." },
      { status: 400 },
    );
  }

  // The insert runs on the CALLER's client on purpose: the RLS insert
  // policy is what enforces "account admin, status pending". Only the
  // provider bookkeeping below needs the service role.
  const { data, error } = await supabase
    .from("payments")
    .insert({
      account_id: accountId,
      plan_id: plan.id,
      amount: Number(plan.price) * months,
      currency: plan.currency,
      method: payMethod,
      reference: reference?.trim() || null,
      period_months: months,
      notes: notes?.trim() || null,
      status: "pending",
      submitted_by: user.id,
      provider: pay_now ? "debitopay" : "manual",
    })
    .select(
      "id, plan_id, amount, currency, method, reference, period_months, status, notes, created_at",
    )
    .single();

  if (error) {
    console.error("[billing/payments] insert failed:", error.message);
    return NextResponse.json(
      { error: "Could not record the payment." },
      { status: 500 },
    );
  }

  if (!pay_now) {
    return NextResponse.json({ payment: data }, { status: 201 });
  }

  // ---- Automated charge through DebitoPay ------------------------
  const admin = billingAdmin();
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";

  const charge = await createDebitopayPayment({
    method: method as DebitopayMethod,
    amount: Number(plan.price) * months,
    currency: plan.currency,
    phone: normalizedPhone ?? undefined,
    // Hosted Checkout sends the customer back to the billing screen;
    // the real confirmation still arrives via webhook.
    returnUrl:
      method === "visa_mastercard"
        ? `${siteUrl}/settings?tab=billing`
        : undefined,
    sourceId: data.id,
    customerEmail: user.email ?? undefined,
  });

  // Record what the provider said, whatever it was. provider_reference
  // is how the webhook finds this row later — losing it orphans the
  // payment, so this update happens before any early return.
  await admin
    .from("payments")
    .update({
      provider_reference: charge.providerPaymentId,
      provider_status: charge.status,
      reference: charge.reference ?? data.reference,
    })
    .eq("id", data.id);

  if (!charge.ok) {
    await admin
      .from("payments")
      .update({ status: "rejected", provider_status: "failed" })
      .eq("id", data.id);
    // PROVIDER_TIMEOUT is special: the push may still be on the
    // customer's phone and the webhook may yet confirm. The webhook
    // path re-confirms a rejected row fine (it flips status), so
    // rejecting here is safe — but tell the client which case it is.
    return NextResponse.json(
      {
        payment: { ...data, status: "rejected" },
        provider: { status: "failed", error: charge.error },
      },
      { status: 502 },
    );
  }

  if (charge.status === "success") {
    // M-Pesa's synchronous path: the customer already typed their PIN.
    // We trust it because WE made this call over TLS to the provider —
    // this is not client input. The amount is the one we charged.
    const { data: sub, error: confirmError } = await admin.rpc(
      "confirm_payment_service",
      {
        payment_id: data.id,
        paid_amount: Number(plan.price) * months,
        provider_ref: charge.reference,
      },
    );

    if (confirmError) {
      // Money moved but our subscription write failed — the one state
      // we must never leave silent. The webhook retry will fix it;
      // log loudly in case it doesn't.
      console.error(
        "[billing/payments] PAID BUT NOT CONFIRMED:",
        data.id,
        confirmError.message,
      );
      return NextResponse.json(
        {
          payment: data,
          provider: { status: "success" },
          warning: "paid_pending_activation",
        },
        { status: 201 },
      );
    }

    return NextResponse.json(
      {
        payment: { ...data, status: "confirmed" },
        provider: { status: "success" },
        subscription: sub,
      },
      { status: 201 },
    );
  }

  // pending — e-Mola/mKesh push sent, or card checkout created. The
  // webhook completes it; the popup polls until then.
  return NextResponse.json(
    {
      payment: data,
      provider: {
        status: "pending",
        checkout_url: charge.checkoutUrl,
      },
    },
    { status: 201 },
  );
}

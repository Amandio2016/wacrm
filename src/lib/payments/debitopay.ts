/**
 * DebitoPay adapter — the only file that knows how to talk to the
 * provider. Everything else (routes, popup, webhook) works with the
 * shapes returned here, so a provider change stays contained.
 *
 * API reference: docs/debitopay.md (local copy of the official docs).
 *
 * The one behavioural surprise worth knowing before touching this:
 * M-Pesa charges are SYNCHRONOUS — the HTTP call blocks until the
 * customer types their PIN (or the push times out). Callers must use a
 * generous timeout and never run this inside anything latency-bound.
 * e-Mola/mKesh return `pending` immediately and confirm via webhook.
 */

const BASE_URL = "https://gyqoaningqhurhvdugne.supabase.co/functions/v1";

/** M-Pesa waits for a human to type a PIN on a phone. */
const REQUEST_TIMEOUT_MS = 110_000;

export type DebitopayMethod =
  | "mpesa"
  | "emola"
  | "mkesh"
  | "visa_mastercard";

export const DEBITOPAY_METHODS: DebitopayMethod[] = [
  "mpesa",
  "emola",
  "mkesh",
  "visa_mastercard",
];

interface DebitopayConfig {
  apiKey: string;
  merchantId: string;
  /** One wallet per payment method — that's how DebitoPay models it
   *  (each merchant wallet carries a `payment_method`). A method whose
   *  wallet env var is unset is simply not offered. */
  wallets: Partial<Record<DebitopayMethod, string>>;
}

/**
 * Null when the key or merchant id is missing, or when NO wallet is
 * configured — the caller treats that as "automated payments not
 * configured" and falls back to the manual flow, rather than
 * half-working with a cryptic provider error.
 */
export function getDebitopayConfig(): DebitopayConfig | null {
  const apiKey = process.env.DEBITOPAY_API_KEY;
  const merchantId = process.env.DEBITOPAY_MERCHANT_ID;
  if (!apiKey || !merchantId) return null;

  const wallets: DebitopayConfig["wallets"] = {
    mpesa: process.env.DEBITOPAY_WALLET_MPESA || undefined,
    emola: process.env.DEBITOPAY_WALLET_EMOLA || undefined,
    mkesh: process.env.DEBITOPAY_WALLET_MKESH || undefined,
    visa_mastercard: process.env.DEBITOPAY_WALLET_CARD || undefined,
  };

  if (!Object.values(wallets).some(Boolean)) return null;
  return { apiKey, merchantId, wallets };
}

export interface CreatePaymentInput {
  method: DebitopayMethod;
  /** Major units (meticais). Computed from the plan — never client input. */
  amount: number;
  currency: string;
  /** Mobile-money wallet number. Required for mpesa/emola/mkesh. */
  phone?: string;
  /** Where Hosted Checkout returns the customer. Required for cards. */
  returnUrl?: string;
  /** Our payments-row UUID. Sent as source_id and X-Idempotency-Key. */
  sourceId: string;
  customerName?: string;
  customerEmail?: string;
}

export interface CreatePaymentResult {
  ok: boolean;
  /** DebitoPay's payment id — what the webhook will reference. */
  providerPaymentId: string | null;
  /** success = paid now (M-Pesa sync); pending = webhook will decide. */
  status: "success" | "pending" | "failed";
  reference: string | null;
  /** Present for card payments — redirect the customer here. */
  checkoutUrl: string | null;
  /** Provider error code when ok=false, e.g. "Invalid amount". */
  error: string | null;
}

export async function createDebitopayPayment(
  input: CreatePaymentInput,
): Promise<CreatePaymentResult> {
  const config = getDebitopayConfig();
  if (!config) {
    return {
      ok: false,
      providerPaymentId: null,
      status: "failed",
      reference: null,
      checkoutUrl: null,
      error: "DebitoPay is not configured",
    };
  }

  const walletCode = config.wallets[input.method];
  if (!walletCode) {
    return {
      ok: false,
      providerPaymentId: null,
      status: "failed",
      reference: null,
      checkoutUrl: null,
      error: `METHOD_NOT_CONFIGURED:${input.method}`,
    };
  }

  const body: Record<string, unknown> = {
    action: "process",
    payment_method: input.method,
    merchant_id: config.merchantId,
    wallet_code: walletCode,
    amount: input.amount,
    currency: input.currency,
    source: "gateway",
    source_id: input.sourceId,
  };
  if (input.phone) body.phone = input.phone;
  if (input.returnUrl) body.return_url = input.returnUrl;
  if (input.customerName) body.customer_name = input.customerName;
  if (input.customerEmail) body.customer_email = input.customerEmail;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/payment-orchestrator`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        // Provider-side dedupe: a network retry of this exact charge
        // must not bill the customer twice.
        "X-Idempotency-Key": input.sourceId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Timeout or network failure. The charge MAY still complete on the
    // provider side (M-Pesa push already sent) — report pending-ish
    // failure and let the webhook/check-status reconcile the truth.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      providerPaymentId: null,
      status: "failed",
      reference: null,
      checkoutUrl: null,
      error: timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_UNREACHABLE",
    };
  }

  const data = (await res.json().catch(() => null)) as {
    success?: boolean;
    payment_id?: string;
    status?: string;
    reference?: string;
    transactionId?: string;
    checkout_url?: string;
    error?: string;
  } | null;

  if (!res.ok || !data?.success) {
    return {
      ok: false,
      providerPaymentId: data?.payment_id ?? null,
      status: "failed",
      reference: null,
      checkoutUrl: null,
      error: data?.error ?? `HTTP ${res.status}`,
    };
  }

  return {
    ok: true,
    providerPaymentId: data.payment_id ?? null,
    status: data.status === "success" ? "success" : "pending",
    reference: data.reference ?? data.transactionId ?? null,
    checkoutUrl: data.checkout_url ?? null,
    error: null,
  };
}

export interface PaymentStatusResult {
  ok: boolean;
  status: "pending" | "success" | "failed" | "expired" | null;
  amount: number | null;
  reference: string | null;
  error: string | null;
}

/**
 * Reconciliation fallback for when a webhook is lost: ask the provider
 * directly. Same endpoint, different action.
 */
export async function checkDebitopayStatus(
  providerPaymentId: string,
): Promise<PaymentStatusResult> {
  const config = getDebitopayConfig();
  if (!config) {
    return { ok: false, status: null, amount: null, reference: null, error: "DebitoPay is not configured" };
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/payment-orchestrator`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        action: "check-status",
        payment_id: providerPaymentId,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: null, amount: null, reference: null, error: "PROVIDER_UNREACHABLE" };
  }

  const data = (await res.json().catch(() => null)) as {
    success?: boolean;
    payment?: {
      status?: string;
      amount?: number;
      provider_reference?: string;
    };
    error?: string;
  } | null;

  if (!res.ok || !data?.success || !data.payment) {
    return {
      ok: false,
      status: null,
      amount: null,
      reference: null,
      error: data?.error ?? `HTTP ${res.status}`,
    };
  }

  const status = data.payment.status;
  return {
    ok: true,
    status:
      status === "pending" || status === "success" || status === "failed" || status === "expired"
        ? status
        : null,
    amount: data.payment.amount ?? null,
    reference: data.payment.provider_reference ?? null,
    error: null,
  };
}

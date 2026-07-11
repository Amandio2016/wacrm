/**
 * Billing types — mirrors migration 039.
 *
 * Money is stored and handled in MAJOR units (meticais, not centavos),
 * matching how deal values are tracked everywhere else in the app.
 */

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "suspended";

export type PaymentMethod =
  | "mpesa"
  | "emola"
  | "bank_transfer"
  | "cash"
  | "other";

export type PaymentStatus = "pending" | "confirmed" | "rejected";

/**
 * Feature caps carried on a plan. `null` means UNLIMITED — not zero,
 * and not "unset". Every consumer must treat null as "no ceiling" or
 * the unlimited plan silently becomes the most restrictive one.
 */
export interface PlanLimits {
  max_members: number | null;
  max_contacts: number | null;
  max_broadcasts_per_month: number | null;
  ai_enabled: boolean;
}

export const UNLIMITED_LIMITS: PlanLimits = {
  max_members: null,
  max_contacts: null,
  max_broadcasts_per_month: null,
  ai_enabled: true,
};

/**
 * What a trial gets. Generous on purpose — the trial exists to let a
 * prospect see the product work end-to-end, not to frustrate them.
 */
export const TRIAL_LIMITS: PlanLimits = {
  max_members: 3,
  max_contacts: 500,
  max_broadcasts_per_month: 2,
  ai_enabled: true,
};

/** What an account with no valid subscription gets: nothing chargeable. */
export const BLOCKED_LIMITS: PlanLimits = {
  max_members: 1,
  max_contacts: 0,
  max_broadcasts_per_month: 0,
  ai_enabled: false,
};

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  interval: "month" | "year";
  limits: PlanLimits;
  is_active: boolean;
  sort_order: number;
}

export interface Subscription {
  id: string;
  account_id: string;
  plan_id: string | null;
  status: SubscriptionStatus;
  current_period_end: string | null;
  trial_ends_at: string | null;
}

export interface Payment {
  id: string;
  account_id: string;
  plan_id: string | null;
  amount: number;
  currency: string;
  method: PaymentMethod;
  reference: string | null;
  period_months: number;
  status: PaymentStatus;
  notes: string | null;
  confirmed_at: string | null;
  created_at: string;
}

/** The resolved entitlement for an account — what the app gates on. */
export interface Entitlement {
  /** False = every chargeable action is blocked. */
  active: boolean;
  status: SubscriptionStatus;
  /** Effective caps: the plan's when paid, TRIAL_LIMITS on trial,
   *  BLOCKED_LIMITS once lapsed. */
  limits: PlanLimits;
  plan: Plan | null;
  /** When the current paid period or trial runs out. */
  expiresAt: string | null;
  /** Negative once expired. Null when there's nothing to count down to. */
  daysRemaining: number | null;
}

/**
 * Merge a plan's raw jsonb limits with safe defaults.
 *
 * A missing key must NOT become 0 — that would block the feature
 * outright. Absent means "no cap was configured", which we read as
 * unlimited, matching the null convention above.
 */
export function parseLimits(raw: unknown): PlanLimits {
  const l = (raw ?? {}) as Partial<PlanLimits>;
  return {
    max_members: l.max_members === undefined ? null : l.max_members,
    max_contacts: l.max_contacts === undefined ? null : l.max_contacts,
    max_broadcasts_per_month:
      l.max_broadcasts_per_month === undefined
        ? null
        : l.max_broadcasts_per_month,
    ai_enabled: l.ai_enabled ?? true,
  };
}

/** True when `used` has reached a cap. A null cap is never reached. */
export function isOverLimit(used: number, cap: number | null): boolean {
  return cap !== null && used >= cap;
}

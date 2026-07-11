import {
  BLOCKED_LIMITS,
  TRIAL_LIMITS,
  parseLimits,
  type Entitlement,
  type Plan,
  type Subscription,
} from "./types";

const MS_PER_DAY = 86_400_000;

/**
 * Resolve what an account is actually entitled to, right now.
 *
 * Pure — takes the rows, returns the verdict — so the rules are
 * testable without a database. `now` is injected for the same reason.
 *
 * The rules, in order:
 *   - No subscription row at all → blocked. (The trigger in migration
 *     039 means this shouldn't happen, but an account created before
 *     it, or a failed backfill, must fail CLOSED rather than open.)
 *   - canceled / suspended → blocked, regardless of dates.
 *   - trialing → trial limits until trial_ends_at, then blocked.
 *   - active → the plan's limits until current_period_end, then
 *     blocked. An 'active' row whose period has lapsed is treated as
 *     past_due: status alone never grants access, the DATE does. That
 *     matters because nothing sweeps expired rows on a schedule —
 *     without this check a paid month would silently become permanent.
 */
export function resolveEntitlement(
  subscription: Subscription | null,
  plan: Plan | null,
  now: Date = new Date(),
): Entitlement {
  if (!subscription) {
    return {
      active: false,
      status: "canceled",
      limits: BLOCKED_LIMITS,
      plan: null,
      expiresAt: null,
      daysRemaining: null,
    };
  }

  const { status } = subscription;

  if (status === "canceled" || status === "suspended") {
    return {
      active: false,
      status,
      limits: BLOCKED_LIMITS,
      plan,
      expiresAt: subscription.current_period_end,
      daysRemaining: null,
    };
  }

  const deadline =
    status === "trialing"
      ? subscription.trial_ends_at
      : subscription.current_period_end;

  // A trialing/active row with no deadline is malformed. Fail closed.
  if (!deadline) {
    return {
      active: false,
      status: "past_due",
      limits: BLOCKED_LIMITS,
      plan,
      expiresAt: null,
      daysRemaining: null,
    };
  }

  const expiry = new Date(deadline);
  const msLeft = expiry.getTime() - now.getTime();
  const daysRemaining = Math.ceil(msLeft / MS_PER_DAY);
  const lapsed = msLeft <= 0;

  if (lapsed) {
    return {
      active: false,
      status: "past_due",
      limits: BLOCKED_LIMITS,
      plan,
      expiresAt: deadline,
      daysRemaining,
    };
  }

  return {
    active: true,
    status,
    limits:
      status === "trialing"
        ? TRIAL_LIMITS
        : plan
          ? parseLimits(plan.limits)
          : TRIAL_LIMITS,
    plan,
    expiresAt: deadline,
    daysRemaining,
  };
}

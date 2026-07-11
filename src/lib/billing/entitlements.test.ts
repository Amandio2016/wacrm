import { describe, expect, it } from "vitest";
import { resolveEntitlement } from "./entitlements";
import {
  BLOCKED_LIMITS,
  TRIAL_LIMITS,
  isOverLimit,
  parseLimits,
  type Plan,
  type Subscription,
} from "./types";

const NOW = new Date("2026-07-11T12:00:00Z");
const daysFromNow = (n: number) =>
  new Date(NOW.getTime() + n * 86_400_000).toISOString();

const plan: Plan = {
  id: "plan-1",
  code: "business",
  name: "Business",
  description: null,
  price: 4500,
  currency: "MZN",
  interval: "month",
  limits: {
    max_members: 10,
    max_contacts: 10_000,
    max_broadcasts_per_month: 20,
    ai_enabled: true,
  },
  is_active: true,
  sort_order: 2,
};

const sub = (over: Partial<Subscription>): Subscription => ({
  id: "sub-1",
  account_id: "acc-1",
  plan_id: "plan-1",
  status: "active",
  current_period_end: null,
  trial_ends_at: null,
  ...over,
});

describe("resolveEntitlement", () => {
  it("blocks an account with no subscription row (fails closed)", () => {
    const e = resolveEntitlement(null, null, NOW);
    expect(e.active).toBe(false);
    expect(e.limits).toEqual(BLOCKED_LIMITS);
  });

  it("grants the plan's limits while the paid period is live", () => {
    const e = resolveEntitlement(
      sub({ status: "active", current_period_end: daysFromNow(10) }),
      plan,
      NOW,
    );
    expect(e.active).toBe(true);
    expect(e.limits.max_members).toBe(10);
    expect(e.daysRemaining).toBe(10);
  });

  it("blocks an 'active' subscription whose period has already lapsed", () => {
    // The status column alone must never grant access — nothing sweeps
    // expired rows on a cron, so a paid month would otherwise become
    // permanent access.
    const e = resolveEntitlement(
      sub({ status: "active", current_period_end: daysFromNow(-1) }),
      plan,
      NOW,
    );
    expect(e.active).toBe(false);
    expect(e.status).toBe("past_due");
    expect(e.limits).toEqual(BLOCKED_LIMITS);
  });

  it("grants trial limits during the trial", () => {
    const e = resolveEntitlement(
      sub({ status: "trialing", plan_id: null, trial_ends_at: daysFromNow(5) }),
      null,
      NOW,
    );
    expect(e.active).toBe(true);
    expect(e.limits).toEqual(TRIAL_LIMITS);
    expect(e.daysRemaining).toBe(5);
  });

  it("blocks once the trial has run out", () => {
    const e = resolveEntitlement(
      sub({ status: "trialing", plan_id: null, trial_ends_at: daysFromNow(-1) }),
      null,
      NOW,
    );
    expect(e.active).toBe(false);
    expect(e.limits).toEqual(BLOCKED_LIMITS);
  });

  it("blocks canceled and suspended regardless of a future period end", () => {
    for (const status of ["canceled", "suspended"] as const) {
      const e = resolveEntitlement(
        sub({ status, current_period_end: daysFromNow(365) }),
        plan,
        NOW,
      );
      expect(e.active, status).toBe(false);
      expect(e.limits, status).toEqual(BLOCKED_LIMITS);
    }
  });

  it("blocks a malformed row that has a live status but no deadline", () => {
    const e = resolveEntitlement(
      sub({ status: "active", current_period_end: null }),
      plan,
      NOW,
    );
    expect(e.active).toBe(false);
  });

  it("falls back to trial limits when an active sub's plan went missing", () => {
    // plans.id is ON DELETE SET NULL, so a deleted plan leaves a paying
    // account with plan_id = null. Don't strand them on zero.
    const e = resolveEntitlement(
      sub({ status: "active", plan_id: null, current_period_end: daysFromNow(3) }),
      null,
      NOW,
    );
    expect(e.active).toBe(true);
    expect(e.limits).toEqual(TRIAL_LIMITS);
  });
});

describe("parseLimits", () => {
  it("reads an absent cap as unlimited, not as zero", () => {
    const l = parseLimits({});
    expect(l.max_members).toBeNull();
    expect(l.max_contacts).toBeNull();
    expect(l.ai_enabled).toBe(true);
  });

  it("preserves an explicit null (the unlimited plan)", () => {
    expect(parseLimits({ max_members: null }).max_members).toBeNull();
  });

  it("preserves an explicit zero", () => {
    expect(parseLimits({ max_contacts: 0 }).max_contacts).toBe(0);
  });

  it("survives null/undefined input", () => {
    expect(() => parseLimits(null)).not.toThrow();
    expect(() => parseLimits(undefined)).not.toThrow();
  });
});

describe("isOverLimit", () => {
  it("never trips on an unlimited (null) cap", () => {
    expect(isOverLimit(1_000_000, null)).toBe(false);
  });

  it("trips on reaching the cap, not only on exceeding it", () => {
    expect(isOverLimit(9, 10)).toBe(false);
    expect(isOverLimit(10, 10)).toBe(true);
    expect(isOverLimit(11, 10)).toBe(true);
  });

  it("blocks everything on a zero cap", () => {
    expect(isOverLimit(0, 0)).toBe(true);
  });
});

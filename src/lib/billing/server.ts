import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEntitlement } from "./entitlements";
import { parseLimits, type Entitlement, type Plan } from "./types";

/**
 * Load an account's subscription + plan and resolve the entitlement.
 *
 * Reads run under the caller's RLS: `subscriptions_select` (migration
 * 039) lets any member of the account read its own row, and `plans` is
 * readable by every authenticated user. So this needs no service-role
 * key — a customer can only ever resolve their own entitlement.
 *
 * Fails CLOSED: any error resolving the subscription yields a blocked
 * entitlement (via resolveEntitlement(null, ...)) rather than an open
 * one. A database hiccup must not hand out free access.
 */
export async function getEntitlement(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  accountId: string,
): Promise<Entitlement> {
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("id, account_id, plan_id, status, current_period_end, trial_ends_at")
    .eq("account_id", accountId)
    .maybeSingle();

  if (!sub) return resolveEntitlement(null, null);

  let plan: Plan | null = null;
  if (sub.plan_id) {
    const { data: planRow } = await supabase
      .from("plans")
      .select(
        "id, code, name, description, price, currency, interval, limits, is_active, sort_order",
      )
      .eq("id", sub.plan_id)
      .maybeSingle();

    if (planRow) {
      plan = { ...planRow, limits: parseLimits(planRow.limits) } as Plan;
    }
  }

  return resolveEntitlement(sub, plan);
}

/**
 * Resolve the caller's account and assert it may perform a chargeable
 * action. Returns the entitlement on success, or a ready-to-return 402
 * on failure.
 *
 * 402 Payment Required is the honest status here — the request is
 * authenticated and well-formed; it's the subscription that's lapsed.
 * The client checks for it to route the user to /settings?tab=billing.
 *
 * Call this from the routes that COST money or are the product's core
 * value (sending, broadcasting, AI). Do NOT bolt it onto reads — a
 * lapsed customer must still be able to see and export their own data.
 * Locking people out of their data to extract payment is hostage-
 * taking, not billing.
 */
export async function requireActiveSubscription(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  accountId: string,
): Promise<{ entitlement: Entitlement } | { response: NextResponse }> {
  const entitlement = await getEntitlement(supabase, accountId);

  if (!entitlement.active) {
    return {
      response: NextResponse.json(
        {
          error: "Subscription inactive",
          code: "subscription_inactive",
          status: entitlement.status,
        },
        { status: 402 },
      ),
    };
  }

  return { entitlement };
}

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getEntitlement } from "@/lib/billing/server";
import { parseLimits } from "@/lib/billing/types";

/**
 * GET /api/billing — everything the billing screen needs in one call:
 * the caller's resolved entitlement, the price list, and their payment
 * history.
 *
 * Readable by ANY member of the account, not just admins: an agent
 * seeing "your trial ends in 3 days" is useful, and none of it is
 * sensitive. Only *submitting* a payment is admin-gated (RLS on
 * `payments`, migration 039).
 */
export async function GET() {
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
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const accountId = profile?.account_id as string | undefined;
  if (!accountId) {
    return NextResponse.json(
      { error: "Your profile is not linked to an account." },
      { status: 403 },
    );
  }

  const entitlement = await getEntitlement(supabase, accountId);

  const { data: planRows } = await supabase
    .from("plans")
    .select(
      "id, code, name, description, price, currency, interval, limits, is_active, sort_order",
    )
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  const { data: payments } = await supabase
    .from("payments")
    .select(
      "id, plan_id, amount, currency, method, reference, period_months, status, notes, confirmed_at, created_at",
    )
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(50);

  return NextResponse.json({
    entitlement,
    plans: (planRows ?? []).map((p) => ({ ...p, limits: parseLimits(p.limits) })),
    payments: payments ?? [],
  });
}

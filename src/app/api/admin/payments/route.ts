import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/admin/payments — the operator's reconciliation queue.
 *
 * No explicit role check here, and that's deliberate rather than an
 * oversight: RLS on `payments` (migration 039) already scopes SELECT to
 * "member of the account OR platform admin". A customer admin calling
 * this sees only their own account's rows — which they can see on their
 * own billing page anyway — and a platform admin sees everything. The
 * privileged action (confirming) lives in POST .../[id], which is
 * guarded inside `confirm_payment()` itself.
 */
export async function GET(request: Request) {
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "pending";

  let query = supabase
    .from("payments")
    .select(
      "id, account_id, plan_id, amount, currency, method, reference, period_months, status, notes, confirmed_at, created_at, accounts(name), plans(name, code)",
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (status !== "all") {
    query = query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[admin/payments] list failed:", error.message);
    return NextResponse.json(
      { error: "Could not load payments." },
      { status: 500 },
    );
  }

  // Whether the caller is the operator, so the UI can render the admin
  // view instead of a bare list. is_platform_admin() is the same
  // predicate the RLS policies use.
  const { data: isAdmin } = await supabase.rpc("is_platform_admin");

  return NextResponse.json({
    payments: data ?? [],
    isPlatformAdmin: Boolean(isAdmin),
  });
}

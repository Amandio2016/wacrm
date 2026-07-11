import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/payments/[id] — confirm or reject a payment claim.
 *
 * Confirming is what extends a subscription, so it is the single most
 * privileged action in the billing system. The authorisation lives in
 * the DATABASE, not here: `confirm_payment()` is SECURITY DEFINER and
 * raises unless `is_platform_admin()`. Rejecting goes through the
 * `payments_update` RLS policy, which is platform-admin-only too.
 *
 * Putting the check in the database rather than in this handler means a
 * future second caller (an M-Pesa C2B webhook, a CLI) cannot forget it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const action = (body as { action?: string } | null)?.action;

  if (action !== "confirm" && action !== "reject") {
    return NextResponse.json(
      { error: "action must be 'confirm' or 'reject'" },
      { status: 400 },
    );
  }

  if (action === "confirm") {
    const { data, error } = await supabase.rpc("confirm_payment", {
      payment_id: id,
    });

    if (error) {
      // The RPC raises on: not a platform admin, payment not found, or
      // already confirmed. Surface its message — each is actionable and
      // none of them leaks anything the caller shouldn't see.
      console.error("[admin/payments] confirm failed:", error.message);
      return NextResponse.json({ error: error.message }, { status: 403 });
    }

    return NextResponse.json({ subscription: data });
  }

  const { error } = await supabase
    .from("payments")
    .update({ status: "rejected", confirmed_by: user.id, confirmed_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    console.error("[admin/payments] reject failed:", error.message);
    return NextResponse.json(
      { error: "Could not reject the payment. Are you a platform admin?" },
      { status: 403 },
    );
  }

  return NextResponse.json({ ok: true });
}

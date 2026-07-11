import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazy, shared service-role client for the billing provider paths.
// Mirrors src/lib/ai/admin-client.ts. Two callers need it:
//   - the DebitoPay webhook (no auth.uid(), must call
//     confirm_payment_service, which only service_role may execute)
//   - the create-payment route, for the post-insert provider_reference
//     update (payments UPDATE is platform-admin-only under RLS — the
//     customer admin who initiated the charge may not touch the row).
let _adminClient: SupabaseClient | null = null;

export function billingAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
  }
  return _adminClient;
}

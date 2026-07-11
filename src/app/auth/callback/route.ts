import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Landing point for every emailed auth link (password recovery today,
 * email-change confirmation and magic links if they get added).
 *
 * Supabase sends one of two shapes depending on the project's email
 * templates, and we have to accept both or recovery silently 404s:
 *
 *   - PKCE (`?code=`)          — the default for @supabase/ssr. Exchange
 *                                the code for a session.
 *   - OTP  (`?token_hash=&type=`) — what the newer default templates emit.
 *                                Verify the hash instead.
 *
 * On success we redirect to `next` (same-origin only), which for
 * recovery is /reset-password — the user arrives already signed in on a
 * short-lived recovery session, which is exactly what updateUser() needs.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");

  // Only ever redirect within our own origin. `next` arrives from a
  // query string, so an attacker could otherwise craft a link that
  // bounces the user (mid-auth) to their own site.
  const requested = url.searchParams.get("next") ?? "/dashboard";
  const next = requested.startsWith("/") && !requested.startsWith("//")
    ? requested
    : "/dashboard";

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as "recovery" | "email" | "signup" | "email_change",
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }

  // Expired, already-used, or malformed link. Send them back to the
  // request form with a flag so the page can explain what happened
  // instead of failing silently.
  return NextResponse.redirect(
    new URL("/forgot-password?error=invalid_link", url.origin),
  );
}

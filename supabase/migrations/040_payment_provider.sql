-- ============================================================
-- 040_payment_provider
--
-- Prepare the billing tables for an AUTOMATED payment provider
-- (DebitoPay) alongside the existing manual/M-Pesa flow.
--
-- Three things have to be true before a webhook may move money, and
-- all three are enforced here in the database rather than in the route
-- handler — a second caller (a retry, a CLI, a future provider) can
-- forget a TypeScript check; it cannot forget a CHECK constraint.
--
--   1. IDEMPOTENCE. Providers retry webhooks, sometimes for days. The
--      same transaction must never buy two subscription periods.
--      Enforced by a UNIQUE index on (provider, provider_reference)
--      and by `payment_webhook_events`, which rejects a replayed event
--      id outright.
--
--   2. AMOUNT VERIFICATION. "Payment succeeded" is not enough — a
--      100 MT payment must not unlock a 12 000 MT plan. The service
--      confirmation function takes the amount the provider says was
--      paid and RAISES if it falls short of what the payment row
--      claims. The client never gets a vote: the row's amount was
--      computed server-side from the plan (see /api/billing/payments).
--
--   3. AUTHORISATION. confirm_payment() (migration 039) requires
--      is_platform_admin(), which is correct for a human operator and
--      WRONG for a webhook — a webhook has no auth.uid() and would be
--      refused. Rather than weaken that check, this migration splits
--      the work:
--
--        _apply_payment_confirmation()  internal, no grants
--        confirm_payment()              → authenticated + admin check
--        confirm_payment_service()      → service_role ONLY
--
--      The service function is reachable only with the service-role
--      key, which lives in server env and never touches the browser.
--      An `authenticated` user calling it gets a permission error.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- Provider columns on payments
-- ------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS provider_reference TEXT,
  ADD COLUMN IF NOT EXISTS provider_status TEXT;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_provider_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_provider_check
  CHECK (provider IN ('manual', 'debitopay'));

-- One provider transaction = at most one payment row. This is the
-- backstop against double-crediting: even if the webhook handler is
-- invoked twice concurrently, the second insert loses.
DROP INDEX IF EXISTS idx_payments_provider_ref;
CREATE UNIQUE INDEX idx_payments_provider_ref
  ON payments (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

-- ------------------------------------------------------------
-- Webhook replay protection
--
-- Every delivered event is recorded by its provider-side id BEFORE we
-- act on it. A replay hits the unique constraint and is dropped.
-- Service-role only: nothing on the customer side reads or writes it.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  payload     JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, event_id)
);

ALTER TABLE payment_webhook_events ENABLE ROW LEVEL SECURITY;
-- No policies at all: RLS with zero policies denies every authenticated
-- and anon request. The service-role key bypasses RLS, which is exactly
-- and only what the webhook route uses.

-- ============================================================
-- Split the confirmation path
-- ============================================================

-- The actual work. No grants — reachable only from the two SECURITY
-- DEFINER wrappers below, which run as the owner (postgres).
CREATE OR REPLACE FUNCTION _apply_payment_confirmation(payment_id UUID)
RETURNS subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pay         payments;
  base        TIMESTAMPTZ;
  updated_sub subscriptions;
BEGIN
  SELECT * INTO pay FROM payments WHERE id = payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found', payment_id;
  END IF;

  -- Re-confirming must not hand out another period.
  IF pay.status = 'confirmed' THEN
    RAISE EXCEPTION 'Payment % is already confirmed', payment_id;
  END IF;

  UPDATE payments
     SET status       = 'confirmed',
         confirmed_by = auth.uid(),   -- NULL for the webhook path; fine
         confirmed_at = NOW()
   WHERE id = payment_id;

  SELECT GREATEST(NOW(), COALESCE(s.current_period_end, NOW()))
    INTO base
    FROM subscriptions s
   WHERE s.account_id = pay.account_id;

  IF base IS NULL THEN
    base := NOW();
  END IF;

  INSERT INTO subscriptions (account_id, plan_id, status, current_period_end)
  VALUES (
    pay.account_id,
    pay.plan_id,
    'active',
    base + (pay.period_months * INTERVAL '1 month')
  )
  ON CONFLICT (account_id) DO UPDATE
    SET plan_id            = COALESCE(EXCLUDED.plan_id, subscriptions.plan_id),
        status             = 'active',
        current_period_end = EXCLUDED.current_period_end,
        updated_at         = NOW()
  RETURNING * INTO updated_sub;

  RETURN updated_sub;
END;
$$;

ALTER FUNCTION _apply_payment_confirmation(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION _apply_payment_confirmation(UUID) FROM PUBLIC;

-- ---- Human operator path (unchanged contract) ----------------
CREATE OR REPLACE FUNCTION confirm_payment(payment_id UUID)
RETURNS subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform admins can confirm payments';
  END IF;

  RETURN _apply_payment_confirmation(payment_id);
END;
$$;

ALTER FUNCTION confirm_payment(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION confirm_payment(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_payment(UUID) TO authenticated, service_role;

-- ---- Automated provider path ---------------------------------
--
-- `paid_amount` is what the PROVIDER says landed. We refuse to confirm
-- when it is short of what the payment row is worth, so a tampered or
-- under-paid transaction cannot unlock a plan. A small positive
-- tolerance is allowed for provider-side rounding; overpayment is fine
-- and simply confirms.
CREATE OR REPLACE FUNCTION confirm_payment_service(
  payment_id  UUID,
  paid_amount NUMERIC,
  provider_ref TEXT DEFAULT NULL
)
RETURNS subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  expected NUMERIC;
BEGIN
  SELECT amount INTO expected FROM payments WHERE id = payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found', payment_id;
  END IF;

  IF paid_amount IS NULL OR paid_amount < expected - 0.01 THEN
    RAISE EXCEPTION
      'Underpayment for %: provider reported %, plan requires %',
      payment_id, paid_amount, expected;
  END IF;

  IF provider_ref IS NOT NULL THEN
    UPDATE payments
       SET provider_reference = provider_ref,
           provider_status    = 'paid'
     WHERE id = payment_id;
  END IF;

  RETURN _apply_payment_confirmation(payment_id);
END;
$$;

ALTER FUNCTION confirm_payment_service(UUID, NUMERIC, TEXT) OWNER TO postgres;
-- The whole point: NOT granted to `authenticated`. Only a caller
-- holding the service-role key (i.e. our own server) may run this.
REVOKE ALL ON FUNCTION confirm_payment_service(UUID, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_payment_service(UUID, NUMERIC, TEXT) TO service_role;

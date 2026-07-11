-- ============================================================
-- 039_billing
--
-- SaaS subscription billing with MANUAL payment confirmation.
--
-- Why manual: Stripe / Paddle / LemonSqueezy do not onboard
-- Mozambican entities, so there is no card rail we can wire up
-- directly. The money moves out-of-band (M-Pesa, e-Mola, bank
-- transfer); the customer reports the transaction reference, and a
-- platform operator confirms it. Confirming a payment is what
-- extends the subscription period. A future M-Pesa C2B API
-- integration can write the same `payments` rows and call the same
-- `confirm_payment()` RPC — nothing else has to change.
--
-- Trust model, stated plainly:
--   - A customer may CREATE a payment claim ("I sent 2 500 MT, ref
--     ABC123") and read their own. They may NOT confirm it, and they
--     may NOT write to `subscriptions` at all. Otherwise anyone could
--     grant themselves a free forever plan with one REST call.
--   - Only a `platform_admins` row — that's you, the SaaS operator,
--     not an account admin — can confirm payments and edit plans.
--     Note `is_account_member(_, 'admin')` is a CUSTOMER's admin;
--     conflating the two would be the whole security model gone.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- PLATFORM ADMINS — the SaaS operator, above all customer accounts
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

-- SECURITY DEFINER so policy bodies can read this table without
-- recursing through its own RLS.
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_admins pa WHERE pa.user_id = auth.uid()
  );
$$;

ALTER FUNCTION is_platform_admin() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_platform_admin() TO authenticated, service_role;

-- Only platform admins can even see the roster. Bootstrapping the
-- FIRST admin therefore has to happen out-of-band, with the
-- service-role key or straight from the SQL editor:
--   INSERT INTO platform_admins (user_id)
--   SELECT id FROM auth.users WHERE email = 'you@example.com';
DROP POLICY IF EXISTS platform_admins_select ON platform_admins;
CREATE POLICY platform_admins_select ON platform_admins
  FOR SELECT USING (is_platform_admin());

DROP POLICY IF EXISTS platform_admins_write ON platform_admins;
CREATE POLICY platform_admins_write ON platform_admins
  FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- ============================================================
-- PLANS — the public price list
-- ============================================================
CREATE TABLE IF NOT EXISTS plans (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  -- Price in MAJOR units (meticais, not centavos). Deal values are
  -- already tracked as whole units across this app; matching that
  -- keeps every formatter and comparison consistent.
  price        NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  currency     TEXT NOT NULL DEFAULT 'MZN' CHECK (currency ~ '^[A-Z]{3}$'),
  interval     TEXT NOT NULL DEFAULT 'month' CHECK (interval IN ('month', 'year')),
  -- Feature caps. NULL inside the JSON = unlimited. Kept as jsonb so
  -- a new limit doesn't need a migration; the app reads it through a
  -- typed helper.
  limits       JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

-- The price list is readable by any signed-in user (they need to see
-- what they can upgrade to). Only the platform operator can change it.
DROP POLICY IF EXISTS plans_select ON plans;
CREATE POLICY plans_select ON plans
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS plans_write ON plans;
CREATE POLICY plans_write ON plans
  FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- ============================================================
-- SUBSCRIPTIONS — one per account
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id           UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id              UUID REFERENCES plans(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'trialing'
                       CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'suspended')),
  -- When the paid period runs out. NULL while trialing.
  current_period_end   TIMESTAMPTZ,
  trial_ends_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_account ON subscriptions(account_id);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- Members read their own subscription so the app can show the banner
-- and the billing page. NOBODY on the customer side writes it — the
-- only writer is confirm_payment() (SECURITY DEFINER) and the
-- platform operator.
DROP POLICY IF EXISTS subscriptions_select ON subscriptions;
CREATE POLICY subscriptions_select ON subscriptions
  FOR SELECT USING (is_account_member(account_id) OR is_platform_admin());

DROP POLICY IF EXISTS subscriptions_write ON subscriptions;
CREATE POLICY subscriptions_write ON subscriptions
  FOR ALL USING (is_platform_admin()) WITH CHECK (is_platform_admin());

-- ============================================================
-- PAYMENTS — a claim of money sent, pending confirmation
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id        UUID REFERENCES plans(id) ON DELETE SET NULL,
  amount         NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  currency       TEXT NOT NULL DEFAULT 'MZN' CHECK (currency ~ '^[A-Z]{3}$'),
  method         TEXT NOT NULL DEFAULT 'mpesa'
                 CHECK (method IN ('mpesa', 'emola', 'bank_transfer', 'cash', 'other')),
  -- The M-Pesa / e-Mola transaction id the customer pastes in. This is
  -- what the operator eyeballs against the merchant statement.
  reference      TEXT,
  -- How many months this payment buys. Confirming extends the period
  -- by exactly this much.
  period_months  INT NOT NULL DEFAULT 1 CHECK (period_months BETWEEN 1 AND 36),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'confirmed', 'rejected')),
  notes          TEXT,
  submitted_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_account ON payments(account_id);
CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments(status);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments
  FOR SELECT USING (is_account_member(account_id) OR is_platform_admin());

-- A customer admin may FILE a claim. The WITH CHECK pins status to
-- 'pending' so they cannot insert a row that is already 'confirmed'
-- and self-activate.
DROP POLICY IF EXISTS payments_insert ON payments;
CREATE POLICY payments_insert ON payments
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'admin')
    AND status = 'pending'
  );

-- Updating (i.e. confirming/rejecting) is operator-only.
DROP POLICY IF EXISTS payments_update ON payments;
CREATE POLICY payments_update ON payments
  FOR UPDATE USING (is_platform_admin()) WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS payments_delete ON payments;
CREATE POLICY payments_delete ON payments
  FOR DELETE USING (is_platform_admin());

-- ============================================================
-- confirm_payment(payment_id) — the one way a subscription extends
--
-- SECURITY DEFINER because it must write `subscriptions`, which no
-- customer-side role may touch. The is_platform_admin() guard inside
-- is therefore load-bearing: without it, any authenticated user could
-- call this and activate themselves.
--
-- Extends from whichever is later — now, or the existing period end —
-- so paying early stacks time instead of throwing it away.
-- ============================================================
CREATE OR REPLACE FUNCTION confirm_payment(payment_id UUID)
RETURNS subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pay          payments;
  base         TIMESTAMPTZ;
  updated_sub  subscriptions;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Only platform admins can confirm payments';
  END IF;

  SELECT * INTO pay FROM payments WHERE id = payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found', payment_id;
  END IF;

  -- Idempotence: re-confirming must not hand out another period.
  IF pay.status = 'confirmed' THEN
    RAISE EXCEPTION 'Payment % is already confirmed', payment_id;
  END IF;

  UPDATE payments
     SET status       = 'confirmed',
         confirmed_by = auth.uid(),
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

ALTER FUNCTION confirm_payment(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION confirm_payment(UUID) TO authenticated, service_role;

-- ============================================================
-- Auto-provision a trial when an account is created
--
-- Without this, an account created by handle_new_user() has no
-- subscription row at all, and every downstream "is this account
-- entitled?" read has to special-case NULL.
-- ============================================================
CREATE OR REPLACE FUNCTION provision_trial_subscription()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO subscriptions (account_id, status, trial_ends_at)
  VALUES (NEW.id, 'trialing', NOW() + INTERVAL '14 days')
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
END;
$$;

ALTER FUNCTION provision_trial_subscription() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_provision_trial ON accounts;
CREATE TRIGGER trg_provision_trial
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION provision_trial_subscription();

-- Backfill: existing accounts predate the trigger and would otherwise
-- have no subscription row.
INSERT INTO subscriptions (account_id, status, trial_ends_at)
SELECT a.id, 'trialing', NOW() + INTERVAL '14 days'
  FROM accounts a
 WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.account_id = a.id);

-- ============================================================
-- Seed the price list (MZN). Idempotent on `code`.
-- Edit freely — these are starting points, not gospel.
-- ============================================================
INSERT INTO plans (code, name, description, price, currency, interval, limits, sort_order)
VALUES
  ('starter', 'Starter', 'Para quem está a começar — um agente, o essencial do CRM.',
   1999, 'MZN', 'month',
   '{"max_members": 2, "max_contacts": 1000, "max_broadcasts_per_month": 2, "ai_enabled": false}'::jsonb, 1),
  ('business', 'Business', 'Para equipas — mais agentes, campanhas e assistente de IA.',
   4999, 'MZN', 'month',
   '{"max_members": 10, "max_contacts": 10000, "max_broadcasts_per_month": 20, "ai_enabled": true}'::jsonb, 2),
  ('unlimited', 'Ilimitado', 'Sem limites — para operações grandes.',
   7999, 'MZN', 'month',
   '{"max_members": null, "max_contacts": null, "max_broadcasts_per_month": null, "ai_enabled": true}'::jsonb, 3)
ON CONFLICT (code) DO UPDATE
SET name        = EXCLUDED.name,
    description = EXCLUDED.description,
    price       = EXCLUDED.price,
    currency    = EXCLUDED.currency,
    interval    = EXCLUDED.interval,
    limits      = EXCLUDED.limits,
    sort_order  = EXCLUDED.sort_order,
    updated_at  = NOW();

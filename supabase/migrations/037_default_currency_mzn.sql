-- ============================================================
-- 037_default_currency_mzn
--
-- Make the Mozambican Metical (MZN) the platform default currency.
--
-- Migration 021 introduced accounts.default_currency with a 'USD'
-- default. This deployment sells into Mozambique, so new accounts
-- should start in MZN rather than have every operator change it by
-- hand on day one.
--
-- Scope: this ONLY changes the default for accounts created from now
-- on, plus any existing account still sitting on the untouched 'USD'
-- default. An account that deliberately picked a currency (EUR, ZAR,
-- anything not USD) is left alone — we must not silently relabel an
-- operator's deal values.
--
-- Note this is a relabel, NOT an FX conversion: deals keep their
-- numeric value and the code they were saved with (deals.currency).
-- The app enforces one currency per account and never converts.
-- ============================================================

ALTER TABLE accounts
  ALTER COLUMN default_currency SET DEFAULT 'MZN';

-- Move accounts that never chose a currency (still on the old default).
UPDATE accounts
   SET default_currency = 'MZN'
 WHERE default_currency = 'USD';

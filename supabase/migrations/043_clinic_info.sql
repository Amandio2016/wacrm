-- ============================================================
-- 043_clinic_info
--
-- Institutional clinic fields for the new "Sobre a Clínica" page:
-- address, opening hours, and a short description. Free-text on
-- purpose — a structured opening-hours schema (per weekday, per
-- exception) already exists for BOOKING purposes in `disponibilidade`
-- (migration 041, per professional); this is display-only copy for
-- patients/visitors reading about the clinic as a whole, which does
-- not need the same rigor.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS morada TEXT,
  ADD COLUMN IF NOT EXISTS horario_funcionamento TEXT,
  ADD COLUMN IF NOT EXISTS descricao TEXT;

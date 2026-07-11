-- ============================================================
-- 041_clinboost_core
--
-- ClinBoost: turn the generic CRM into a clinic-scheduling SaaS.
-- Fase 1 do plano em docs/clinboost-plan.md.
--
-- Design decisions that matter:
--
--   - The CLINIC IS THE ACCOUNT. No parallel "clinicas" table — the
--     multi-tenant spine (accounts + is_account_member RLS, migration
--     017) already isolates every row. This migration only EXTENDS
--     accounts with the clinic-specific fields and adds the scheduling
--     domain on top.
--
--   - Double-booking is prevented by the DATABASE, not by application
--     code. An EXCLUDE constraint on (profissional, time range) makes
--     the race between two patients booking the same slot impossible
--     to lose: one insert wins, the other errors, whatever the
--     application does. Requires btree_gist.
--
--   - Times are TIMESTAMPTZ; the clinic's IANA timezone lives on the
--     account (default Africa/Maputo). Weekly availability is stored
--     as local TIME + weekday and converted by the slot engine — this
--     is what makes "Mondays 08:00–12:00" survive any UTC offset.
--
--   - The three cron-idempotence columns (*_enviado_em) are the ONLY
--     thing standing between a re-run cron and a duplicate WhatsApp
--     reminder. Every scheduled sender must check-and-set them.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------
-- Clinic fields on accounts
-- ------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS cor_primaria TEXT,
  ADD COLUMN IF NOT EXISTS numero_recepcao TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Africa/Maputo',
  ADD COLUMN IF NOT EXISTS subdominio TEXT;

-- Hex colour or nothing — the UI injects this into CSS variables and a
-- malformed value would break the whole stylesheet.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_cor_primaria_hex;
ALTER TABLE accounts ADD CONSTRAINT accounts_cor_primaria_hex
  CHECK (cor_primaria IS NULL OR cor_primaria ~ '^#[0-9a-fA-F]{6}$');

-- Reserved for future subdomain routing (fora do MVP). Constrained now
-- so no garbage accumulates before the feature exists.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_subdominio_shape;
ALTER TABLE accounts ADD CONSTRAINT accounts_subdominio_shape
  CHECK (subdominio IS NULL OR subdominio ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$');
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_subdominio
  ON accounts (subdominio) WHERE subdominio IS NOT NULL;

-- ------------------------------------------------------------
-- Especialidades
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS especialidades (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  nome       TEXT NOT NULL,
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, nome)
);

CREATE INDEX IF NOT EXISTS idx_especialidades_account ON especialidades(account_id);

-- ------------------------------------------------------------
-- Profissionais (médicos)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profissionais (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  nome             TEXT NOT NULL,
  especialidade_id UUID REFERENCES especialidades(id) ON DELETE SET NULL,
  -- Slot length the booking engine offers for this doctor. Per-doctor
  -- because a GP's 20-minute slots and a psychologist's hour coexist
  -- in the same clinic.
  duracao_consulta_minutos INT NOT NULL DEFAULT 30
    CHECK (duracao_consulta_minutos BETWEEN 5 AND 240),
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profissionais_account ON profissionais(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON profissionais;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON profissionais
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- Disponibilidade semanal + exceções (férias, feriados)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS disponibilidade (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profissional_id UUID NOT NULL REFERENCES profissionais(id) ON DELETE CASCADE,
  -- 0 = domingo … 6 = sábado, alinhado com EXTRACT(DOW FROM ts).
  dia_semana  SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  -- Local clinic time (see accounts.timezone). TIME, not TIMESTAMPTZ:
  -- "segundas das 08:00 às 12:00" é uma regra recorrente, não um instante.
  hora_inicio TIME NOT NULL,
  hora_fim    TIME NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (hora_fim > hora_inicio)
);

CREATE INDEX IF NOT EXISTS idx_disponibilidade_prof
  ON disponibilidade(profissional_id, dia_semana);

CREATE TABLE IF NOT EXISTS disponibilidade_excecoes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profissional_id UUID NOT NULL REFERENCES profissionais(id) ON DELETE CASCADE,
  -- Whole-day off in clinic-local terms. Partial-day exceptions can be
  -- added later without breaking this shape.
  data   DATE NOT NULL,
  motivo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profissional_id, data)
);

CREATE INDEX IF NOT EXISTS idx_disp_excecoes_prof
  ON disponibilidade_excecoes(profissional_id, data);

-- ------------------------------------------------------------
-- Agendamentos (consultas)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agendamentos (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- O paciente É um contact — dedupe por telefone, notas, tags e campos
  -- personalizados vêm de graça do CRM.
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- RESTRICT: um médico com histórico não desaparece — desativa-se
  -- (ativo = false) e mantém-se o registo clínico.
  profissional_id  UUID NOT NULL REFERENCES profissionais(id) ON DELETE RESTRICT,
  especialidade_id UUID REFERENCES especialidades(id) ON DELETE SET NULL,
  inicio TIMESTAMPTZ NOT NULL,
  fim    TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'confirmado', 'cancelado', 'concluido', 'falta')),
  origem TEXT NOT NULL DEFAULT 'manual' CHECK (origem IN ('bot', 'manual')),
  notas  TEXT,
  -- Idempotência dos crons: cada envio agendado marca a sua coluna
  -- ANTES de enviar; um cron re-executado nunca duplica a mensagem.
  lembrete_enviado_em    TIMESTAMPTZ,
  feedback_enviado_em    TIMESTAMPTZ,
  recuperacao_enviada_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (fim > inicio)
);

-- A restrição que torna a dupla marcação IMPOSSÍVEL: dois agendamentos
-- não-cancelados do mesmo profissional não podem sobrepor-se no tempo.
-- Range semiaberto [inicio, fim): consulta às 09:00–09:30 e 09:30–10:00
-- coexistem. 'falta' e 'concluido' continuam a bloquear o passado (não
-- interessa — só o futuro é reservável) e 'cancelado' liberta o slot.
ALTER TABLE agendamentos DROP CONSTRAINT IF EXISTS agendamentos_sem_sobreposicao;
ALTER TABLE agendamentos ADD CONSTRAINT agendamentos_sem_sobreposicao
  EXCLUDE USING gist (
    profissional_id WITH =,
    tstzrange(inicio, fim, '[)') WITH &&
  )
  WHERE (status <> 'cancelado');

CREATE INDEX IF NOT EXISTS idx_agendamentos_account_inicio
  ON agendamentos(account_id, inicio);
CREATE INDEX IF NOT EXISTS idx_agendamentos_contact
  ON agendamentos(contact_id, inicio);
-- Cron scans: candidatos a lembrete/feedback/recuperação.
CREATE INDEX IF NOT EXISTS idx_agendamentos_lembrete
  ON agendamentos(inicio)
  WHERE lembrete_enviado_em IS NULL AND status IN ('pendente', 'confirmado');
CREATE INDEX IF NOT EXISTS idx_agendamentos_feedback
  ON agendamentos(fim)
  WHERE feedback_enviado_em IS NULL AND status = 'concluido';
CREATE INDEX IF NOT EXISTS idx_agendamentos_recuperacao
  ON agendamentos(inicio)
  WHERE recuperacao_enviada_em IS NULL AND status = 'falta';

DROP TRIGGER IF EXISTS set_updated_at ON agendamentos;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON agendamentos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- RLS — o padrão exato da migração 017.
-- Configuração (especialidades, profissionais, disponibilidade) é
-- admin-only na escrita; operação diária (agendamentos) é agent+,
-- porque a receção marca/remarca/conclui consultas.
-- ------------------------------------------------------------
ALTER TABLE especialidades            ENABLE ROW LEVEL SECURITY;
ALTER TABLE profissionais             ENABLE ROW LEVEL SECURITY;
ALTER TABLE disponibilidade           ENABLE ROW LEVEL SECURITY;
ALTER TABLE disponibilidade_excecoes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE agendamentos              ENABLE ROW LEVEL SECURITY;

-- ---- especialidades (settings-class) ---------------------------
DROP POLICY IF EXISTS especialidades_select ON especialidades;
DROP POLICY IF EXISTS especialidades_insert ON especialidades;
DROP POLICY IF EXISTS especialidades_update ON especialidades;
DROP POLICY IF EXISTS especialidades_delete ON especialidades;
CREATE POLICY especialidades_select ON especialidades FOR SELECT USING (is_account_member(account_id));
CREATE POLICY especialidades_insert ON especialidades FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY especialidades_update ON especialidades FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY especialidades_delete ON especialidades FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---- profissionais (settings-class) ----------------------------
DROP POLICY IF EXISTS profissionais_select ON profissionais;
DROP POLICY IF EXISTS profissionais_insert ON profissionais;
DROP POLICY IF EXISTS profissionais_update ON profissionais;
DROP POLICY IF EXISTS profissionais_delete ON profissionais;
CREATE POLICY profissionais_select ON profissionais FOR SELECT USING (is_account_member(account_id));
CREATE POLICY profissionais_insert ON profissionais FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY profissionais_update ON profissionais FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY profissionais_delete ON profissionais FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---- disponibilidade (settings-class) --------------------------
DROP POLICY IF EXISTS disponibilidade_select ON disponibilidade;
DROP POLICY IF EXISTS disponibilidade_insert ON disponibilidade;
DROP POLICY IF EXISTS disponibilidade_update ON disponibilidade;
DROP POLICY IF EXISTS disponibilidade_delete ON disponibilidade;
CREATE POLICY disponibilidade_select ON disponibilidade FOR SELECT USING (is_account_member(account_id));
CREATE POLICY disponibilidade_insert ON disponibilidade FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY disponibilidade_update ON disponibilidade FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY disponibilidade_delete ON disponibilidade FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS disp_excecoes_select ON disponibilidade_excecoes;
DROP POLICY IF EXISTS disp_excecoes_insert ON disponibilidade_excecoes;
DROP POLICY IF EXISTS disp_excecoes_update ON disponibilidade_excecoes;
DROP POLICY IF EXISTS disp_excecoes_delete ON disponibilidade_excecoes;
CREATE POLICY disp_excecoes_select ON disponibilidade_excecoes FOR SELECT USING (is_account_member(account_id));
CREATE POLICY disp_excecoes_insert ON disponibilidade_excecoes FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY disp_excecoes_update ON disponibilidade_excecoes FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY disp_excecoes_delete ON disponibilidade_excecoes FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---- agendamentos (operational) --------------------------------
DROP POLICY IF EXISTS agendamentos_select ON agendamentos;
DROP POLICY IF EXISTS agendamentos_insert ON agendamentos;
DROP POLICY IF EXISTS agendamentos_update ON agendamentos;
DROP POLICY IF EXISTS agendamentos_delete ON agendamentos;
CREATE POLICY agendamentos_select ON agendamentos FOR SELECT USING (is_account_member(account_id));
CREATE POLICY agendamentos_insert ON agendamentos FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY agendamentos_update ON agendamentos FOR UPDATE USING (is_account_member(account_id, 'agent'));
-- Delete é admin-only: o histórico clínico apaga-se por decisão, não
-- por rotina — cancelar é uma transição de status, não um DELETE.
CREATE POLICY agendamentos_delete ON agendamentos FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- Plano único ClinBoost — 5.000 MT/mês, sem limites de funcionalidade.
-- Os planos antigos ficam inativos (somem do picker/API) mas as
-- assinaturas existentes que apontem para eles continuam válidas.
-- ------------------------------------------------------------
UPDATE plans SET is_active = FALSE, updated_at = NOW() WHERE code <> 'clinboost';

INSERT INTO plans (code, name, description, price, currency, interval, limits, sort_order)
VALUES (
  'clinboost',
  'ClinBoost',
  'Plano único — acesso total: agenda, bot de marcações, lembretes automáticos e equipa ilimitada.',
  5000, 'MZN', 'month',
  '{"max_members": null, "max_contacts": null, "max_broadcasts_per_month": null, "ai_enabled": true}'::jsonb,
  1
)
ON CONFLICT (code) DO UPDATE
SET name        = EXCLUDED.name,
    description = EXCLUDED.description,
    price       = EXCLUDED.price,
    currency    = EXCLUDED.currency,
    interval    = EXCLUDED.interval,
    limits      = EXCLUDED.limits,
    sort_order  = EXCLUDED.sort_order,
    is_active   = TRUE,
    updated_at  = NOW();

-- ============================================================
-- 042_bot_agendamento
--
-- Conversation state for the appointment-booking bot (Fase 3).
--
-- One row per conversation: which step of the booking dialogue the
-- patient is on, plus the choices made so far (jsonb). The bot is a
-- state machine driven by the webhook; without persisted state every
-- inbound message would restart the dialogue.
--
-- Why not reuse flow_runs: flows are user-authored graphs interpreted
-- generically; the booking bot is code with database reads (slots) and
-- writes (agendamentos) per step. Forcing it into flow nodes would mean
-- inventing node types that only this bot uses. Separate table, same
-- design idea (unique active session per conversation).
--
-- Service-role only in practice (the webhook drives it), but RLS
-- grants members read access so a future UI can show "bot em curso".
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS agendamento_sessoes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Passo do diálogo: menu, especialidade, profissional, dia, hora,
  -- confirmar, minhas, acao_consulta, remarcar_dia, remarcar_hora.
  estado     TEXT NOT NULL DEFAULT 'menu',
  -- Escolhas acumuladas + opções apresentadas (mapa reply_id → valor),
  -- para o toque no botão ser resolvido sem recomputar a lista.
  dados      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Idempotência: último meta_message_id processado — retries do
  -- webhook da Meta não avançam a máquina duas vezes.
  last_meta_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_agendamento_sessoes_account
  ON agendamento_sessoes(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON agendamento_sessoes;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON agendamento_sessoes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE agendamento_sessoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agendamento_sessoes_select ON agendamento_sessoes;
CREATE POLICY agendamento_sessoes_select ON agendamento_sessoes
  FOR SELECT USING (is_account_member(account_id));
-- Sem políticas de escrita: só o service role (webhook) escreve.

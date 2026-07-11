# ClinBoost — Plano de transformação (wacrm → micro-SaaS para clínicas)

> Plano revisto contra o código real em 2026-07-11. O prompt original foi
> escrito para uma base genérica; este documento corrige-o com o que JÁ
> existe neste repositório e acrescenta o que o prompt não previu.

---

## 1. Correções ao prompt original — o que JÁ existe e NÃO se reconstrói

| O prompt pedia | O que já existe | Decisão |
|---|---|---|
| Criar tabela `clinicas` | `accounts` (017) com white-label `logo_url`/`brand_name` (038), isolamento RLS via `is_account_member()` em todas as tabelas | **`accounts` É a clínica.** Estender com os campos clínicos em falta — nunca criar tabela paralela, que quebraria RLS, auth e todas as FKs |
| `status_subscricao` / `validade_licenca` | `subscriptions.status` + `current_period_end` (039), com `resolveEntitlement()` que falha fechado | Reutilizar. "Ativo = acesso total, inativo = bloqueado" é exatamente o modelo atual: `requireActiveSubscription` já bloqueia envio/campanhas quando a assinatura caduca, e nada mais é limitado |
| Plano único 5.000 MT | Tabela `plans` com 3 planos semeados + pagamentos DebitoPay (M-Pesa síncrono) + confirmação manual + popup | Semear UM plano "ClinBoost" (5.000 MT, limites ilimitados) e desativar os outros (`is_active=false`). Zero código novo |
| White-label: logo | Feito (038 + `BrandMark` em toda a UI) | Falta só `cor_primaria` (ver §3) |
| Identificar clínica pelo número destinatário no webhook | **Já feito**: o webhook resolve a conta por `phone_number_id`, que é UNIQUE desde a migração 013 | A gestão centralizada da API Meta já é suportada pela arquitetura — ver §2 |
| Dashboard Kanban | Kanban completo em Pipelines (dnd-kit) | Reutilizar o padrão para o Kanban de consultas do dia |
| Cron/Edge Functions | `/api/automations/cron` e `/api/flows/cron` protegidos por `AUTOMATION_CRON_SECRET` | Mesmo padrão + **Vercel Crons** (`vercel.json`) — já estamos na Vercel |
| "Interface Lovable" | O frontend é **Next.js 16 + Tailwind v4**, não Lovable | Adaptar os componentes existentes; remover referência a Lovable |
| Bot com árvore de decisão | Motor de Flows (botões, listas, collect_input, condições, handoff) existe e funciona | O bot de agendamento será um **módulo dedicado** (`lib/appointments/bot.ts`): precisa de ler slots da BD e escrever agendamentos, que o motor genérico não faz. Os Flows continuam disponíveis para menus genéricos |

## 2. O que o prompt NÃO previu (e decide o sucesso do produto)

### 2.1 A janela de 24 horas da Meta — restrição central de TODO o desenho
Uma empresa só pode enviar mensagem livre a um número que lhe escreveu nas
últimas 24h. Consequências diretas:

- **Lembrete 24h antes da consulta**: o paciente quase nunca terá sessão
  aberta → tem de ser um **template aprovado pela Meta** (categoria
  Utility) com botões de quick-reply ("Confirmar" / "Reagendar"). A
  resposta ao botão abre nova sessão e o webhook processa-a.
- **Feedback 2h depois** e **recuperação de faltas**: idem — templates.
- **Alerta interno à receção**: o número da receção não escreve ao bot →
  também é business-initiated → **template Utility** (ex.:
  `alerta_agendamento` com variáveis: paciente, médico, data, ação).
- A infraestrutura de templates (submissão à Meta, sync, envio) **já
  existe** no projeto — é desenhar e aprovar os templates certos.

### 2.2 Gestão centralizada da API Meta — o modelo operacional
O código já suporta N números → N contas (webhook roteia por
`phone_number_id`). O modelo "Byteboost paga a Meta" é operacional, não
técnico:

- 1 App Meta + 1 WABA da Byteboost; cada clínica = 1 número registado
  nessa WABA. O operador (tu) preenche o `whatsapp_config` da clínica
  (token central + `phone_number_id` dela) — inicialmente à mão, depois
  via página no `/admin`.
- **Gargalo real mantém-se**: escalar para além de ~poucos números exige
  estatuto de **Tech Provider da Meta** (verificação de negócio). Começar
  já o processo — demora semanas e não depende de código.
- Custo por conversa é pago pela Byteboost → o preço de 5.000 MT deve
  assumir um teto razoável de conversas; registar volume por conta
  (contagem simples sobre `messages`) para vigiar margem.

### 2.3 Outros pontos em falta no prompt
- **Fuso horário**: agendamentos em CAT (UTC+2). Guardar `timestamptz` +
  `timezone` na conta; toda a lógica de slots calcula no fuso da clínica.
- **Idempotência dos crons**: colunas `lembrete_enviado_em`,
  `feedback_enviado_em`, `recuperacao_enviada_em` no agendamento — um
  cron que corre duas vezes não pode mandar duas mensagens.
- **i18n**: toda a UI nova entra em `messages/pt.json` E `en.json`
  (paridade validada).
- **Pacientes ≠ tabela nova**: `contacts` já tem dedupe por telefone,
  notas, tags, campos personalizados. Paciente = contact. Dados clínicos
  extra (ex.: data de nascimento) via campos personalizados ou colunas
  novas em `contacts` — decidir na Fase 1 pelo mínimo necessário.
- **Conflito bot ↔ atendimento humano**: o webhook já tem prioridades
  (flows → AI → humano). O bot de agendamento entra ANTES da AI, e o
  handoff existente pausa-o quando um humano assume.
- **Nome do produto**: "ClinBoost" é marca do operador; a clínica vê a
  marca dela (`brand_name`/logo já implementados). Falta garantir que
  `<title>`, emails e strings default usam a marca da conta — varrer
  ocorrências fixas.

---

## 3. Plano de execução por fases

### Fase 0 — Preparação (½ dia)
1. **Commit + push** dos 36 ficheiros pendentes (nada disto está no Git).
2. Decidir: transformar este deploy (wacrm→ClinBoost) ou branch/projeto
   separado. Recomendação: **mesma base, mesmo deploy** — o nicho é
   configuração, não fork.
3. Ligar o repo GitHub ao projeto Vercel (app GitHub) para deploy por push.

### Fase 1 — Base de dados (migração `041_clinboost_core.sql`) (1–2 dias)
- `accounts` += `cor_primaria TEXT` (hex validado), `numero_recepcao TEXT`,
  `timezone TEXT DEFAULT 'Africa/Maputo'`, `subdominio TEXT UNIQUE NULL`
  (para uso futuro — routing por subdomínio fica fora do MVP).
- `especialidades` (id, account_id, nome, ativo).
- `profissionais` (id, account_id, nome, especialidade_id, ativo;
  opcional user_id se o médico fizer login).
- `disponibilidade` (profissional_id, dia_semana, hora_inicio, hora_fim)
  + `disponibilidade_excecoes` (data, motivo) para férias/feriados.
- `agendamentos` (id, account_id, contact_id, profissional_id,
  especialidade_id, inicio timestamptz, fim timestamptz, status ENUM
  `pendente|confirmado|cancelado|concluido|falta`, origem `bot|manual`,
  notas, lembrete_enviado_em, feedback_enviado_em,
  recuperacao_enviada_em, created_at/updated_at).
  - Índice UNIQUE parcial anti-colisão: (profissional_id, inicio) WHERE
    status NOT IN ('cancelado').
- RLS em TODAS: padrão exato da 017 (`is_account_member(account_id)` para
  SELECT, `'agent'` para escrita, `'admin'` para configuração).
- Seed: desativar planos antigos, criar plano único ClinBoost 5.000 MT.

### Fase 2 — Motor de agendamento `src/lib/appointments/` (2–3 dias)
- `slots.ts`: slots livres = disponibilidade − exceções − agendamentos
  ativos, calculado no fuso da clínica. **Testes unitários exaustivos**
  (é o coração do produto; DST não existe em CAT, mas testar fronteiras
  de dia/semana).
- `book.ts`: criar/remarcar/cancelar com validação de colisão (apoiada
  no índice UNIQUE — a corrida entre dois pacientes é resolvida pela BD).
- `notify.ts`: alerta interno à receção via template Utility em cada
  transição de estado; regista falha sem partir o fluxo do paciente.

### Fase 3 — Bot de agendamento no webhook (3–4 dias)
- Módulo `lib/appointments/bot.ts` com máquina de estados por conversa
  (persistida, como as flow_runs): triagem novo/recorrente (contact
  existe?) → especialidade (lista interativa) → médico → dia → hora →
  confirmação. Cancelar/remarcar: lista as consultas futuras do contacto.
- Prioridade no webhook: agendamento (se conta tem módulo ativo) → flows
  → AI → humano. Handoff humano pausa o bot (mecanismo existente).
- Tudo dentro da sessão de 24h aberta pelo paciente → mensagens
  interativas normais, sem templates.

### Fase 4 — Gatilhos programados (1–2 dias)
- `vercel.json` com 3 crons (ex.: lembretes de 15 em 15 min; feedback de
  15 em 15; no-show 1×/dia), todos a chamar rotas protegidas por
  `AUTOMATION_CRON_SECRET`:
  - `lembrete 24h`: agendamentos `pendente|confirmado` com início entre
    23h30 e 24h30 e `lembrete_enviado_em IS NULL` → template com botões
    Confirmar/Reagendar; resposta tratada pelo webhook (confirmar muda
    status; reagendar entra no fluxo do bot).
  - `feedback 2h`: `concluido` há ≥2h, `feedback_enviado_em IS NULL`.
  - `no-show`: `falta` (marcada pela receção no Kanban) →
    template de recuperação com CTA de reagendamento.
- **Pré-requisito**: submeter os 4 templates Utility à Meta (aprovação
  ~24h) — fazer no início da fase, não no fim.

### Fase 5 — UI (4–5 dias)
- Secção **Agenda** no dashboard: calendário semanal por médico
  (gestão de horários) + criação manual de consulta pela receção.
- **Kanban do dia**: colunas = status; arrastar = transição (reuso do
  padrão dnd-kit de Pipelines); marcar "Falta"/"Concluído" alimenta os
  crons da Fase 4.
- Definições: gestão de **profissionais, especialidades e horários**
  (admin da clínica); acrescentar **cor primária** à página de Marca
  existente — aplicada via CSS variables (o sistema de temas/accent já
  existe em Appearance; passa a ler da conta).
- `/admin` (operador): provisionar número WhatsApp por clínica
  (formulário que escreve o `whatsapp_config` da conta com o token
  central) + ativar/desativar clínica.
- i18n pt+en para tudo.

### Fase 6 — Branding absoluto + polimento (1–2 dias)
- Varrer strings fixas "wacrm"/"CRM Template" → `brand_name` da conta em
  `<title>`, metadata, emails de convite.
- Esconder/renomear módulos genéricos conforme decisão (ver perguntas).
- Verificação de paridade i18n + typecheck + testes + build.

### Fase 7 — Piloto (contínuo)
- 1 clínica real: número provisionado, templates aprovados, bot afinado
  com conversas reais antes de abrir vendas.

**Total estimado: ~3 semanas de trabalho focado** (Fases 2+3 são o
núcleo; a 5 é a mais longa).

---

## 4. Riscos, por ordem
1. **Templates Meta não aprovados a tempo** → submeter na Fase 4-início;
   ter redação alternativa pronta.
2. **Tech Provider Meta** → iniciar já; sem isto o onboarding de cada
   clínica é manual e lento (mas possível).
3. **Custo Meta por conversa** vs preço único → medir desde o dia 1.
4. **Slots com bugs** = consultas em conflito = perda de confiança →
   testes primeiro, UI depois.

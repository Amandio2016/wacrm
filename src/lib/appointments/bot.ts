import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  engineSendText,
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from "@/lib/flows/meta-send";
import { availableSlots, type Slot } from "./slots";
import { groupSlotsByDay, formatSlotLabel, formatTimeLabel } from "./format";
import {
  createAppointment,
  cancelAppointment,
  confirmAppointment,
  rescheduleAppointment,
} from "./book";

/**
 * Bot de agendamento — a máquina de estados que atende o paciente.
 *
 * Diálogo: menu → especialidade → profissional → dia → hora →
 * confirmar. "Minhas consultas" lista as futuras e permite cancelar ou
 * remarcar (remarcar reutiliza dia→hora com o mesmo profissional).
 *
 * Regras de convivência com os outros motores (webhook chama isto
 * ANTES de flows e AI):
 *   - Só engaja se a conta tiver ≥1 profissional ativo (é isso que
 *     define "conta em modo clínica" — sem migração extra).
 *   - Conversa atribuída a um humano → bot mudo, sempre.
 *   - Sem sessão ativa: só engaja em saudações/intenções de marcação
 *     (ou toques em botões `apt:`). Qualquer outra mensagem passa aos
 *     motores seguintes — o bot não sequestra a caixa de entrada.
 *   - Sessões > 60 min sem atividade são descartadas: o paciente que
 *     volta no dia seguinte recomeça no menu, não a meio de um passo.
 *
 * Todos os reply_ids têm prefixo `apt:` para nunca colidirem com os
 * ids configurados em flows/automações do operador.
 */

const SESSION_TTL_MS = 60 * 60_000;
/** Quantos dias à frente o bot procura vagas. */
const SEARCH_DAYS = 14;
/** Antecedência mínima de uma marcação feita pelo bot. */
const MIN_LEAD_MINUTES = 60;

const GREETING_OR_INTENT =
  /\b(ol[aá]|oi|bom dia|boa tarde|boa noite|marcar|marca[cç][aã]o|agendar|consulta|remarcar|cancelar|menu)\b/i;

interface BotDispatchInput {
  accountId: string;
  userId: string;
  contactId: string;
  conversationId: string;
  message:
    | { kind: "text"; text: string; meta_message_id: string }
    | { kind: "interactive_reply"; reply_id: string; reply_title: string; meta_message_id: string };
}

interface SessionRow {
  id: string;
  estado: string;
  dados: Dados;
  last_meta_message_id: string | null;
  updated_at: string;
}

/** Escolhas acumuladas + mapas reply_id→valor das listas apresentadas. */
interface Dados {
  especialidade_id?: string | null;
  especialidade_nome?: string;
  profissional_id?: string;
  profissional_nome?: string;
  duracao_minutos?: number;
  /** "YYYY-MM-DD" local escolhido. */
  dia?: string;
  /** Opções da última lista: reply_id → payload serializado. */
  opcoes?: Record<string, string>;
  /** Slot escolhido (ISO) à espera de confirmação. */
  slot_inicio?: string;
  slot_fim?: string;
  /** Agendamento alvo de cancelar/remarcar. */
  agendamento_id?: string;
  remarcar?: boolean;
}

export interface BotDispatchResult {
  consumed: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export async function dispatchInboundToAppointmentBot(
  input: BotDispatchInput,
): Promise<BotDispatchResult> {
  const db = supabaseAdmin();
  try {
    // Conta em modo clínica?
    const { count } = await db
      .from("profissionais")
      .select("id", { count: "exact", head: true })
      .eq("account_id", input.accountId)
      .eq("ativo", true);
    if (!count) return { consumed: false };

    // Humano ao leme → bot mudo.
    const { data: convo } = await db
      .from("conversations")
      .select("assigned_to")
      .eq("id", input.conversationId)
      .maybeSingle();
    if (convo?.assigned_to) return { consumed: false };

    // Respostas aos botões dos TEMPLATES (lembrete 24h, recuperação de
    // falta) carregam o id do agendamento no payload e chegam sem
    // sessão — o paciente toca no botão horas ou dias depois. Tratadas
    // antes de qualquer lógica de sessão.
    if (input.message.kind === "interactive_reply") {
      const rid = input.message.reply_id;
      const confirmMatch = rid.match(/^apt:confirmar:(.+)$/);
      if (confirmMatch) {
        const ctx: Ctx = { db, input };
        const ok = await confirmAppointment(db, input.accountId, confirmMatch[1]);
        await send.text(
          ctx,
          ok
            ? "✅ Consulta confirmada. Até breve!"
            : "Esta consulta já não está ativa. Escreva *marcar* se quiser um novo horário.",
        );
        return { consumed: true };
      }
      const rescheduleMatch = rid.match(/^apt:reagendar:(.+)$/);
      if (rescheduleMatch) {
        const ctx: Ctx = { db, input };
        const { data: apt } = await db
          .from("agendamentos")
          .select("id, status, profissional_id, profissionais(nome, duracao_consulta_minutos)")
          .eq("id", rescheduleMatch[1])
          .eq("account_id", input.accountId)
          .maybeSingle();
        const prof = apt?.profissionais as unknown as {
          nome: string;
          duracao_consulta_minutos: number;
        } | null;
        if (apt && prof && ["pendente", "confirmado", "falta"].includes(apt.status)) {
          await stepDia(ctx, {
            agendamento_id: apt.id,
            remarcar: apt.status !== "falta",
            profissional_id: apt.profissional_id,
            profissional_nome: prof.nome,
            duracao_minutos: prof.duracao_consulta_minutos,
          });
        } else {
          await upsertSession(ctx, "menu", {});
          await showMenu(ctx);
        }
        return { consumed: true };
      }
    }

    const { data: sessionRow } = await db
      .from("agendamento_sessoes")
      .select("id, estado, dados, last_meta_message_id, updated_at")
      .eq("conversation_id", input.conversationId)
      .maybeSingle();

    let session = sessionRow as SessionRow | null;

    // Idempotência: retry da Meta com o mesmo message_id não re-avança.
    if (session?.last_meta_message_id === input.message.meta_message_id) {
      return { consumed: true };
    }

    const stale =
      session &&
      Date.now() - new Date(session.updated_at).getTime() > SESSION_TTL_MS;

    const isAptReply =
      input.message.kind === "interactive_reply" &&
      input.message.reply_id.startsWith("apt:");
    const isIntent =
      input.message.kind === "text" && GREETING_OR_INTENT.test(input.message.text);

    // Sem sessão viva e sem intenção → não é connosco.
    if ((!session || stale) && !isIntent && !isAptReply) {
      return { consumed: false };
    }

    const ctx: Ctx = { db, input };

    if (!session || stale) {
      session = await upsertSession(ctx, "menu", {});
      await showMenu(ctx);
      return { consumed: true };
    }

    await advance(ctx, session);
    return { consumed: true };
  } catch (err) {
    console.error(
      "[appointments/bot] dispatch failed:",
      err instanceof Error ? err.message : err,
    );
    // Nunca deixar o paciente sem resposta por um erro nosso — mas
    // também não fingir que consumimos: os motores seguintes (AI/humano)
    // ficam com a mensagem.
    return { consumed: false };
  }
}

// ============================================================
// Máquina de estados
// ============================================================

interface Ctx {
  db: Db;
  input: BotDispatchInput;
}

const send = {
  text: (ctx: Ctx, text: string) =>
    engineSendText({
      accountId: ctx.input.accountId,
      userId: ctx.input.userId,
      conversationId: ctx.input.conversationId,
      contactId: ctx.input.contactId,
      text,
    }),
  buttons: (
    ctx: Ctx,
    bodyText: string,
    buttons: { id: string; title: string }[],
  ) =>
    engineSendInteractiveButtons({
      accountId: ctx.input.accountId,
      userId: ctx.input.userId,
      conversationId: ctx.input.conversationId,
      contactId: ctx.input.contactId,
      bodyText,
      buttons,
    }),
  list: (
    ctx: Ctx,
    bodyText: string,
    buttonLabel: string,
    rows: { id: string; title: string; description?: string }[],
  ) =>
    engineSendInteractiveList({
      accountId: ctx.input.accountId,
      userId: ctx.input.userId,
      conversationId: ctx.input.conversationId,
      contactId: ctx.input.contactId,
      bodyText,
      buttonLabel,
      sections: [{ title: undefined, rows }],
    }),
};

async function upsertSession(
  ctx: Ctx,
  estado: string,
  dados: Dados,
): Promise<SessionRow> {
  const { data } = await ctx.db
    .from("agendamento_sessoes")
    .upsert(
      {
        account_id: ctx.input.accountId,
        conversation_id: ctx.input.conversationId,
        contact_id: ctx.input.contactId,
        estado,
        dados,
        last_meta_message_id: ctx.input.message.meta_message_id,
      },
      { onConflict: "conversation_id" },
    )
    .select("id, estado, dados, last_meta_message_id, updated_at")
    .single();
  return data as SessionRow;
}

async function endSession(ctx: Ctx): Promise<void> {
  await ctx.db
    .from("agendamento_sessoes")
    .delete()
    .eq("conversation_id", ctx.input.conversationId);
}

function replyId(ctx: Ctx): string | null {
  return ctx.input.message.kind === "interactive_reply"
    ? ctx.input.message.reply_id
    : null;
}

async function accountTimezone(ctx: Ctx): Promise<string> {
  const { data } = await ctx.db
    .from("accounts")
    .select("timezone")
    .eq("id", ctx.input.accountId)
    .maybeSingle();
  return data?.timezone ?? "Africa/Maputo";
}

async function showMenu(ctx: Ctx): Promise<void> {
  await send.buttons(ctx, "Olá! 👋 Sou o assistente de marcações. Como posso ajudar?", [
    { id: "apt:marcar", title: "Marcar consulta" },
    { id: "apt:minhas", title: "Minhas consultas" },
    { id: "apt:humano", title: "Falar com alguém" },
  ]);
}

async function advance(ctx: Ctx, session: SessionRow): Promise<void> {
  const id = replyId(ctx);

  // Escape hatches globais — válidos em QUALQUER passo, porque um
  // paciente preso num passo que não entende desiste do bot (e da
  // clínica). "Falar com alguém" encerra a sessão e cala o bot;
  // "menu" recomeça limpo.
  if (id === "apt:humano") {
    await endSession(ctx);
    await send.text(
      ctx,
      "Certo! Um membro da nossa equipa vai responder-lhe aqui em breve. 🙏",
    );
    return;
  }
  if (
    ctx.input.message.kind === "text" &&
    /\b(menu|recome[cç]ar|voltar)\b/i.test(ctx.input.message.text)
  ) {
    await upsertSession(ctx, "menu", {});
    await showMenu(ctx);
    return;
  }

  switch (session.estado) {
    case "menu": {
      if (id === "apt:marcar") return stepEspecialidade(ctx);
      if (id === "apt:minhas") return stepMinhas(ctx);
      // Texto livre no menu (ex.: "quero marcar") — heurística simples.
      if (ctx.input.message.kind === "text") {
        if (/\b(marcar|agendar|consulta)\b/i.test(ctx.input.message.text)) {
          return stepEspecialidade(ctx);
        }
        if (/\b(remarcar|cancelar|minhas?)\b/i.test(ctx.input.message.text)) {
          return stepMinhas(ctx);
        }
      }
      await showMenu(ctx);
      return;
    }

    case "especialidade": {
      const chosen = id && session.dados.opcoes?.[id];
      if (!chosen) return stepEspecialidade(ctx);
      const [espId, espNome] = JSON.parse(chosen) as [string | null, string];
      return stepProfissional(ctx, { especialidade_id: espId, especialidade_nome: espNome });
    }

    case "profissional": {
      const chosen = id && session.dados.opcoes?.[id];
      if (!chosen) return stepProfissional(ctx, session.dados);
      const [profId, profNome, duracao] = JSON.parse(chosen) as [string, string, number];
      return stepDia(ctx, {
        ...session.dados,
        profissional_id: profId,
        profissional_nome: profNome,
        duracao_minutos: duracao,
      });
    }

    case "dia": {
      const chosen = id && session.dados.opcoes?.[id];
      if (!chosen) return stepDia(ctx, session.dados);
      return stepHora(ctx, { ...session.dados, dia: JSON.parse(chosen) as string });
    }

    case "hora": {
      const chosen = id && session.dados.opcoes?.[id];
      if (!chosen) return stepHora(ctx, session.dados);
      const [inicio, fim] = JSON.parse(chosen) as [string, string];
      return stepConfirmar(ctx, {
        ...session.dados,
        slot_inicio: inicio,
        slot_fim: fim,
      });
    }

    case "confirmar": {
      if (id === "apt:confirmo") return doBook(ctx, session.dados);
      if (id === "apt:desisto") {
        await upsertSession(ctx, "menu", {});
        await send.text(ctx, "Sem problema, nada foi marcado.");
        await showMenu(ctx);
        return;
      }
      return stepConfirmar(ctx, session.dados);
    }

    case "minhas": {
      const chosen = id && session.dados.opcoes?.[id];
      if (!chosen) return stepMinhas(ctx);
      return stepAcaoConsulta(ctx, {
        agendamento_id: JSON.parse(chosen) as string,
      });
    }

    case "acao_consulta": {
      if (id === "apt:cancelar") {
        const ok =
          session.dados.agendamento_id != null &&
          (await cancelAppointment(
            ctx.db,
            ctx.input.accountId,
            session.dados.agendamento_id,
          ));
        await endSession(ctx);
        await send.text(
          ctx,
          ok
            ? "Consulta cancelada. Se precisar, é só escrever *marcar* para escolher novo horário. 👍"
            : "Não consegui cancelar essa consulta — a nossa equipa vai verificar.",
        );
        return;
      }
      if (id === "apt:remarcar") {
        // Reaproveita dia→hora com o profissional da consulta original.
        const { data: apt } = await ctx.db
          .from("agendamentos")
          .select("profissional_id, profissionais(nome, duracao_consulta_minutos)")
          .eq("id", session.dados.agendamento_id)
          .maybeSingle();
        const prof = apt?.profissionais as unknown as {
          nome: string;
          duracao_consulta_minutos: number;
        } | null;
        if (!apt || !prof) return stepMinhas(ctx);
        return stepDia(ctx, {
          agendamento_id: session.dados.agendamento_id,
          remarcar: true,
          profissional_id: apt.profissional_id,
          profissional_nome: prof.nome,
          duracao_minutos: prof.duracao_consulta_minutos,
        });
      }
      return stepAcaoConsulta(ctx, session.dados);
    }

    default: {
      await upsertSession(ctx, "menu", {});
      await showMenu(ctx);
    }
  }
}

// ---- Passos ------------------------------------------------------

async function stepEspecialidade(ctx: Ctx): Promise<void> {
  const { data: rows } = await ctx.db
    .from("especialidades")
    .select("id, nome")
    .eq("account_id", ctx.input.accountId)
    .eq("ativo", true)
    .order("nome")
    .limit(10);

  // Clínica sem especialidades → salta direto para os profissionais.
  if (!rows?.length) {
    return stepProfissional(ctx, { especialidade_id: null });
  }

  const opcoes: Record<string, string> = {};
  const items = rows.map((r: { id: string; nome: string }, i: number) => {
    const rid = `apt:esp:${i}`;
    opcoes[rid] = JSON.stringify([r.id, r.nome]);
    return { id: rid, title: r.nome.slice(0, 24) };
  });

  await upsertSession(ctx, "especialidade", { opcoes });
  await send.list(ctx, "Qual especialidade procura?", "Ver especialidades", items);
}

async function stepProfissional(ctx: Ctx, dados: Dados): Promise<void> {
  let query = ctx.db
    .from("profissionais")
    .select("id, nome, duracao_consulta_minutos")
    .eq("account_id", ctx.input.accountId)
    .eq("ativo", true)
    .order("nome")
    .limit(10);
  if (dados.especialidade_id) {
    query = query.eq("especialidade_id", dados.especialidade_id);
  }
  const { data: rows } = await query;

  if (!rows?.length) {
    await upsertSession(ctx, "menu", {});
    await send.text(
      ctx,
      "De momento não há profissionais disponíveis para marcação. A nossa equipa vai ajudá-lo aqui. 🙏",
    );
    return;
  }

  const opcoes: Record<string, string> = {};
  const items = rows.map(
    (r: { id: string; nome: string; duracao_consulta_minutos: number }, i: number) => {
      const rid = `apt:prof:${i}`;
      opcoes[rid] = JSON.stringify([r.id, r.nome, r.duracao_consulta_minutos]);
      return { id: rid, title: r.nome.slice(0, 24) };
    },
  );

  await upsertSession(ctx, "profissional", { ...dados, opcoes });
  await send.list(ctx, "Com que profissional deseja marcar?", "Ver profissionais", items);
}

async function loadSlots(ctx: Ctx, dados: Dados): Promise<Slot[]> {
  const tz = await accountTimezone(ctx);
  const [{ data: windows }, { data: exceptions }, { data: busy }] =
    await Promise.all([
      ctx.db
        .from("disponibilidade")
        .select("dia_semana, hora_inicio, hora_fim")
        .eq("profissional_id", dados.profissional_id),
      ctx.db
        .from("disponibilidade_excecoes")
        .select("data")
        .eq("profissional_id", dados.profissional_id),
      ctx.db
        .from("agendamentos")
        .select("inicio, fim")
        .eq("profissional_id", dados.profissional_id)
        .neq("status", "cancelado")
        .gte("inicio", new Date().toISOString()),
    ]);

  const now = new Date();
  return availableSlots({
    windows: windows ?? [],
    exceptions: exceptions ?? [],
    busy: busy ?? [],
    slotMinutes: dados.duracao_minutos ?? 30,
    timezone: tz,
    from: now,
    to: new Date(now.getTime() + SEARCH_DAYS * 86_400_000),
    minLeadMinutes: MIN_LEAD_MINUTES,
  });
}

async function stepDia(ctx: Ctx, dados: Dados): Promise<void> {
  const tz = await accountTimezone(ctx);
  const slots = await loadSlots(ctx, dados);
  const days = groupSlotsByDay(slots, tz, 10);

  if (!days.length) {
    await upsertSession(ctx, "menu", {});
    await send.text(
      ctx,
      `${dados.profissional_nome ?? "Este profissional"} não tem vagas nos próximos ${SEARCH_DAYS} dias. A nossa equipa pode ajudar a encontrar alternativa. 🙏`,
    );
    return;
  }

  const opcoes: Record<string, string> = {};
  const items = days.map((d, i) => {
    const rid = `apt:dia:${i}`;
    opcoes[rid] = JSON.stringify(d.key);
    return {
      id: rid,
      title: d.label.slice(0, 24),
      description: `${d.slots.length} horários livres`,
    };
  });

  await upsertSession(ctx, "dia", { ...dados, opcoes });
  await send.list(
    ctx,
    `Dias com vaga para ${dados.profissional_nome}:`,
    "Escolher dia",
    items,
  );
}

async function stepHora(ctx: Ctx, dados: Dados): Promise<void> {
  const tz = await accountTimezone(ctx);
  const slots = await loadSlots(ctx, dados);
  const daySlots = groupSlotsByDay(slots, tz, 31).find((d) => d.key === dados.dia);

  // O dia esvaziou entre a listagem e a escolha — volta aos dias.
  if (!daySlots?.slots.length) {
    await send.text(ctx, "Esse dia acabou de ficar sem vagas — vamos escolher outro.");
    return stepDia(ctx, dados);
  }

  const opcoes: Record<string, string> = {};
  const items = daySlots.slots.slice(0, 10).map((s, i) => {
    const rid = `apt:hora:${i}`;
    opcoes[rid] = JSON.stringify([s.inicio.toISOString(), s.fim.toISOString()]);
    return { id: rid, title: formatTimeLabel(s.inicio, tz) };
  });

  await upsertSession(ctx, "hora", { ...dados, opcoes });
  await send.list(ctx, `Horários livres em ${daySlots.label}:`, "Escolher hora", items);
}

async function stepConfirmar(ctx: Ctx, dados: Dados): Promise<void> {
  const tz = await accountTimezone(ctx);
  const quando = formatSlotLabel(new Date(dados.slot_inicio!), tz);
  await upsertSession(ctx, "confirmar", dados);
  await send.buttons(
    ctx,
    `Confirma a ${dados.remarcar ? "remarcação" : "marcação"}?\n\n👨‍⚕️ ${dados.profissional_nome}\n📅 ${quando}`,
    [
      { id: "apt:confirmo", title: "Confirmar" },
      { id: "apt:desisto", title: "Cancelar" },
    ],
  );
}

async function doBook(ctx: Ctx, dados: Dados): Promise<void> {
  const tz = await accountTimezone(ctx);
  const inicio = new Date(dados.slot_inicio!);
  const fim = new Date(dados.slot_fim!);

  const result = dados.remarcar && dados.agendamento_id
    ? await rescheduleAppointment(
        ctx.db,
        ctx.input.accountId,
        dados.agendamento_id,
        inicio,
        fim,
      )
    : await createAppointment(ctx.db, {
        accountId: ctx.input.accountId,
        contactId: ctx.input.contactId,
        profissionalId: dados.profissional_id!,
        especialidadeId: dados.especialidade_id ?? null,
        inicio,
        fim,
        origem: "bot",
      });

  if (!result.ok) {
    if (result.reason === "slot_taken") {
      // A corrida perdeu-se na constraint — reoferece o dia.
      await send.text(
        ctx,
        "Esse horário acabou de ser ocupado por outra pessoa. 😔 Vamos escolher outro:",
      );
      return stepHora(ctx, dados);
    }
    await endSession(ctx);
    await send.text(
      ctx,
      "Ocorreu um problema ao registar a marcação — a nossa equipa vai contactá-lo para concluir.",
    );
    return;
  }

  await endSession(ctx);
  await send.text(
    ctx,
    `✅ ${dados.remarcar ? "Consulta remarcada" : "Consulta marcada"}!\n\n👨‍⚕️ ${dados.profissional_nome}\n📅 ${formatSlotLabel(inicio, tz)}\n\nEnviaremos um lembrete antes da consulta. Até lá! 👋`,
  );
}

async function stepMinhas(ctx: Ctx): Promise<void> {
  const { data: rows } = await ctx.db
    .from("agendamentos")
    .select("id, inicio, profissionais(nome)")
    .eq("account_id", ctx.input.accountId)
    .eq("contact_id", ctx.input.contactId)
    .in("status", ["pendente", "confirmado"])
    .gte("inicio", new Date().toISOString())
    .order("inicio")
    .limit(10);

  if (!rows?.length) {
    await upsertSession(ctx, "menu", {});
    await send.buttons(ctx, "Não encontrei consultas futuras no seu número. Quer marcar uma?", [
      { id: "apt:marcar", title: "Marcar consulta" },
      { id: "apt:humano", title: "Falar com alguém" },
    ]);
    return;
  }

  const tz = await accountTimezone(ctx);
  const opcoes: Record<string, string> = {};
  const items = rows.map(
    (r: { id: string; inicio: string; profissionais: unknown }, i: number) => {
      const rid = `apt:apt:${i}`;
      opcoes[rid] = JSON.stringify(r.id);
      const prof = r.profissionais as { nome: string } | null;
      return {
        id: rid,
        title: formatSlotLabel(new Date(r.inicio), tz).slice(0, 24),
        description: prof?.nome,
      };
    },
  );

  await upsertSession(ctx, "minhas", { opcoes });
  await send.list(ctx, "As suas próximas consultas:", "Ver consultas", items);
}

async function stepAcaoConsulta(ctx: Ctx, dados: Dados): Promise<void> {
  await upsertSession(ctx, "acao_consulta", dados);
  await send.buttons(ctx, "O que deseja fazer com esta consulta?", [
    { id: "apt:remarcar", title: "Remarcar" },
    { id: "apt:cancelar", title: "Cancelar consulta" },
    { id: "apt:humano", title: "Falar com alguém" },
  ]);
}

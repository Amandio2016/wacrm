import { NextResponse } from "next/server";
import { billingAdmin } from "@/lib/billing/admin-client";
import { formatSlotLabel } from "@/lib/appointments/format";
import {
  loadSendContext,
  sendReminderTemplate,
  sendFeedbackTemplate,
  sendNoShowTemplate,
} from "@/lib/appointments/templates";

/**
 * Gatilhos programados do ClinBoost (Fase 4) — um endpoint, três
 * trabalhos, pensado para ser batido a cada 10–15 minutos por um
 * agendador externo (ou Vercel Cron no plano Pro):
 *
 *   1. Lembrete 24h — consultas pendentes/confirmadas que entram no
 *      horizonte das próximas 24h. Template com botões
 *      Confirmar/Reagendar (payload = id do agendamento).
 *   2. Feedback — consultas concluídas há ≥ 2h (e < 24h, para nunca
 *      ressuscitar histórico antigo num deploy).
 *   3. Recuperação de faltas — status 'falta' dos últimos 7 dias.
 *
 * Auth: header `x-cron-secret` = AUTOMATION_CRON_SECRET, o padrão
 * exato de /api/automations/cron.
 *
 * Idempotência — a decisão de desenho que importa aqui:
 * CLAIM-FIRST. Cada job marca a coluna *_enviado_em ANTES de enviar,
 * com um UPDATE condicionado a IS NULL cujo RETURNING nos diz se ESTA
 * execução ganhou a corrida. Duas invocações simultâneas não duplicam
 * mensagem; um crash entre claim e envio perde UMA mensagem (aceitável)
 * em vez de arriscar spam ao paciente (inaceitável). Falha de envio é
 * registada em voz alta e a claim NÃO é revertida: reverter criaria um
 * retry-storm contra um template não aprovado — o erro certo aparece
 * uma vez por consulta no log, não mil vezes.
 */

export const maxDuration = 300;

const HOUR_MS = 3_600_000;
/** Envios por invocação, por job — mantém a execução curta. */
const BATCH = 50;

interface DueRow {
  id: string;
  account_id: string;
  inicio: string;
  fim: string;
  contacts: { name: string | null; phone: string } | null;
  profissionais: { nome: string } | null;
}

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  if (request.headers.get("x-cron-secret") !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = billingAdmin();
  const configCache = new Map<
    string,
    Awaited<ReturnType<typeof loadSendContext>>
  >();
  const now = Date.now();

  // Fuso por conta para as etiquetas "amanhã às 08:00".
  const tzCache = new Map<string, string>();
  const timezoneOf = async (accountId: string): Promise<string> => {
    if (!tzCache.has(accountId)) {
      const { data } = await db
        .from("accounts")
        .select("timezone")
        .eq("id", accountId)
        .maybeSingle();
      tzCache.set(accountId, data?.timezone ?? "Africa/Maputo");
    }
    return tzCache.get(accountId)!;
  };

  /**
   * Claim atómica: só quem transitar NULL → NOW() envia. O `select`
   * no fim devolve [] quando outra invocação já reclamou a linha.
   */
  const claim = async (id: string, column: string): Promise<boolean> => {
    const { data } = await db
      .from("agendamentos")
      .update({ [column]: new Date().toISOString() })
      .eq("id", id)
      .is(column, null)
      .select("id");
    return Boolean(data?.length);
  };

  const stats = { lembretes: 0, feedback: 0, recuperacao: 0, falhas: 0 };

  // ---- 1. Lembrete 24h -------------------------------------------
  const { data: reminders } = await db
    .from("agendamentos")
    .select("id, account_id, inicio, fim, contacts(name, phone), profissionais(nome)")
    .in("status", ["pendente", "confirmado"])
    .is("lembrete_enviado_em", null)
    .gte("inicio", new Date(now + HOUR_MS).toISOString())
    .lte("inicio", new Date(now + 24 * HOUR_MS).toISOString())
    .limit(BATCH);

  for (const row of (reminders ?? []) as unknown as DueRow[]) {
    if (!row.contacts?.phone) continue;
    if (!(await claim(row.id, "lembrete_enviado_em"))) continue;
    try {
      const ctx = await loadSendContext(db, row.account_id, configCache);
      if (!ctx) throw new Error("whatsapp_config missing");
      await sendReminderTemplate({
        ctx,
        to: row.contacts.phone,
        paciente: row.contacts.name ?? "paciente",
        profissional: row.profissionais?.nome ?? "a nossa equipa",
        quando: formatSlotLabel(
          new Date(row.inicio),
          await timezoneOf(row.account_id),
        ),
        agendamentoId: row.id,
      });
      stats.lembretes++;
    } catch (err) {
      stats.falhas++;
      console.error(
        "[appointments/cron] lembrete falhou:",
        row.id,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ---- 2. Feedback 2h pós-consulta -------------------------------
  const { data: feedbacks } = await db
    .from("agendamentos")
    .select("id, account_id, inicio, fim, contacts(name, phone), profissionais(nome)")
    .eq("status", "concluido")
    .is("feedback_enviado_em", null)
    .lte("fim", new Date(now - 2 * HOUR_MS).toISOString())
    .gte("fim", new Date(now - 24 * HOUR_MS).toISOString())
    .limit(BATCH);

  for (const row of (feedbacks ?? []) as unknown as DueRow[]) {
    if (!row.contacts?.phone) continue;
    if (!(await claim(row.id, "feedback_enviado_em"))) continue;
    try {
      const ctx = await loadSendContext(db, row.account_id, configCache);
      if (!ctx) throw new Error("whatsapp_config missing");
      await sendFeedbackTemplate({
        ctx,
        to: row.contacts.phone,
        paciente: row.contacts.name ?? "paciente",
        profissional: row.profissionais?.nome ?? "a nossa equipa",
      });
      stats.feedback++;
    } catch (err) {
      stats.falhas++;
      console.error(
        "[appointments/cron] feedback falhou:",
        row.id,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ---- 3. Recuperação de faltas ----------------------------------
  const { data: noShows } = await db
    .from("agendamentos")
    .select("id, account_id, inicio, fim, contacts(name, phone), profissionais(nome)")
    .eq("status", "falta")
    .is("recuperacao_enviada_em", null)
    .gte("inicio", new Date(now - 7 * 24 * HOUR_MS).toISOString())
    .limit(BATCH);

  for (const row of (noShows ?? []) as unknown as DueRow[]) {
    if (!row.contacts?.phone) continue;
    if (!(await claim(row.id, "recuperacao_enviada_em"))) continue;
    try {
      const ctx = await loadSendContext(db, row.account_id, configCache);
      if (!ctx) throw new Error("whatsapp_config missing");
      await sendNoShowTemplate({
        ctx,
        to: row.contacts.phone,
        paciente: row.contacts.name ?? "paciente",
        profissional: row.profissionais?.nome ?? "a nossa equipa",
        agendamentoId: row.id,
      });
      stats.recuperacao++;
    } catch (err) {
      stats.falhas++;
      console.error(
        "[appointments/cron] recuperacao falhou:",
        row.id,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return NextResponse.json(stats);
}

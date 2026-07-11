import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTextMessage } from "@/lib/whatsapp/meta-api";
import { decrypt } from "@/lib/whatsapp/encryption";
import { formatSlotLabel } from "./format";

/**
 * Internal reception alert — "consulta marcada/remarcada/cancelada".
 *
 * Sends a WhatsApp text from the clinic's own number to its
 * `numero_recepcao` on every appointment state change.
 *
 * Honest limitation, documented in docs/clinboost-plan.md §2.1: Meta
 * only allows free-form text inside a 24h customer-service window. The
 * reception number rarely messages the clinic's bot, so this send WILL
 * be rejected once the window is closed — until the `alerta_agendamento`
 * Utility template is approved (Fase 4) and this switches to
 * sendTemplateMessage. Until then: best-effort send + loud log, and the
 * reception can keep the window open by messaging the clinic number
 * once a day. A failed alert never fails the booking itself.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export interface ReceptionAlert {
  accountId: string;
  agendamentoId: string;
  acao: "marcada" | "remarcada" | "cancelada" | "confirmada";
}

export async function notifyReception(
  db: Db,
  alert: ReceptionAlert,
): Promise<void> {
  try {
    const { data: account } = await db
      .from("accounts")
      .select("numero_recepcao, timezone")
      .eq("id", alert.accountId)
      .maybeSingle();

    // No reception number configured = the clinic opted out. Fine.
    if (!account?.numero_recepcao) return;

    const { data: apt } = await db
      .from("agendamentos")
      .select(
        "inicio, fim, contacts(name, phone), profissionais(nome), especialidades(nome)",
      )
      .eq("id", alert.agendamentoId)
      .maybeSingle();

    if (!apt) return;

    const { data: config } = await db
      .from("whatsapp_config")
      .select("phone_number_id, access_token")
      .eq("account_id", alert.accountId)
      .maybeSingle();

    if (!config) return;

    // PostgREST devolve relações como objeto (FK singular) — o cast
    // cobre a variação de tipos do supabase-js.
    const contact = apt.contacts as unknown as { name: string | null; phone: string } | null;
    const prof = apt.profissionais as unknown as { nome: string } | null;
    const esp = apt.especialidades as unknown as { nome: string } | null;

    const quando = formatSlotLabel(
      new Date(apt.inicio),
      account.timezone ?? "Africa/Maputo",
    );

    const linhas = [
      `🔔 Consulta ${alert.acao}`,
      `Paciente: ${contact?.name ?? contact?.phone ?? "—"}`,
      contact?.phone ? `Contacto: ${contact.phone}` : null,
      prof ? `Profissional: ${prof.nome}` : null,
      esp ? `Especialidade: ${esp.nome}` : null,
      `Quando: ${quando}`,
    ].filter(Boolean);

    await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      to: account.numero_recepcao.replace(/[^\d+]/g, ""),
      text: linhas.join("\n"),
    });
  } catch (err) {
    // Fora da janela de 24h (ver doc-comment) ou falha transitória.
    // O agendamento em si já está persistido — nunca propagar.
    console.warn(
      "[appointments/notify] reception alert failed:",
      alert.agendamentoId,
      err instanceof Error ? err.message : err,
    );
  }
}

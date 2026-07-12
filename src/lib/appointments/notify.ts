import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTemplateMessage } from "@/lib/whatsapp/meta-api";
import { decrypt } from "@/lib/whatsapp/encryption";
import { formatSlotLabel } from "./format";

/**
 * Internal reception alert — "consulta marcada/remarcada/cancelada".
 *
 * Sent as the `alerta_agendamento` Utility template (pt_PT), approved
 * by Meta, so it reaches the reception number regardless of whether a
 * 24h service window is open — reception rarely messages the clinic's
 * own bot, so relying on free-form text would silently drop most
 * alerts. Body variables, in order (must match what was submitted to
 * Meta):
 *
 *   {{1}} acao          — "marcada" | "remarcada" | "cancelada" | "confirmada"
 *   {{2}} paciente       — nome do contacto (ou telefone, sem nome)
 *   {{3}} contacto       — telefone do paciente
 *   {{4}} profissional   — nome do médico
 *   {{5}} especialidade  — nome da especialidade (ou "—")
 *   {{6}} quando         — "seg, 13/07 às 08:00"
 *
 * A failed alert never fails the booking itself — this is a courtesy
 * notification, not part of the transaction.
 */

const TEMPLATE_NAME = "alerta_agendamento";
const LANGUAGE = "pt_PT";

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

    await sendTemplateMessage({
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      to: account.numero_recepcao.replace(/[^\d+]/g, ""),
      templateName: TEMPLATE_NAME,
      language: LANGUAGE,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: alert.acao },
            { type: "text", text: contact?.name ?? contact?.phone ?? "—" },
            { type: "text", text: contact?.phone ?? "—" },
            { type: "text", text: prof?.nome ?? "—" },
            { type: "text", text: esp?.nome ?? "—" },
            { type: "text", text: quando },
          ],
        },
      ],
    });
  } catch (err) {
    // Template ainda não aprovado, número inválido, ou falha
    // transitória. O agendamento em si já está persistido — nunca
    // propagar o erro.
    console.warn(
      "[appointments/notify] reception alert failed:",
      alert.agendamentoId,
      err instanceof Error ? err.message : err,
    );
  }
}

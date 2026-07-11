import type { SupabaseClient } from "@supabase/supabase-js";
import { sendTemplateMessage } from "@/lib/whatsapp/meta-api";
import { decrypt } from "@/lib/whatsapp/encryption";

/**
 * Template senders for the scheduled patient messages (Fase 4).
 *
 * These messages are business-initiated OUTSIDE Meta's 24h service
 * window, so free-form text is not an option — each one is a
 * pre-approved Utility template. The template NAMES and variable
 * shapes below are a contract with what the operator submits to Meta
 * (redações em docs/clinboost-plan.md / mensagem da Fase 4):
 *
 *   lembrete_consulta(pt_PT)   body {{1}}=paciente {{2}}=profissional {{3}}=quando
 *                              quick replies: [0] Confirmar  [1] Reagendar
 *   feedback_consulta(pt_PT)   body {{1}}=paciente {{2}}=profissional
 *   recuperacao_falta(pt_PT)   body {{1}}=paciente {{2}}=profissional
 *                              quick reply:  [0] Remarcar
 *
 * Button payloads carry the agendamento id (`apt:confirmar:<id>`) —
 * the webhook routes template-button taps into the bot, which resolves
 * them without needing a session.
 *
 * A send failure throws; the CALLER decides what that means (the cron
 * claims before sending and logs loudly on failure — see the cron
 * route for why we don't retry automatically).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

const LANGUAGE = "pt_PT";

interface AccountSendContext {
  phoneNumberId: string;
  accessToken: string;
}

/** whatsapp_config por conta, cacheado por execução do cron. */
export async function loadSendContext(
  db: Db,
  accountId: string,
  cache: Map<string, AccountSendContext | null>,
): Promise<AccountSendContext | null> {
  if (cache.has(accountId)) return cache.get(accountId)!;

  const { data } = await db
    .from("whatsapp_config")
    .select("phone_number_id, access_token")
    .eq("account_id", accountId)
    .maybeSingle();

  const ctx = data
    ? { phoneNumberId: data.phone_number_id, accessToken: decrypt(data.access_token) }
    : null;
  cache.set(accountId, ctx);
  return ctx;
}

function quickReplyButtons(payloads: string[]) {
  return payloads.map((payload, index) => ({
    type: "button" as const,
    sub_type: "quick_reply" as const,
    index,
    parameters: [{ type: "payload" as const, payload }],
  }));
}

async function sendUtilityTemplate(args: {
  ctx: AccountSendContext;
  to: string;
  templateName: string;
  bodyParams: string[];
  buttonPayloads?: string[];
}): Promise<void> {
  const components: Record<string, unknown>[] = [
    {
      type: "body",
      parameters: args.bodyParams.map((text) => ({ type: "text", text })),
    },
    ...(args.buttonPayloads ? quickReplyButtons(args.buttonPayloads) : []),
  ];

  await sendTemplateMessage({
    phoneNumberId: args.ctx.phoneNumberId,
    accessToken: args.ctx.accessToken,
    to: args.to,
    templateName: args.templateName,
    language: LANGUAGE,
    components,
  });
}

export async function sendReminderTemplate(args: {
  ctx: AccountSendContext;
  to: string;
  paciente: string;
  profissional: string;
  quando: string;
  agendamentoId: string;
}): Promise<void> {
  await sendUtilityTemplate({
    ctx: args.ctx,
    to: args.to,
    templateName: "lembrete_consulta",
    bodyParams: [args.paciente, args.profissional, args.quando],
    buttonPayloads: [
      `apt:confirmar:${args.agendamentoId}`,
      `apt:reagendar:${args.agendamentoId}`,
    ],
  });
}

export async function sendFeedbackTemplate(args: {
  ctx: AccountSendContext;
  to: string;
  paciente: string;
  profissional: string;
}): Promise<void> {
  await sendUtilityTemplate({
    ctx: args.ctx,
    to: args.to,
    templateName: "feedback_consulta",
    bodyParams: [args.paciente, args.profissional],
  });
}

export async function sendNoShowTemplate(args: {
  ctx: AccountSendContext;
  to: string;
  paciente: string;
  profissional: string;
  agendamentoId: string;
}): Promise<void> {
  await sendUtilityTemplate({
    ctx: args.ctx,
    to: args.to,
    templateName: "recuperacao_falta",
    bodyParams: [args.paciente, args.profissional],
    buttonPayloads: [`apt:reagendar:${args.agendamentoId}`],
  });
}

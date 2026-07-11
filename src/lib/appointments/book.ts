import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyReception } from "./notify";

/**
 * Booking operations — create / cancel / reschedule appointments.
 *
 * The concurrency story lives in the DATABASE: migration 041's EXCLUDE
 * constraint rejects any overlap for the same professional, so two
 * patients racing for one slot is decided by whichever INSERT commits
 * first. This module's job is to translate that rejection (SQLSTATE
 * 23P01) into `slot_taken` so the bot can apologise and re-offer,
 * instead of surfacing a Postgres error to a patient on WhatsApp.
 *
 * Every state change fires the internal reception alert — fire-and-
 * forget, because a failed notification must never fail a booking.
 */

/** Postgres exclusion_violation — the anti-double-booking constraint. */
const EXCLUSION_VIOLATION = "23P01";

export interface BookingInput {
  accountId: string;
  contactId: string;
  profissionalId: string;
  especialidadeId: string | null;
  inicio: Date;
  fim: Date;
  origem: "bot" | "manual";
}

export type BookingResult =
  | { ok: true; agendamentoId: string }
  | { ok: false; reason: "slot_taken" | "error" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export async function createAppointment(
  db: Db,
  input: BookingInput,
): Promise<BookingResult> {
  const { data, error } = await db
    .from("agendamentos")
    .insert({
      account_id: input.accountId,
      contact_id: input.contactId,
      profissional_id: input.profissionalId,
      especialidade_id: input.especialidadeId,
      inicio: input.inicio.toISOString(),
      fim: input.fim.toISOString(),
      status: "pendente",
      origem: input.origem,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === EXCLUSION_VIOLATION) {
      // Someone else got the slot between "offered" and "confirmed".
      return { ok: false, reason: "slot_taken" };
    }
    console.error("[appointments/book] insert failed:", error.message);
    return { ok: false, reason: "error" };
  }

  void notifyReception(db, {
    accountId: input.accountId,
    agendamentoId: data.id,
    acao: "marcada",
  });

  return { ok: true, agendamentoId: data.id };
}

/**
 * Cancel — a status transition, never a DELETE (the clinical record
 * stays; the EXCLUDE constraint ignores 'cancelado', freeing the slot).
 */
export async function cancelAppointment(
  db: Db,
  accountId: string,
  agendamentoId: string,
): Promise<boolean> {
  const { error } = await db
    .from("agendamentos")
    .update({ status: "cancelado" })
    .eq("id", agendamentoId)
    .eq("account_id", accountId)
    // Terminal states stay terminal — cancelling a concluded visit
    // makes no sense and would corrupt the no-show/feedback crons.
    .in("status", ["pendente", "confirmado"]);

  if (error) {
    console.error("[appointments/book] cancel failed:", error.message);
    return false;
  }

  void notifyReception(db, { accountId, agendamentoId, acao: "cancelada" });
  return true;
}

/**
 * Reschedule = cancel + create, in that order, so the patient's own
 * old slot never blocks their new one (same professional, adjacent
 * time). NOT atomic across the two statements — the failure mode is a
 * cancelled appointment without a replacement, which the bot surfaces
 * immediately ("não consegui remarcar, escolha outro horário") and the
 * patient books again from a clean state. The inverse order would risk
 * double-holding two slots, which harms the clinic instead.
 */
export async function rescheduleAppointment(
  db: Db,
  accountId: string,
  agendamentoId: string,
  novoInicio: Date,
  novoFim: Date,
): Promise<BookingResult> {
  const { data: existing } = await db
    .from("agendamentos")
    .select("id, contact_id, profissional_id, especialidade_id, status")
    .eq("id", agendamentoId)
    .eq("account_id", accountId)
    .maybeSingle();

  if (!existing || !["pendente", "confirmado"].includes(existing.status)) {
    return { ok: false, reason: "error" };
  }

  const cancelled = await cancelAppointment(db, accountId, agendamentoId);
  if (!cancelled) return { ok: false, reason: "error" };

  const result = await createAppointment(db, {
    accountId,
    contactId: existing.contact_id,
    profissionalId: existing.profissional_id,
    especialidadeId: existing.especialidade_id,
    inicio: novoInicio,
    fim: novoFim,
    origem: "bot",
  });

  if (result.ok) {
    void notifyReception(db, {
      accountId,
      agendamentoId: result.agendamentoId,
      acao: "remarcada",
    });
  }

  return result;
}

/** Confirm (patient replied to the 24h reminder, or reception marked it). */
export async function confirmAppointment(
  db: Db,
  accountId: string,
  agendamentoId: string,
): Promise<boolean> {
  const { error } = await db
    .from("agendamentos")
    .update({ status: "confirmado" })
    .eq("id", agendamentoId)
    .eq("account_id", accountId)
    .eq("status", "pendente");

  if (error) {
    console.error("[appointments/book] confirm failed:", error.message);
    return false;
  }
  return true;
}

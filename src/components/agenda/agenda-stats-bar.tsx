"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarClock, CircleCheck, CircleDashed, CircleX, UserX } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { localDayRangeUtc } from "@/lib/appointments/format";

type Status = "pendente" | "confirmado" | "concluido" | "falta" | "cancelado";

/**
 * Today's appointment counts as a stats strip above the Agenda board —
 * the same "row of tiles above the board" layout Pipelines uses (Total
 * de negócios / Valor do funil / …), ported to counts instead of
 * money: appointments have no value field, so a 1:1 metric mapping
 * doesn't exist. Duplicates the day's status counts AppointmentKanban
 * already computes for its columns — a second lightweight query is a
 * fair trade for keeping the two components independent.
 */
export function AgendaStatsBar() {
  const t = useTranslations("Agenda.stats");
  const supabase = createClient();
  const { accountId, account } = useAuth();
  const timezone = account?.timezone ?? "Africa/Maputo";

  const [counts, setCounts] = useState<Record<Status, number> | null>(null);

  const fetchCounts = useCallback(async () => {
    if (!accountId) return;
    const { start, end } = localDayRangeUtc(new Date(), timezone);
    const { data } = await supabase
      .from("agendamentos")
      .select("status")
      .gte("inicio", start.toISOString())
      .lt("inicio", end.toISOString());

    const next: Record<Status, number> = {
      pendente: 0,
      confirmado: 0,
      concluido: 0,
      falta: 0,
      cancelado: 0,
    };
    for (const row of (data as { status: Status }[] | null) ?? []) {
      next[row.status] = (next[row.status] ?? 0) + 1;
    }
    setCounts(next);
  }, [supabase, accountId, timezone]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchCounts();
    }
  }, [accountId, fetchCounts]);

  const total = counts
    ? counts.pendente + counts.confirmado + counts.concluido + counts.falta + counts.cancelado
    : null;

  const tiles: { label: string; value: number | null; icon: typeof CalendarClock }[] = [
    { label: t("total"), value: total, icon: CalendarClock },
    { label: t("pendentes"), value: counts?.pendente ?? null, icon: CircleDashed },
    { label: t("confirmadas"), value: counts?.confirmado ?? null, icon: CircleCheck },
    { label: t("concluidas"), value: counts?.concluido ?? null, icon: CircleCheck },
    { label: t("faltas"), value: counts?.falta ?? null, icon: UserX },
    { label: t("canceladas"), value: counts?.cancelado ?? null, icon: CircleX },
  ];

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 rounded-xl border border-border bg-card/60 p-4 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            <tile.icon className="size-3.5 shrink-0" />
            {tile.label}
          </span>
          <span className="text-xl font-semibold text-foreground tabular-nums">
            {tile.value ?? "–"}
          </span>
        </div>
      ))}
    </div>
  );
}

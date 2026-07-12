"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { formatDayLabel, formatTimeLabel, weekDaysRangeUtc } from "@/lib/appointments/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Profissional {
  id: string;
  nome: string;
}

interface Row {
  id: string;
  inicio: string;
  fim: string;
  status: string;
  contacts: { name: string | null; phone: string } | null;
}

const STATUS_DOT: Record<string, string> = {
  pendente: "bg-amber-500",
  confirmado: "bg-blue-500",
  concluido: "bg-emerald-500",
  falta: "bg-red-500",
  cancelado: "bg-gray-400",
};

/**
 * Calendário semanal por profissional — vista de gestão de horários:
 * "quem tem o quê marcado esta semana". Navegação por semana; cada dia
 * mostra as consultas ordenadas por hora, coloridas por estado.
 *
 * Deliberadamente uma lista por dia, não uma grelha de horas com
 * posicionamento absoluto — consultas de duração variável (o
 * duracao_consulta_minutos é por profissional) tornariam essa grelha
 * frágil sem trazer clareza extra para o volume que uma clínica lida
 * num dia.
 */
export function WeeklyCalendar() {
  const t = useTranslations("Agenda.calendar");
  const supabase = createClient();
  const { accountId, account } = useAuth();
  const timezone = account?.timezone ?? "Africa/Maputo";

  const [profissionais, setProfissionais] = useState<Profissional[]>([]);
  const [selectedProf, setSelectedProf] = useState<string>("");
  const [weekRef, setWeekRef] = useState(() => new Date());
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!accountId) return;
    supabase
      .from("profissionais")
      .select("id, nome")
      .eq("ativo", true)
      .order("nome")
      .then(({ data }) => {
        const list = (data as Profissional[] | null) ?? [];
        setProfissionais(list);
        setSelectedProf((prev) => prev || list[0]?.id || "");
      });
  }, [supabase, accountId]);

  const days = useMemo(() => weekDaysRangeUtc(weekRef, timezone), [weekRef, timezone]);

  const fetchWeek = useCallback(async () => {
    if (!selectedProf || days.length === 0) return;
    setLoading(true);
    const { data } = await supabase
      .from("agendamentos")
      .select("id, inicio, fim, status, contacts(name, phone)")
      .eq("profissional_id", selectedProf)
      .neq("status", "cancelado")
      .gte("inicio", days[0].start.toISOString())
      .lt("inicio", days[6].end.toISOString())
      .order("inicio");
    setRows((data as unknown as Row[] | null) ?? []);
    setLoading(false);
  }, [supabase, selectedProf, days]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchWeek();
  }, [fetchWeek]);

  const rowsByDay = useMemo(() => {
    return days.map((d) =>
      rows.filter(
        (r) =>
          new Date(r.inicio).getTime() >= d.start.getTime() &&
          new Date(r.inicio).getTime() < d.end.getTime(),
      ),
    );
  }, [days, rows]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Select value={selectedProf} onValueChange={(v) => setSelectedProf(v ?? "")}>
          <SelectTrigger className="w-56 border-border bg-muted text-foreground">
            <SelectValue placeholder={t("pickProfessional")} />
          </SelectTrigger>
          <SelectContent>
            {profissionais.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.nome}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="border-border"
            onClick={() => setWeekRef((d) => new Date(d.getTime() - 7 * 86_400_000))}
            aria-label={t("previousWeek")}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-border text-muted-foreground"
            onClick={() => setWeekRef(new Date())}
          >
            {t("thisWeek")}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="border-border"
            onClick={() => setWeekRef((d) => new Date(d.getTime() + 7 * 86_400_000))}
            aria-label={t("nextWeek")}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {!selectedProf ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("noProfessionals")}</p>
      ) : loading ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("loading")}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
          {days.map((d, i) => {
            const dayRows = rowsByDay[i];
            const isToday =
              new Date().getTime() >= d.start.getTime() && new Date().getTime() < d.end.getTime();
            return (
              <div
                key={d.start.toISOString()}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border p-2",
                  isToday ? "border-primary/40 bg-primary/5" : "border-border",
                )}
              >
                <p className="text-xs font-semibold text-foreground">
                  {formatDayLabel(d.start, timezone)}
                </p>
                {dayRows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("noAppointments")}</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {dayRows.map((row) => (
                      <li
                        key={row.id}
                        className="rounded border border-border bg-card px-2 py-1.5 text-xs"
                      >
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              STATUS_DOT[row.status] ?? "bg-muted-foreground",
                            )}
                          />
                          <Clock className="size-3 shrink-0" />
                          {formatTimeLabel(new Date(row.inicio), timezone)}
                        </div>
                        <p className="mt-0.5 truncate text-foreground">
                          {row.contacts?.name ?? row.contacts?.phone ?? "—"}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

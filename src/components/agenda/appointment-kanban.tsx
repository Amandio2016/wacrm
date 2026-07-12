"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  closestCorners,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Clock, RefreshCw, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { formatTimeLabel, localDayRangeUtc } from "@/lib/appointments/format";
import { Button } from "@/components/ui/button";

type Status = "pendente" | "confirmado" | "concluido" | "falta" | "cancelado";

const STATUSES: { id: Status; color: string }[] = [
  { id: "pendente", color: "#f59e0b" },
  { id: "confirmado", color: "#3b82f6" },
  { id: "concluido", color: "#22c55e" },
  { id: "falta", color: "#ef4444" },
  { id: "cancelado", color: "#6b7280" },
];

interface RawRow {
  id: string;
  inicio: string;
  fim: string;
  status: Status;
  contact_id: string;
  profissional_id: string;
  especialidade_id: string | null;
}

interface Row extends RawRow {
  contactName: string | null;
  profissionalNome: string | null;
  especialidadeNome: string | null;
}

/**
 * Kanban do dia — cada coluna é um estado da consulta (fixo, não
 * configurável como em Pipelines); arrastar entre colunas grava o
 * novo status. A operadora usa isto para o dia-a-dia: marcar quem
 * confirmou, quem faltou, quem foi atendido.
 *
 * "Hoje" é o dia calendário na TIMEZONE DA CLÍNICA, não do browser do
 * agente — um agente a trabalhar de outro fuso vê o mesmo conjunto que
 * a receção física veria.
 *
 * Names (contact/professional/specialty) are resolved via SEPARATE flat
 * queries joined client-side by id, not a nested PostgREST embed. This
 * codebase has a documented history of embedded-FK lookups going stale
 * or ambiguous on the schema cache (see use-auth.tsx's account fetch);
 * for the one screen reception stares at all day, the extra round trip
 * is worth never showing a blank name.
 */
export function AppointmentKanban() {
  const t = useTranslations("Agenda.kanban");
  const supabase = createClient();
  const { accountId, account } = useAuth();
  const timezone = account?.timezone ?? "Africa/Maputo";

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);

  const fetchToday = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { start, end } = localDayRangeUtc(new Date(), timezone);
    const { data: raw } = await supabase
      .from("agendamentos")
      .select("id, inicio, fim, status, contact_id, profissional_id, especialidade_id")
      .gte("inicio", start.toISOString())
      .lt("inicio", end.toISOString())
      .order("inicio");

    const list = (raw as RawRow[] | null) ?? [];
    if (list.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    const contactIds = [...new Set(list.map((r) => r.contact_id))];
    const profIds = [...new Set(list.map((r) => r.profissional_id))];
    const espIds = [...new Set(list.map((r) => r.especialidade_id).filter((v): v is string => !!v))];

    const [{ data: contacts }, { data: profs }, { data: esps }] = await Promise.all([
      supabase.from("contacts").select("id, name, phone").in("id", contactIds),
      supabase.from("profissionais").select("id, nome").in("id", profIds),
      espIds.length
        ? supabase.from("especialidades").select("id, nome").in("id", espIds)
        : Promise.resolve({ data: [] as { id: string; nome: string }[] }),
    ]);

    const contactMap = new Map((contacts ?? []).map((c) => [c.id, c.name ?? c.phone]));
    const profMap = new Map((profs ?? []).map((p) => [p.id, p.nome]));
    const espMap = new Map((esps ?? []).map((e) => [e.id, e.nome]));

    setRows(
      list.map((r) => ({
        ...r,
        contactName: contactMap.get(r.contact_id) ?? null,
        profissionalNome: profMap.get(r.profissional_id) ?? null,
        especialidadeNome: r.especialidade_id ? (espMap.get(r.especialidade_id) ?? null) : null,
      })),
    );
    setLoading(false);
  }, [supabase, accountId, timezone]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchToday();
    }
  }, [accountId, fetchToday]);

  const byStatus = useMemo(() => {
    const map = new Map<Status, Row[]>();
    for (const s of STATUSES) map.set(s.id, []);
    for (const row of rows) map.get(row.status)?.push(row);
    return map;
  }, [rows]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const activeRow = activeId ? rows.find((r) => r.id === activeId) ?? null : null;

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const id = String(active.id);
    const newStatus = String(over.id) as Status;
    const row = rows.find((r) => r.id === id);
    if (!row || row.status === newStatus) return;
    if (!STATUSES.some((s) => s.id === newStatus)) return;

    const previous = row.status;
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status: newStatus } : r)));

    const { error } = await supabase
      .from("agendamentos")
      .update({ status: newStatus })
      .eq("id", id);

    if (error) {
      toast.error(t("toastMoveFailed"));
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status: previous } : r)));
    }
  };

  if (loading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t("loading")}</p>;
  }

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void fetchToday()}
          className="border-border text-muted-foreground"
        >
          <RefreshCw className="mr-2 size-3.5" />
          {t("refresh")}
        </Button>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        {/* snap-x/snap-mandatory + themed scrollbar mirrors the
            Pipelines board (pipeline-board.tsx) — one board pattern
            across the whole app, mobile swipe included. */}
        <div className="kanban-scroll flex snap-x snap-mandatory gap-3 overflow-x-auto pb-4 lg:snap-none">
          {STATUSES.map((s) => (
            <StatusColumn
              key={s.id}
              status={s.id}
              color={s.color}
              rows={byStatus.get(s.id) ?? []}
              timezone={timezone}
              label={t(`status.${s.id}`)}
              emptyLabel={t("dropHere")}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
          {activeRow ? (
            <div className="opacity-90">
              <AppointmentCard row={activeRow} timezone={timezone} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <style jsx>{`
        .kanban-scroll {
          scroll-behavior: smooth;
        }
        @media (hover: none), (pointer: coarse) {
          .kanban-scroll::-webkit-scrollbar {
            height: 0;
            display: none;
          }
          .kanban-scroll {
            scrollbar-width: none;
          }
        }
        @media (hover: hover) and (pointer: fine) {
          .kanban-scroll {
            scrollbar-width: thin;
            scrollbar-color: var(--border) transparent;
          }
          .kanban-scroll::-webkit-scrollbar {
            height: 8px;
          }
          .kanban-scroll::-webkit-scrollbar-track {
            background: transparent;
          }
          .kanban-scroll::-webkit-scrollbar-thumb {
            background-color: var(--border);
            border-radius: 9999px;
          }
          .kanban-scroll::-webkit-scrollbar-thumb:hover {
            background-color: var(--muted-foreground);
          }
        }
      `}</style>
    </div>
  );
}

function StatusColumn({
  status,
  color,
  rows,
  timezone,
  label,
  emptyLabel,
}: {
  status: Status;
  color: string;
  rows: Row[];
  timezone: string;
  label: string;
  emptyLabel: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div className="flex w-[85vw] min-w-[240px] max-w-[300px] shrink-0 snap-start flex-col rounded-xl border border-border bg-card/60 p-3 lg:w-auto lg:max-w-none lg:flex-1 lg:basis-[240px] lg:snap-none">
      <div className="-mx-3 -mt-3 h-[3px] rounded-t-xl" style={{ backgroundColor: color }} />
      <div className="flex items-center justify-between pt-3">
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {rows.length}
        </span>
      </div>

      <div
        ref={setNodeRef}
        className={`mt-3 flex min-h-[80px] flex-1 flex-col gap-2 rounded-lg transition-all ${
          isOver ? "bg-primary/5 outline outline-2 outline-dashed outline-primary outline-offset-2" : ""
        }`}
      >
        {rows.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border-2 border-dashed border-border py-6 text-xs text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          rows.map((row) => <DraggableCard key={row.id} row={row} timezone={timezone} />)
        )}
      </div>
    </div>
  );
}

function DraggableCard({ row, timezone }: { row: Row; timezone: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: row.id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} style={{ opacity: isDragging ? 0.3 : 1, touchAction: "none" }}>
      <AppointmentCard row={row} timezone={timezone} />
    </div>
  );
}

function AppointmentCard({ row, timezone }: { row: Row; timezone: string }) {
  return (
    <div className="cursor-grab rounded-lg border border-border bg-card p-2.5 active:cursor-grabbing">
      <p className="truncate text-sm font-medium text-foreground">{row.contactName ?? "—"}</p>
      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <Clock className="size-3 shrink-0" />
        {formatTimeLabel(new Date(row.inicio), timezone)}
      </p>
      {row.profissionalNome && (
        <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
          <User className="size-3 shrink-0" />
          {row.profissionalNome}
        </p>
      )}
      {row.especialidadeNome && (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{row.especialidadeNome}</p>
      )}
    </div>
  );
}

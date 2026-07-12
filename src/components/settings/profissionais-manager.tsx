"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChevronDown, Loader2, Plus, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Especialidade {
  id: string;
  nome: string;
}

interface Profissional {
  id: string;
  nome: string;
  especialidade_id: string | null;
  duracao_consulta_minutos: number;
  ativo: boolean;
}

interface Disponibilidade {
  id: string;
  dia_semana: number;
  hora_inicio: string;
  hora_fim: string;
}

const DIAS = [
  { value: 1, key: "seg" },
  { value: 2, key: "ter" },
  { value: 3, key: "qua" },
  { value: 4, key: "qui" },
  { value: 5, key: "sex" },
  { value: 6, key: "sab" },
  { value: 0, key: "dom" },
];

/**
 * Profissionais (médicos) + a sua disponibilidade semanal.
 *
 * A lista principal é o CRUD de médicos; expandir uma linha revela o
 * editor de horários — exatamente as linhas que o motor de slots
 * (lib/appointments/slots.ts) consome. Sem UI para
 * disponibilidade_excecoes (férias pontuais) nesta primeira versão —
 * fica para quando houver procura por isso; hoje é SQL direto.
 */
export function ProfissionaisManager() {
  const t = useTranslations("Settings.agenda.profissionais");
  const supabase = createClient();
  const { accountId } = useAuth();
  const canEdit = useCan("edit-settings");

  const [rows, setRows] = useState<Profissional[]>([]);
  const [especialidades, setEspecialidades] = useState<Especialidade[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [newNome, setNewNome] = useState("");
  const [newEspecialidade, setNewEspecialidade] = useState<string>("");
  const [newDuracao, setNewDuracao] = useState(30);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const [{ data: profs }, { data: esps }] = await Promise.all([
      supabase
        .from("profissionais")
        .select("id, nome, especialidade_id, duracao_consulta_minutos, ativo")
        .order("nome"),
      supabase.from("especialidades").select("id, nome").order("nome"),
    ]);
    setRows((profs as Profissional[] | null) ?? []);
    setEspecialidades((esps as Especialidade[] | null) ?? []);
    setLoading(false);
  }, [supabase, accountId]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchAll();
    }
  }, [accountId, fetchAll]);

  const handleCreate = async () => {
    const nome = newNome.trim();
    if (!nome) return;
    setCreating(true);
    const { error } = await supabase.from("profissionais").insert({
      account_id: accountId,
      nome,
      especialidade_id: newEspecialidade || null,
      duracao_consulta_minutos: newDuracao,
    });
    setCreating(false);
    if (error) {
      toast.error(t("toastCreateFailed"));
      return;
    }
    setNewNome("");
    setNewEspecialidade("");
    setNewDuracao(30);
    toast.success(t("toastCreated", { name: nome }));
    void fetchAll();
  };

  const toggleAtivo = async (row: Profissional) => {
    setBusyId(row.id);
    const { error } = await supabase
      .from("profissionais")
      .update({ ativo: !row.ativo })
      .eq("id", row.id);
    setBusyId(null);
    if (error) {
      toast.error(t("toastUpdateFailed"));
      return;
    }
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, ativo: !r.ativo } : r)),
    );
  };

  const handleDelete = async (row: Profissional) => {
    if (!confirm(t("deleteConfirm", { name: row.nome }))) return;
    setBusyId(row.id);
    const { error } = await supabase
      .from("profissionais")
      .delete()
      .eq("id", row.id);
    setBusyId(null);
    if (error) {
      // ON DELETE RESTRICT on agendamentos.profissional_id — a doctor
      // with appointment history can't be hard-deleted. Deactivate instead.
      toast.error(t("toastDeleteBlocked"));
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
  };

  return (
    <div className="flex flex-col gap-3">
      {canEdit && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Label className="text-xs text-muted-foreground">{t("nameLabel")}</Label>
            <Input
              value={newNome}
              onChange={(e) => setNewNome(e.target.value)}
              placeholder={t("namePlaceholder")}
              className="border-border bg-muted text-foreground"
            />
          </div>
          <div className="sm:w-48">
            <Label className="text-xs text-muted-foreground">{t("especialidadeLabel")}</Label>
            <Select value={newEspecialidade} onValueChange={(v) => setNewEspecialidade(v ?? "")}>
              <SelectTrigger className="border-border bg-muted text-foreground">
                <SelectValue placeholder={t("especialidadeNone")} />
              </SelectTrigger>
              <SelectContent>
                {especialidades.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:w-32">
            <Label className="text-xs text-muted-foreground">{t("durationLabel")}</Label>
            <Input
              type="number"
              min={5}
              max={240}
              value={newDuracao}
              onChange={(e) => setNewDuracao(Number(e.target.value) || 30)}
              className="border-border bg-muted text-foreground"
            />
          </div>
          <Button
            onClick={handleCreate}
            disabled={creating || !newNome.trim()}
            className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {t("add")}
          </Button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-lg border border-border">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  className="flex flex-1 items-center gap-2 text-left"
                >
                  <ChevronDown
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      expandedId === row.id && "rotate-180",
                    )}
                  />
                  <span
                    className={
                      row.ativo
                        ? "text-sm text-foreground"
                        : "text-sm text-muted-foreground line-through"
                    }
                  >
                    {row.nome}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {especialidades.find((e) => e.id === row.especialidade_id)?.nome ?? t("noSpecialty")}
                    {" · "}
                    {t("minutesShort", { n: row.duracao_consulta_minutos })}
                  </span>
                </button>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={row.ativo}
                      disabled={busyId === row.id}
                      onCheckedChange={() => toggleAtivo(row)}
                      aria-label={t("toggleAria", { name: row.nome })}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={busyId === row.id}
                      onClick={() => handleDelete(row)}
                      aria-label={t("deleteAria", { name: row.nome })}
                      className="text-muted-foreground hover:text-red-400"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                )}
              </div>
              {expandedId === row.id && (
                <div className="border-t border-border p-3">
                  <DisponibilidadeEditor
                    profissional={row}
                    canEdit={canEdit}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DisponibilidadeEditor({
  profissional,
  canEdit,
}: {
  profissional: Profissional;
  canEdit: boolean;
}) {
  const t = useTranslations("Settings.agenda.disponibilidade");
  const supabase = createClient();
  const { accountId } = useAuth();

  const [rows, setRows] = useState<Disponibilidade[]>([]);
  const [loading, setLoading] = useState(true);
  const [dia, setDia] = useState(1);
  const [inicio, setInicio] = useState("08:00");
  const [fim, setFim] = useState("12:00");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("disponibilidade")
      .select("id, dia_semana, hora_inicio, hora_fim")
      .eq("profissional_id", profissional.id)
      .order("dia_semana");
    setRows((data as Disponibilidade[] | null) ?? []);
    setLoading(false);
  }, [supabase, profissional.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchRows();
  }, [fetchRows]);

  const handleAdd = async () => {
    if (fim <= inicio) {
      toast.error(t("toastInvalidRange"));
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("disponibilidade").insert({
      account_id: accountId,
      profissional_id: profissional.id,
      dia_semana: dia,
      hora_inicio: inicio,
      hora_fim: fim,
    });
    setSaving(false);
    if (error) {
      toast.error(t("toastCreateFailed"));
      return;
    }
    void fetchRows();
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    const { error } = await supabase.from("disponibilidade").delete().eq("id", id);
    setBusyId(null);
    if (error) {
      toast.error(t("toastDeleteFailed"));
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const diaLabel = (n: number) => t(`dias.${DIAS.find((d) => d.value === n)?.key ?? "seg"}`);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-medium text-muted-foreground">{t("title")}</p>

      {loading ? (
        <p className="text-xs text-muted-foreground">{t("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between rounded border border-border px-2 py-1 text-sm"
            >
              <span className="text-foreground">
                {diaLabel(r.dia_semana)} · {r.hora_inicio.slice(0, 5)}–{r.hora_fim.slice(0, 5)}
              </span>
              {canEdit && (
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busyId === r.id}
                  onClick={() => handleDelete(r.id)}
                  className="size-6 text-muted-foreground hover:text-red-400"
                >
                  <Trash2 className="size-3" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs text-muted-foreground">{t("dayLabel")}</Label>
            <Select value={String(dia)} onValueChange={(v) => setDia(Number(v))}>
              <SelectTrigger className="w-28 border-border bg-muted text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIAS.map((d) => (
                  <SelectItem key={d.value} value={String(d.value)}>
                    {t(`dias.${d.key}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("fromLabel")}</Label>
            <Input
              type="time"
              value={inicio}
              onChange={(e) => setInicio(e.target.value)}
              className="w-28 border-border bg-muted text-foreground"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("toLabel")}</Label>
            <Input
              type="time"
              value={fim}
              onChange={(e) => setFim(e.target.value)}
              className="w-28 border-border bg-muted text-foreground"
            />
          </div>
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={saving}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-4" />
            {t("addWindow")}
          </Button>
        </div>
      )}
    </div>
  );
}

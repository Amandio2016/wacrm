"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface Especialidade {
  id: string;
  nome: string;
  ativo: boolean;
}

/**
 * Especialidades catalogue — the first step of the booking bot's
 * dialogue (Fase 3: stepEspecialidade). Same shape as
 * CustomFieldsPanel: flat list, inline add, toggle active, delete.
 * `ativo=false` hides a specialty from the bot without losing history
 * on appointments that already reference it (FK is ON DELETE SET NULL,
 * so deleting is safe too, just less reversible).
 */
export function EspecialidadesManager() {
  const t = useTranslations("Settings.agenda.especialidades");
  const supabase = createClient();
  const { accountId } = useAuth();
  const canEdit = useCan("edit-settings");

  const [rows, setRows] = useState<Especialidade[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const { data } = await supabase
      .from("especialidades")
      .select("id, nome, ativo")
      .order("nome");
    setRows((data as Especialidade[] | null) ?? []);
    setLoading(false);
  }, [supabase, accountId]);

  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchRows();
    }
  }, [accountId, fetchRows]);

  const handleCreate = async () => {
    const nome = newName.trim();
    if (!nome) return;
    if (rows.some((r) => r.nome.toLowerCase() === nome.toLowerCase())) {
      toast.error(t("toastDuplicate", { name: nome }));
      return;
    }
    setCreating(true);
    const { error } = await supabase
      .from("especialidades")
      .insert({ account_id: accountId, nome });
    setCreating(false);
    if (error) {
      toast.error(t("toastCreateFailed"));
      return;
    }
    setNewName("");
    toast.success(t("toastCreated", { name: nome }));
    void fetchRows();
  };

  const toggleAtivo = async (row: Especialidade) => {
    setBusyId(row.id);
    const { error } = await supabase
      .from("especialidades")
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

  const handleDelete = async (row: Especialidade) => {
    setBusyId(row.id);
    const { error } = await supabase
      .from("especialidades")
      .delete()
      .eq("id", row.id);
    setBusyId(null);
    if (error) {
      toast.error(t("toastDeleteFailed"));
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    toast.success(t("toastDeleted", { name: row.nome }));
  };

  return (
    <div className="flex flex-col gap-3">
      {canEdit && (
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder={t("placeholder")}
            className="border-border bg-muted text-foreground"
          />
          <Button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
          </Button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
            >
              <span
                className={
                  row.ativo ? "text-sm text-foreground" : "text-sm text-muted-foreground line-through"
                }
              >
                {row.nome}
              </span>
              <div className="flex items-center gap-2">
                {canEdit && (
                  <>
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
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

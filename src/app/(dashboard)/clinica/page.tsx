"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { MapPin, Clock, Phone, Stethoscope, UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { BrandMark } from "@/components/layout/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface Especialidade {
  id: string;
  nome: string;
}

interface Profissional {
  id: string;
  nome: string;
  especialidade_id: string | null;
}

/**
 * "Sobre a Clínica" — institutional page for the clinic as a whole:
 * address, hours, description, contact, specialties on offer, and the
 * team. Read-only for everyone; the core fields (morada, horário,
 * descrição) are admin-editable inline, same pattern as
 * BrandingSettings. Specialty/professional MANAGEMENT stays in
 * Settings → Agenda — this page only lists what's already there, it
 * doesn't duplicate the CRUD.
 */
export default function ClinicaPage() {
  const t = useTranslations("Clinica");
  const supabase = createClient();
  const { accountId, account, refreshProfile } = useAuth();
  const canEdit = useCan("edit-settings");

  const [morada, setMorada] = useState("");
  const [horario, setHorario] = useState("");
  const [descricao, setDescricao] = useState("");
  const [saving, setSaving] = useState(false);

  const [especialidades, setEspecialidades] = useState<Especialidade[]>([]);
  const [profissionais, setProfissionais] = useState<Profissional[]>([]);
  const [loadingLists, setLoadingLists] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMorada(account?.morada ?? "");
    setHorario(account?.horario_funcionamento ?? "");
    setDescricao(account?.descricao ?? "");
  }, [account]);

  useEffect(() => {
    if (!accountId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingLists(true);
    Promise.all([
      supabase
        .from("especialidades")
        .select("id, nome")
        .eq("ativo", true)
        .order("nome"),
      supabase
        .from("profissionais")
        .select("id, nome, especialidade_id")
        .eq("ativo", true)
        .order("nome"),
    ]).then(([esps, profs]) => {
      setEspecialidades((esps.data as Especialidade[] | null) ?? []);
      setProfissionais((profs.data as Profissional[] | null) ?? []);
      setLoadingLists(false);
    });
  }, [supabase, accountId]);

  const handleSave = async () => {
    if (!account?.id) return;
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({
        morada: morada.trim() || null,
        horario_funcionamento: horario.trim() || null,
        descricao: descricao.trim() || null,
      })
      .eq("id", account.id);
    setSaving(false);

    if (error) {
      toast.error(t("saveFailed", { message: error.message }));
      return;
    }
    await refreshProfile();
    toast.success(t("saved"));
  };

  const especialidadeNome = (id: string | null) =>
    especialidades.find((e) => e.id === id)?.nome ?? null;

  return (
    <div>
      <div className="flex items-center gap-3">
        <BrandMark fallbackName={t("pageTitle")} iconOnly />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {account?.brand_name || account?.name || t("pageTitle")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("pageDesc")}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="border-border bg-card lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-foreground">{t("infoTitle")}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t("infoDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!canEdit && !morada && !horario && !descricao && (
              <p className="text-sm text-muted-foreground">{t("emptyReadOnly")}</p>
            )}

            <div className="flex flex-col gap-2">
              <Label className="flex items-center gap-1.5 text-muted-foreground">
                <MapPin className="size-3.5" />
                {t("addressLabel")}
              </Label>
              {canEdit ? (
                <Input
                  value={morada}
                  onChange={(e) => setMorada(e.target.value)}
                  placeholder={t("addressPlaceholder")}
                  disabled={saving}
                  className="border-border bg-muted text-foreground"
                />
              ) : (
                <p className="text-sm text-foreground">{morada || t("notSet")}</p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="size-3.5" />
                {t("hoursLabel")}
              </Label>
              {canEdit ? (
                <Input
                  value={horario}
                  onChange={(e) => setHorario(e.target.value)}
                  placeholder={t("hoursPlaceholder")}
                  disabled={saving}
                  className="border-border bg-muted text-foreground"
                />
              ) : (
                <p className="text-sm text-foreground">{horario || t("notSet")}</p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label className="flex items-center gap-1.5 text-muted-foreground">
                <Phone className="size-3.5" />
                {t("contactLabel")}
              </Label>
              <p className="text-sm text-foreground">
                {account?.name ? account.name : null}
                {" — "}
                {t("contactHint")}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground">{t("descriptionLabel")}</Label>
              {canEdit ? (
                <Textarea
                  value={descricao}
                  onChange={(e) => setDescricao(e.target.value)}
                  placeholder={t("descriptionPlaceholder")}
                  disabled={saving}
                  className="min-h-24 border-border bg-muted text-foreground"
                />
              ) : (
                <p className="text-sm text-foreground">{descricao || t("notSet")}</p>
              )}
            </div>

            {canEdit && (
              <div>
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {saving ? t("saving") : t("save")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Stethoscope className="size-4 text-primary" />
              {t("specialtiesTitle")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t("specialtiesDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingLists ? (
              <p className="text-sm text-muted-foreground">{t("loading")}</p>
            ) : especialidades.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noSpecialties")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {especialidades.map((e) => (
                  <span
                    key={e.id}
                    className="rounded-full bg-primary/10 px-3 py-1 text-sm text-primary"
                  >
                    {e.nome}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <UserRound className="size-4 text-primary" />
              {t("teamTitle")}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t("teamDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingLists ? (
              <p className="text-sm text-muted-foreground">{t("loading")}</p>
            ) : profissionais.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noTeam")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {profissionais.map((p) => (
                  <li key={p.id} className="flex items-center justify-between text-sm">
                    <span className="text-foreground">{p.nome}</span>
                    {especialidadeNome(p.especialidade_id) && (
                      <span className="text-xs text-muted-foreground">
                        {especialidadeNome(p.especialidade_id)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

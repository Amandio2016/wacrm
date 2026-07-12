"use client";

import { useTranslations } from "next-intl";
import { Stethoscope, UserRound } from "lucide-react";
import { SettingsPanelHead } from "./settings-panel-head";
import { EspecialidadesManager } from "./especialidades-manager";
import { ProfissionaisManager } from "./profissionais-manager";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * "Agenda" settings section: the clinic's booking configuration — the
 * catalogue the WhatsApp bot (lib/appointments/bot.ts) reads at every
 * step. Two cards, both readable by any member, writes admin-gated by
 * each sub-component (mirrors Fields & Tags).
 */
export function AgendaSettings() {
  const t = useTranslations("Settings.agenda");

  return (
    <section className="max-w-3xl animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead title={t("title")} description={t("description")} />

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Stethoscope className="size-4 text-primary" />
            {t("especialidades.title")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("especialidades.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EspecialidadesManager />
        </CardContent>
      </Card>

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <UserRound className="size-4 text-primary" />
            {t("profissionais.title")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("profissionais.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProfissionaisManager />
        </CardContent>
      </Card>
    </section>
  );
}

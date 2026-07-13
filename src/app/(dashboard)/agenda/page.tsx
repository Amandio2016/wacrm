"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppointmentKanban } from "@/components/agenda/appointment-kanban";
import { WeeklyCalendar } from "@/components/agenda/weekly-calendar";
import { AgendaStatsBar } from "@/components/agenda/agenda-stats-bar";

/**
 * Agenda page — the clinic's day-to-day appointment operations,
 * fed by the same tables the WhatsApp booking bot writes to
 * (lib/appointments/*). Two views:
 *   - Hoje: Kanban by status, for reception's live triage.
 *   - Semana: per-professional weekly list, for schedule overview.
 */
export default function AgendaPage() {
  const t = useTranslations("Agenda");

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t("pageTitle")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("pageDesc")}</p>
      </div>

      <div className="mt-6">
        <AgendaStatsBar />
      </div>

      <Tabs defaultValue="hoje">
        <TabsList>
          <TabsTrigger value="hoje">{t("tabToday")}</TabsTrigger>
          <TabsTrigger value="semana">{t("tabWeek")}</TabsTrigger>
        </TabsList>
        <TabsContent value="hoje" className="mt-4">
          <AppointmentKanban />
        </TabsContent>
        <TabsContent value="semana" className="mt-4">
          <WeeklyCalendar />
        </TabsContent>
      </Tabs>
    </div>
  );
}

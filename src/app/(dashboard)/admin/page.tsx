"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface AdminPayment {
  id: string;
  account_id: string;
  amount: number;
  currency: string;
  method: string;
  reference: string | null;
  period_months: number;
  status: string;
  notes: string | null;
  created_at: string;
  accounts: { name: string } | null;
  plans: { name: string; code: string } | null;
}

/**
 * The platform operator's reconciliation queue.
 *
 * This is YOUR screen, not a customer's: it lists every payment claim
 * across every account so you can check a reference against the M-Pesa
 * statement and confirm it. Confirming is what extends a subscription.
 *
 * Authorisation is enforced in the database (`confirm_payment()` raises
 * unless is_platform_admin()); the `isPlatformAdmin` flag we read here
 * only decides whether to render the queue or the "not for you" notice.
 * A non-admin who forced their way onto this route would see nothing
 * but their own account's rows and every action would fail.
 */
export default function AdminPage() {
  const t = useTranslations("Admin");
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"pending" | "all">("pending");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/payments?status=${filter}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setPayments(data.payments ?? []);
      setIsPlatformAdmin(Boolean(data.isPlatformAdmin));
    } catch {
      toast.error(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [filter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: "confirm" | "reject") => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/payments/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed");

      toast.success(action === "confirm" ? t("confirmed") : t("rejected"));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("actionFailed"));
    } finally {
      setBusyId(null);
    }
  };

  if (!loading && !isPlatformAdmin) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <ShieldAlert className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            {t("notAdminTitle")}
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("notAdminDesc")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>

        <div className="flex gap-1 rounded-lg border border-border p-1">
          {(["pending", "all"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition",
                filter === f
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`filter.${f}`)}
            </button>
          ))}
        </div>
      </div>

      <Card className="mt-6 border-border bg-card">
        <CardHeader>
          <CardTitle className="text-foreground">{t("queueTitle")}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("queueDesc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("loading")}
            </p>
          ) : payments.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("empty")}
            </p>
          ) : (
            payments.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {p.accounts?.name ?? t("unknownAccount")}
                    <span className="font-normal text-muted-foreground">
                      {" — "}
                      {p.plans?.name ?? t("unknownPlan")}
                      {" · "}
                      {t("months", { n: p.period_months })}
                    </span>
                  </p>
                  <p className="mt-0.5 text-sm text-foreground">
                    {formatCurrency(Number(p.amount), p.currency)}
                    <span className="text-muted-foreground">
                      {" · "}
                      {t(`method.${p.method}`)}
                      {p.reference ? (
                        <>
                          {" · "}
                          <span className="font-mono">{p.reference}</span>
                        </>
                      ) : (
                        ` · ${t("noReference")}`
                      )}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(p.created_at).toLocaleString()}
                  </p>
                </div>

                {p.status === "pending" ? (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={busyId === p.id}
                      onClick={() => act(p.id, "confirm")}
                      className="bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      {t("confirm")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === p.id}
                      onClick={() => act(p.id, "reject")}
                      className="border-border text-muted-foreground"
                    >
                      {t("reject")}
                    </Button>
                  </div>
                ) : (
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-medium",
                      p.status === "confirmed"
                        ? "bg-emerald-500/10 text-emerald-500"
                        : "bg-red-500/10 text-red-500",
                    )}
                  >
                    {t(`payStatus.${p.status}`)}
                  </span>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

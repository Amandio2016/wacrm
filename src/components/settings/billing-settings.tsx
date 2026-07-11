"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, Clock, CircleAlert, CircleCheck } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import type {
  Entitlement,
  Payment,
  PaymentMethod,
  Plan,
} from "@/lib/billing/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PayPlanDialog } from "@/components/settings/pay-plan-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const METHODS: PaymentMethod[] = [
  "mpesa",
  "emola",
  "bank_transfer",
  "cash",
  "other",
];

/**
 * The customer's subscription screen.
 *
 * Payment is out-of-band: there is no card rail available to a
 * Mozambican merchant, so the customer transfers via M-Pesa / e-Mola
 * and then files a claim here with the transaction reference. Nothing
 * on this screen grants access — it records an intent to pay, which
 * the platform operator confirms from /admin.
 */
export function BillingSettings() {
  const t = useTranslations("Settings.billing");
  const { canEditSettings } = useAuth();

  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("mpesa");
  const [reference, setReference] = useState("");
  const [months, setMonths] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [payDialogPlan, setPayDialogPlan] = useState<Plan | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/billing");
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setEntitlement(data.entitlement);
      setPlans(data.plans ?? []);
      setPayments(data.payments ?? []);
    } catch {
      toast.error(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitPayment = async () => {
    if (!selectedPlan) {
      toast.error(t("pickPlanFirst"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/billing/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_id: selectedPlan,
          method,
          reference,
          period_months: months,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed");

      toast.success(t("paymentSubmitted"));
      setReference("");
      await load();
    } catch (err) {
      toast.error(
        err instanceof Error && err.message !== "failed"
          ? err.message
          : t("paymentFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Card className="border-border bg-card">
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {t("loading")}
        </CardContent>
      </Card>
    );
  }

  const active = entitlement?.active ?? false;
  const days = entitlement?.daysRemaining ?? null;

  return (
    <div className="flex flex-col gap-6">
      {/* ---- Current status ---- */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-foreground">{t("title")}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            className={cn(
              "flex items-start gap-3 rounded-lg border px-4 py-3",
              active
                ? "border-emerald-500/20 bg-emerald-500/10"
                : "border-red-500/20 bg-red-500/10",
            )}
          >
            {active ? (
              <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
            ) : (
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {t(`status.${entitlement?.status ?? "canceled"}`)}
                {entitlement?.plan ? ` — ${entitlement.plan.name}` : ""}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {active && days !== null
                  ? t("daysRemaining", { days })
                  : t("blockedHint")}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---- Plans ---- */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-foreground">{t("plansTitle")}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("plansDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          {plans.map((plan) => {
            const isCurrent = entitlement?.plan?.id === plan.id;
            const isSelected = selectedPlan === plan.id;
            return (
              <div
                key={plan.id}
                role="button"
                tabIndex={canEditSettings ? 0 : -1}
                onClick={() => canEditSettings && setSelectedPlan(plan.id)}
                onKeyDown={(e) => {
                  if (canEditSettings && (e.key === "Enter" || e.key === " ")) {
                    setSelectedPlan(plan.id);
                  }
                }}
                className={cn(
                  "flex cursor-pointer flex-col gap-2 rounded-xl border p-4 text-left transition",
                  isSelected
                    ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                    : "border-border bg-muted/40 hover:border-primary/40",
                  !canEditSettings && "cursor-not-allowed opacity-60",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {plan.name}
                  </span>
                  {isCurrent && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                      {t("currentPlan")}
                    </span>
                  )}
                </div>

                <p className="text-lg font-bold text-foreground">
                  {formatCurrency(plan.price, plan.currency)}
                  <span className="text-xs font-normal text-muted-foreground">
                    {" "}
                    / {t(`interval.${plan.interval}`)}
                  </span>
                </p>

                {plan.description && (
                  <p className="text-xs text-muted-foreground">
                    {plan.description}
                  </p>
                )}

                <ul className="mt-1 flex flex-col gap-1">
                  <LimitRow
                    label={t("limitMembers", {
                      n: plan.limits.max_members ?? 0,
                    })}
                    unlimited={plan.limits.max_members === null}
                    unlimitedLabel={t("limitMembersUnlimited")}
                  />
                  <LimitRow
                    label={t("limitContacts", {
                      n: plan.limits.max_contacts ?? 0,
                    })}
                    unlimited={plan.limits.max_contacts === null}
                    unlimitedLabel={t("limitContactsUnlimited")}
                  />
                  <LimitRow
                    label={t("limitBroadcasts", {
                      n: plan.limits.max_broadcasts_per_month ?? 0,
                    })}
                    unlimited={plan.limits.max_broadcasts_per_month === null}
                    unlimitedLabel={t("limitBroadcastsUnlimited")}
                  />
                  {plan.limits.ai_enabled && (
                    <li className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Check className="h-3 w-3 text-primary" />
                      {t("limitAi")}
                    </li>
                  )}
                </ul>

                {canEditSettings && (
                  <Button
                    size="sm"
                    onClick={(e) => {
                      // Don't also toggle the card selection underneath.
                      e.stopPropagation();
                      setPayDialogPlan(plan);
                    }}
                    className="mt-2 bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    {t("payNow")}
                  </Button>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <PayPlanDialog
        // Keyed per plan so each open is a fresh mount: phase, phone and
        // error state from a previous attempt can never leak into a new one.
        key={payDialogPlan?.id ?? "closed"}
        plan={payDialogPlan}
        open={payDialogPlan !== null}
        onOpenChange={(next) => {
          if (!next) setPayDialogPlan(null);
        }}
        onCompleted={() => void load()}
      />

      {/* ---- Declare a payment ---- */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-foreground">{t("payTitle")}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("payDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!canEditSettings ? (
            <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              {t("adminOnly")}
            </p>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-2">
                  <Label className="text-muted-foreground">
                    {t("methodLabel")}
                  </Label>
                  <select
                    value={method}
                    onChange={(e) =>
                      setMethod(e.target.value as PaymentMethod)
                    }
                    className="h-9 rounded-md border border-border bg-muted px-3 text-sm text-foreground"
                  >
                    {METHODS.map((m) => (
                      <option key={m} value={m}>
                        {t(`method.${m}`)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="months" className="text-muted-foreground">
                    {t("monthsLabel")}
                  </Label>
                  <Input
                    id="months"
                    type="number"
                    min={1}
                    max={36}
                    value={months}
                    onChange={(e) =>
                      setMonths(Math.max(1, Number(e.target.value) || 1))
                    }
                    className="border-border bg-muted text-foreground"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="reference" className="text-muted-foreground">
                    {t("referenceLabel")}
                  </Label>
                  <Input
                    id="reference"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder={t("referencePlaceholder")}
                    className="border-border bg-muted text-foreground"
                  />
                </div>
              </div>

              <p className="text-xs text-muted-foreground">{t("payHint")}</p>

              <div>
                <Button
                  onClick={submitPayment}
                  disabled={submitting || !selectedPlan}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {submitting ? t("submitting") : t("submitPayment")}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ---- History ---- */}
      {payments.length > 0 && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-foreground">
              {t("historyTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {payments.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-4 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm text-foreground">
                    {formatCurrency(Number(p.amount), p.currency)}
                    <span className="text-muted-foreground">
                      {" · "}
                      {t(`method.${p.method}`)}
                      {p.reference ? ` · ${p.reference}` : ""}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(p.created_at).toLocaleDateString()}
                  </p>
                </div>
                <PaymentBadge status={p.status} label={t(`payStatus.${p.status}`)} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function LimitRow({
  label,
  unlimited,
  unlimitedLabel,
}: {
  label: string;
  unlimited: boolean;
  unlimitedLabel: string;
}) {
  return (
    <li className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Check className="h-3 w-3 shrink-0 text-primary" />
      {unlimited ? unlimitedLabel : label}
    </li>
  );
}

function PaymentBadge({ status, label }: { status: string; label: string }) {
  const styles: Record<string, string> = {
    pending: "bg-amber-500/10 text-amber-500",
    confirmed: "bg-emerald-500/10 text-emerald-500",
    rejected: "bg-red-500/10 text-red-500",
  };
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium",
        styles[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {status === "pending" && <Clock className="h-3 w-3" />}
      {label}
    </span>
  );
}

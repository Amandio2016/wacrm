"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  CircleCheck,
  CircleAlert,
  CreditCard,
  Loader2,
  Smartphone,
} from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import type { Plan } from "@/lib/billing/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Methods offered in the popup, in display order. */
const METHODS = ["mpesa", "emola", "mkesh", "visa_mastercard"] as const;
type PopupMethod = (typeof METHODS)[number];

type Phase =
  | "form" //     choosing method / typing phone
  | "charging" // request in flight — M-Pesa blocks on the customer's PIN
  | "polling" //  e-Mola/mKesh push sent; waiting for the webhook
  | "success"
  | "failed";

/** How long the e-Mola/mKesh poll keeps trying before giving up. */
const POLL_INTERVAL_MS = 3_000;
const POLL_DEADLINE_MS = 3 * 60_000;

interface PayPlanDialogProps {
  plan: Plan | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a confirmed payment so the parent reloads entitlement. */
  onCompleted: () => void;
}

/**
 * The in-app payment popup. Clicking "Pay" on a plan opens this; the
 * customer picks a method, types their wallet number, and confirms the
 * PIN push on their phone. Everything money-related is decided server-
 * side: this component sends plan + method + phone + months and renders
 * whatever comes back — it never computes or submits an amount.
 */
export function PayPlanDialog({
  plan,
  open,
  onOpenChange,
  onCompleted,
}: PayPlanDialogProps) {
  const t = useTranslations("Settings.billing.popup");

  const [method, setMethod] = useState<PopupMethod>("mpesa");
  const [phone, setPhone] = useState("");
  const [months, setMonths] = useState(1);
  const [phase, setPhase] = useState<Phase>("form");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollAbort = useRef<{ stop: boolean }>({ stop: false });

  // State freshness across opens is handled by the PARENT keying this
  // component per plan/open cycle (see billing-settings.tsx) — a new
  // mount starts at "form" with clean fields. Here we only make sure an
  // in-flight poll dies with the dialog.
  useEffect(() => {
    const flag = pollAbort.current;
    return () => {
      flag.stop = true;
    };
  }, []);

  if (!plan) return null;

  const total = Number(plan.price) * months;
  const needsPhone = method !== "visa_mastercard";

  const pollUntilSettled = async (paymentId: string) => {
    const flag = pollAbort.current;
    const deadline = Date.now() + POLL_DEADLINE_MS;

    while (!flag.stop && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const res = await fetch("/api/billing");
        if (!res.ok) continue;
        const data = await res.json();
        const row = (data.payments ?? []).find(
          (p: { id: string }) => p.id === paymentId,
        );
        if (row?.status === "confirmed") {
          setPhase("success");
          onCompleted();
          return;
        }
        if (row?.status === "rejected") {
          setErrorMsg(t("pushRejected"));
          setPhase("failed");
          return;
        }
      } catch {
        // transient — keep polling until the deadline
      }
    }

    if (!flag.stop) {
      setErrorMsg(t("pollTimeout"));
      setPhase("failed");
    }
  };

  const charge = async () => {
    setErrorMsg(null);
    setPhase("charging");

    let res: Response;
    let data: {
      payment?: { id: string; status: string };
      provider?: { status: string; checkout_url?: string; error?: string };
      warning?: string;
      error?: string;
      code?: string;
    };
    try {
      res = await fetch("/api/billing/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_id: plan.id,
          method,
          phone: needsPhone ? phone : undefined,
          period_months: months,
          pay_now: true,
        }),
      });
      data = await res.json();
    } catch {
      setErrorMsg(t("networkError"));
      setPhase("failed");
      return;
    }

    if (!res.ok) {
      setErrorMsg(
        data.code === "invalid_phone"
          ? t("invalidPhone")
          : (data.provider?.error ?? data.error ?? t("chargeFailed")),
      );
      setPhase("failed");
      return;
    }

    // Card: the provider hosts the checkout — hand the browser over.
    // The webhook confirms in the background; when the customer lands
    // back on ?tab=billing the panel re-fetches and shows the result.
    if (data.provider?.checkout_url) {
      window.location.href = data.provider.checkout_url;
      return;
    }

    if (data.provider?.status === "success") {
      setPhase("success");
      onCompleted();
      return;
    }

    // e-Mola / mKesh: push delivered, webhook pending.
    if (data.payment?.id) {
      setPhase("polling");
      void pollUntilSettled(data.payment.id);
      return;
    }

    setErrorMsg(t("chargeFailed"));
    setPhase("failed");
  };

  const busy = phase === "charging" || phase === "polling";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't let a stray overlay-click abandon an in-flight charge —
        // the customer is mid-PIN on their phone.
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-md">
        {phase === "success" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <CircleCheck className="size-5 text-emerald-500" />
                {t("successTitle")}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t("successDesc", { plan: plan.name })}
              </DialogDescription>
            </DialogHeader>
            <Button
              onClick={() => onOpenChange(false)}
              className="mt-2 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {t("done")}
            </Button>
          </>
        ) : phase === "charging" || phase === "polling" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <Loader2 className="size-5 animate-spin text-primary" />
                {t("waitingTitle")}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t("waitingDesc", { phone })}
              </DialogDescription>
            </DialogHeader>
            <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              {t("waitingHint")}
            </p>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t("title", { plan: plan.name })}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t("description")}
              </DialogDescription>
            </DialogHeader>

            {(phase === "failed" || errorMsg) && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                {errorMsg ?? t("chargeFailed")}
              </div>
            )}

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label className="text-muted-foreground">
                  {t("methodLabel")}
                </Label>
                <div className="grid grid-cols-2 gap-2">
                  {METHODS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMethod(m)}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition",
                        method === m
                          ? "border-primary bg-primary/5 text-foreground ring-1 ring-primary/30"
                          : "border-border text-muted-foreground hover:border-primary/40",
                      )}
                    >
                      {m === "visa_mastercard" ? (
                        <CreditCard className="size-4 shrink-0" />
                      ) : (
                        <Smartphone className="size-4 shrink-0" />
                      )}
                      {t(`methods.${m}`)}
                    </button>
                  ))}
                </div>
              </div>

              {needsPhone && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="payPhone" className="text-muted-foreground">
                    {t("phoneLabel")}
                  </Label>
                  <Input
                    id="payPhone"
                    type="tel"
                    inputMode="tel"
                    placeholder={t("phonePlaceholder")}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="border-border bg-muted text-foreground"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("phoneHint")}
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-2">
                <Label htmlFor="payMonths" className="text-muted-foreground">
                  {t("monthsLabel")}
                </Label>
                <Input
                  id="payMonths"
                  type="number"
                  min={1}
                  max={36}
                  value={months}
                  onChange={(e) =>
                    setMonths(
                      Math.min(36, Math.max(1, Number(e.target.value) || 1)),
                    )
                  }
                  className="border-border bg-muted text-foreground"
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-4 py-3">
                <span className="text-sm text-muted-foreground">
                  {t("totalLabel")}
                </span>
                <span className="text-lg font-bold text-foreground">
                  {formatCurrency(total, plan.currency)}
                </span>
              </div>

              <Button
                onClick={charge}
                disabled={needsPhone && phone.trim().length < 9}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {method === "visa_mastercard"
                  ? t("payCard", { amount: formatCurrency(total, plan.currency) })
                  : t("payPush", { amount: formatCurrency(total, plan.currency) })}
              </Button>

              <p className="text-center text-xs text-muted-foreground">
                {t("secureNote")}
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

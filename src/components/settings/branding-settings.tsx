"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Upload, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { isValidHex } from "@/lib/brand-color";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const MAX_BYTES = 2 * 1024 * 1024; // must match the bucket's file_size_limit
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

/** A handful of clinic-appropriate starting points for the picker grid. */
const COLOR_PRESETS = [
  "#2563eb", // azul clínico
  "#0d9488", // verde-azulado
  "#16a34a", // verde saúde
  "#7c3aed", // violeta
  "#dc2626", // vermelho
  "#ea580c", // laranja
  "#0891b2", // ciano
  "#4f46e5", // índigo
];

/**
 * White-label branding: the account's logo and product name.
 *
 * The logo replaces the app mark everywhere <BrandMark> renders it —
 * sidebar, header, and the page title. Admin-only, enforced twice: the
 * form is read-only for non-admins here, and the `accounts_update` +
 * storage RLS policies reject the write server-side regardless.
 */
export function BrandingSettings() {
  const t = useTranslations("Settings.branding");
  const { account, canEditSettings, refreshProfile } = useAuth();
  const supabase = createClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [brandName, setBrandName] = useState(account?.brand_name ?? "");
  const [corPrimaria, setCorPrimaria] = useState(account?.cor_primaria ?? "");
  const [preview, setPreview] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [saving, setSaving] = useState(false);

  const trimmedColor = corPrimaria.trim();
  const colorIsInvalid = trimmedColor.length > 0 && !isValidHex(trimmedColor);

  const currentLogo = removeLogo ? null : (preview ?? account?.logo_url ?? null);

  const handlePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ACCEPTED.includes(file.type)) {
      toast.error(t("unsupportedImage"));
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error(t("imageTooLarge"));
      return;
    }

    setPendingFile(file);
    setRemoveLogo(false);
    setPreview(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    if (!account?.id) return;
    if (colorIsInvalid) {
      toast.error(t("invalidColor"));
      return;
    }
    setSaving(true);

    try {
      let nextLogoUrl: string | null = account.logo_url ?? null;

      if (pendingFile) {
        // Path's first segment must be the ACCOUNT id — the storage
        // policies in migration 038 key off it to check admin membership.
        const ext = pendingFile.name.split(".").pop() ?? "png";
        const path = `${account.id}/logo-${Date.now()}.${ext}`;

        const { error: uploadError } = await supabase.storage
          .from("branding")
          .upload(path, pendingFile, {
            cacheControl: "3600",
            upsert: true,
            contentType: pendingFile.type,
          });

        if (uploadError) throw new Error(uploadError.message);

        const {
          data: { publicUrl },
        } = supabase.storage.from("branding").getPublicUrl(path);
        nextLogoUrl = publicUrl;
      } else if (removeLogo) {
        nextLogoUrl = null;
      }

      const { error } = await supabase
        .from("accounts")
        .update({
          logo_url: nextLogoUrl,
          brand_name: brandName.trim() || null,
          cor_primaria: trimmedColor || null,
        })
        .eq("id", account.id);

      if (error) throw new Error(error.message);

      setPendingFile(null);
      setPreview(null);
      setRemoveLogo(false);
      await refreshProfile();
      toast.success(t("saved"));
    } catch (err) {
      toast.error(
        t("saveFailed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="text-foreground">{t("title")}</CardTitle>
        <CardDescription className="text-muted-foreground">
          {t("description")}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {!canEditSettings && (
          <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
            {t("adminOnly")}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground">{t("logoLabel")}</Label>

          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
              {currentLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={currentLogo}
                  alt={t("logoLabel")}
                  className="h-full w-full object-contain"
                />
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t("noLogo")}
                </span>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPTED.join(",")}
                onChange={handlePick}
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                disabled={!canEditSettings || saving}
                onClick={() => fileRef.current?.click()}
                className="border-border"
              >
                <Upload className="mr-2 h-4 w-4" />
                {t("uploadLogo")}
              </Button>

              {currentLogo && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canEditSettings || saving}
                  onClick={() => {
                    setPendingFile(null);
                    setPreview(null);
                    setRemoveLogo(true);
                  }}
                  className="border-border text-muted-foreground"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("removeLogo")}
                </Button>
              )}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{t("logoHint")}</p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="brandName" className="text-muted-foreground">
            {t("brandNameLabel")}
          </Label>
          <Input
            id="brandName"
            value={brandName}
            disabled={!canEditSettings || saving}
            onChange={(e) => setBrandName(e.target.value)}
            placeholder={t("brandNamePlaceholder")}
            className="border-border bg-muted text-foreground"
          />
          <p className="text-xs text-muted-foreground">{t("brandNameHint")}</p>
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground">{t("colorLabel")}</Label>

          <div className="flex flex-wrap items-center gap-2">
            {COLOR_PRESETS.map((hex) => (
              <button
                key={hex}
                type="button"
                title={hex}
                disabled={!canEditSettings || saving}
                onClick={() => setCorPrimaria(hex)}
                className="h-8 w-8 shrink-0 rounded-full border-2 transition"
                style={{
                  backgroundColor: hex,
                  borderColor:
                    trimmedColor.toLowerCase() === hex ? "var(--foreground)" : "transparent",
                }}
                aria-label={t("useColor", { color: hex })}
              />
            ))}

            <input
              type="color"
              value={isValidHex(trimmedColor) ? trimmedColor : "#2563eb"}
              disabled={!canEditSettings || saving}
              onChange={(e) => setCorPrimaria(e.target.value)}
              className="h-8 w-8 shrink-0 cursor-pointer rounded-full border border-border bg-transparent p-0"
              aria-label={t("customColor")}
            />

            <Input
              value={corPrimaria}
              disabled={!canEditSettings || saving}
              onChange={(e) => setCorPrimaria(e.target.value)}
              placeholder="#2563eb"
              className="w-32 border-border bg-muted font-mono text-foreground"
            />

            {trimmedColor && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canEditSettings || saving}
                onClick={() => setCorPrimaria("")}
                className="border-border text-muted-foreground"
              >
                {t("resetColor")}
              </Button>
            )}
          </div>

          {colorIsInvalid && (
            <p className="text-xs text-red-400">{t("invalidColor")}</p>
          )}
          <p className="text-xs text-muted-foreground">{t("colorHint")}</p>
        </div>

        <div>
          <Button
            onClick={handleSave}
            disabled={!canEditSettings || saving || colorIsInvalid}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? t("saving") : t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

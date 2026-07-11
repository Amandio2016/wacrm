"use client";

import { MessageSquare } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

interface BrandMarkProps {
  /** Fallback product name when the account hasn't set a brand_name. */
  fallbackName: string;
  /** Hide the wordmark and render the logo tile alone. */
  iconOnly?: boolean;
  className?: string;
}

/**
 * The account's logo + product name, used everywhere the app used to
 * hardcode its own mark (sidebar, header, and — via BrandMarkStatic —
 * the signed-out auth pages).
 *
 * White-label rule: if the account uploaded a logo we render that
 * image; otherwise we fall back to the app's own icon tile, so a fresh
 * account with no branding still looks finished rather than broken.
 *
 * The <img> is deliberately plain rather than next/image: the src is a
 * Supabase public-bucket URL on a per-tenant hostname, which would
 * need remotePatterns config for every deployment. A logo is a few KB;
 * the optimiser buys us nothing here.
 */
export function BrandMark({
  fallbackName,
  iconOnly = false,
  className,
}: BrandMarkProps) {
  const { account } = useAuth();
  const logoUrl = account?.logo_url ?? null;
  const name = account?.brand_name?.trim() || fallbackName;

  return (
    <span className={cn("flex items-center gap-2", className)}>
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={name}
          className="h-8 w-8 shrink-0 rounded-lg object-contain"
        />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <MessageSquare className="h-4 w-4" />
        </span>
      )}
      {!iconOnly && (
        <span className="truncate text-sm font-semibold text-foreground">
          {name}
        </span>
      )}
    </span>
  );
}

"use client";

import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  isValidHex,
  buildPrimaryOverrides,
  PRIMARY_OVERRIDE_VARS,
} from "@/lib/brand-color";

/**
 * Applies the logged-in account's white-label primary colour on top
 * of the ordinary theme system, by setting inline CSS custom
 * properties on <html> — inline styles win over the `data-theme`
 * stylesheet rules without touching them.
 *
 * Renders nothing; mount once inside the authed shell (see
 * dashboard-shell.tsx). No cleanup-on-unmount: the only way out of the
 * dashboard is `window.location.href = "/login"` (use-auth.tsx
 * signOut), a full page load that resets all inline styles for free.
 * An account with no cor_primaria removes any override so the plain
 * theme picker shows through unchanged.
 */
export function BrandThemeStyle() {
  const { account } = useAuth();
  const color = account?.cor_primaria ?? null;

  useEffect(() => {
    const root = document.documentElement;
    if (isValidHex(color)) {
      for (const [key, value] of Object.entries(buildPrimaryOverrides(color))) {
        root.style.setProperty(key, value);
      }
    } else {
      for (const key of PRIMARY_OVERRIDE_VARS) root.style.removeProperty(key);
    }
  }, [color]);

  return null;
}

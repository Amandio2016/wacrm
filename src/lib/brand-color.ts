/**
 * Per-account white-label primary colour.
 *
 * The app's own theme system (`lib/themes.ts`) offers five fixed
 * OKLCH accent palettes toggled via `data-theme` on <html> — that
 * mechanism is device-scoped and author-curated, not what a clinic's
 * arbitrary hex `cor_primaria` needs. This module derives the SAME
 * variable set a theme block defines, from one hex, using CSS
 * `color-mix()` so the browser does the colour math — no OKLCH
 * conversion needed in JS, and it stays correct for any input hue.
 *
 * When the account has no `cor_primaria`, callers should remove these
 * overrides entirely and let the ordinary theme picker show through.
 */

/** Matches the DB CHECK constraint on accounts.cor_primaria (041). */
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidHex(value: string | null | undefined): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** WCAG relative luminance of an sRGB channel (0-255 → linear 0-1). */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio between two relative luminances, 1 to 21. */
function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Pick whichever of pure white or near-black gives better contrast
 * against `hex`, so text on a primary-coloured button stays legible
 * regardless of how light or dark the clinic's colour is.
 */
export function bestForeground(hex: string): "#ffffff" | "#0a0a0a" {
  const bg = relativeLuminance(hex);
  const white = contrastRatio(bg, 1);
  const black = contrastRatio(bg, 0);
  return white >= black ? "#ffffff" : "#0a0a0a";
}

/** The CSS custom properties a theme block sets for its primary colour. */
export const PRIMARY_OVERRIDE_VARS = [
  "--primary",
  "--primary-foreground",
  "--primary-hover",
  "--primary-soft",
  "--primary-soft-2",
  "--ring",
  "--chart-1",
  "--sidebar-primary",
] as const;

/**
 * Build the override map for a given hex. Values for the derived
 * variables are `color-mix()` expressions — resolved by the browser at
 * paint time, not computed here, so they track the exact input hue.
 */
export function buildPrimaryOverrides(hex: string): Record<string, string> {
  return {
    "--primary": hex,
    "--primary-foreground": bestForeground(hex),
    // Slightly darker for :hover, same idea as the hand-picked
    // per-theme --primary-hover values in globals.css.
    "--primary-hover": `color-mix(in srgb, ${hex} 85%, black)`,
    "--primary-soft": `color-mix(in srgb, ${hex} 12%, transparent)`,
    "--primary-soft-2": `color-mix(in srgb, ${hex} 20%, transparent)`,
    "--ring": hex,
    "--chart-1": hex,
    "--sidebar-primary": hex,
  };
}

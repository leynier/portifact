// The owner's accent color on a branded viewer bar (premium plan P9) and the tokens derived
// from it. The accent is one sRGB color an owner chose; it is never applied to text. It only
// fills the brand chip, whose text (the ink) is black or white, whichever contrasts more with the
// accent. For any sRGB color one of the two reaches at least 4.58:1 (the worst case is a
// luminance of about 0.179, where both are equal), so every color passes WCAG AA for normal text
// and none is clamped or refused. The chip's colors do not depend on the theme, and what sits
// next to it on the bar keeps the theme's own tokens.
import { contrast } from "./tokens.ts";

const HEX = /^#[0-9a-f]{6}$/i;

export interface BrandPalette {
  /** The accent as `#rrggbb`, lowercase: the chip's background. */
  accent: string;
  /** The ink of text and icons on the accent. */
  ink: "dark" | "light";
  /** The contrast of the ink on the accent, at least 4.5. */
  inkContrast: number;
}

/** The palette for an accent, or null for anything that is not one `#rrggbb` color. */
export function brandPalette(accent: string | null | undefined): BrandPalette | null {
  if (!accent || !HEX.test(accent)) return null;
  const value = accent.toLowerCase();
  const onDark = contrast(value, "#000000");
  const onLight = contrast(value, "#ffffff");
  return onDark >= onLight
    ? { accent: value, ink: "dark", inkContrast: onDark }
    : { accent: value, ink: "light", inkContrast: onLight };
}

/** The custom properties a branded element sets through the CSSOM (`--pf-brand-*`). */
export function brandProperties(palette: BrandPalette): Record<string, string> {
  return {
    "--pf-brand-accent": palette.accent,
    "--pf-brand-ink": palette.ink === "dark" ? "var(--pf-neutral-1000)" : "var(--pf-neutral-0)",
  };
}

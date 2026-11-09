// Email colors and type, taken from the design tokens (docs/design.md, "Palette"). Mail clients do
// not resolve CSS custom properties reliably, so the semantic tokens are resolved to their values
// once here and written inline; dark mode repeats them in a media query for clients that honor it.
import { resolveColors, type Theme } from "@portifact/ui/tokens";
import { TOKENS_CSS } from "@portifact/ui/tokens-css";

export interface EmailPalette {
  /** The page behind the card. */
  page: string;
  card: string;
  border: string;
  text: string;
  muted: string;
  /** The panel that holds a code or a command. */
  panel: string;
  panelBorder: string;
}

function palette(theme: Theme): EmailPalette {
  const colors = resolveColors(TOKENS_CSS, theme);
  const color = (name: string): string => {
    const value = colors.get(name);
    if (!value) throw new Error(`token --pf-color-${name} is missing`);
    return value;
  };
  return {
    page: color("surface"),
    card: color(theme === "light" ? "canvas" : "surface-raised"),
    border: color("border"),
    text: color("text"),
    muted: color("text-muted"),
    panel: color(theme === "light" ? "surface" : "canvas"),
    panelBorder: color(theme === "light" ? "border" : "selection"),
  };
}

export const LIGHT = palette("light");
export const DARK = palette("dark");

/** Font stacks without quotes inside, so they fit in a double-quoted style attribute. */
export const FONT_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
/**
 * System fonts for Chinese and Japanese text, after the Latin ones so Latin text keeps them.
 * Each language gets its own first, since the same characters are drawn differently in each.
 */
const CJK_FONTS: Readonly<Record<string, string>> = {
  ja: "'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, 'Noto Sans CJK JP', 'Noto Sans JP'",
  "zh-CN":
    "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC'",
};

/** The sans-serif stack for an email in a language: `FONT_SANS`, with CJK fonts when needed. */
export function fontSans(lang: string | undefined): string {
  const cjk = lang === undefined ? undefined : CJK_FONTS[lang];
  return cjk ? FONT_SANS.replace(/, sans-serif$/, `, ${cjk}, sans-serif`) : FONT_SANS;
}

export const FONT_MONO = "SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/** The hosted wordmarks (apps/web/vite.config.ts publishes them from assets/brand). */
export const WORDMARK = {
  light: "https://portifact.com/brand/wordmark.png",
  dark: "https://portifact.com/brand/wordmark-dark.png",
  width: 120,
  height: 30,
} as const;

// Reads the design tokens from tokens.css so they can be checked by tests and scripts.

export type Theme = "light" | "dark";

const HEX = /^#[0-9a-f]{6}$/i;

/** Parses `--name: value;` declarations inside the CSS block that starts at `selector`. */
function declarations(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Block "${selector}" not found in tokens.css`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  const result = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    result.set(String(match[1]), String(match[2]).trim());
  }
  return result;
}

/** Resolves every semantic `--pf-color-*` token of a theme to its hex value. */
export function resolveColors(css: string, theme: Theme): Map<string, string> {
  const primitives = declarations(css, ":root {");
  const semantic = declarations(css, theme === "light" ? ":root,\n" : '[data-theme="dark"]');
  const colors = new Map<string, string>();
  for (const [name, value] of semantic) {
    if (!name.startsWith("--pf-color-")) continue;
    const reference = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
    const resolved = reference ? primitives.get(reference) : value;
    if (!resolved || !HEX.test(resolved)) {
      throw new Error(`${theme} ${name} does not resolve to a hex color: ${value}`);
    }
    colors.set(name.replace("--pf-color-", ""), resolved.toLowerCase());
  }
  return colors;
}

/** Hex colors declared anywhere in the CSS. */
export function allHexColors(css: string): string[] {
  return [...css.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => match[0].toLowerCase());
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 contrast ratio between two hex colors. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** True when a hex color has no hue: red, green and blue are equal. */
export function isNeutral(hex: string): boolean {
  const value = hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;
  const [r, g, b] = [1, 3, 5].map((i) => value.slice(i, i + 2).toLowerCase());
  return r === g && g === b;
}

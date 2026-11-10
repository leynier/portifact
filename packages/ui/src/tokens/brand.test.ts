import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brandPalette, brandProperties } from "./brand.ts";
import { contrast, resolveColors, type Theme } from "./tokens.ts";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const themes: Theme[] = ["light", "dark"];
const INK = { dark: "#000000", light: "#ffffff" } as const;

describe("brandPalette", () => {
  it.each([
    // Extremes and the colors where black and white are closest to each other.
    ["#000000", "light"],
    ["#ffffff", "dark"],
    ["#777777", "dark"],
    ["#767676", "dark"],
    ["#757575", "light"],
    ["#ff0000", "dark"],
    ["#00ff00", "dark"],
    ["#0000ff", "light"],
    ["#ffff00", "dark"],
    ["#00ffff", "dark"],
    ["#ff00ff", "dark"],
    ["#1a2b3c", "light"],
    ["#e5e5e5", "dark"],
    ["#141414", "light"],
    ["#0f62fe", "light"],
    ["#FF8800", "dark"],
  ] as const)("%s gets %s ink at AA contrast, the same in both themes", (accent, ink) => {
    const palette = brandPalette(accent);
    expect(palette).toEqual({
      accent: accent.toLowerCase(),
      ink,
      inkContrast: contrast(accent.toLowerCase(), INK[ink]),
    });
    for (const theme of themes) {
      const colors = resolveColors(css, theme);
      // The chip's text is the ink on the accent, whatever the theme.
      expect(contrast(INK[ink], accent.toLowerCase()), theme).toBeGreaterThanOrEqual(4.5);
      // What sits next to the chip on the bar keeps the theme's own tokens.
      expect(
        contrast(colors.get("text") as string, colors.get("canvas") as string),
      ).toBeGreaterThanOrEqual(7);
      expect(
        contrast(colors.get("focus") as string, colors.get("canvas") as string),
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("gives every sRGB color an ink of at least 4.5:1, so none is clamped or refused", () => {
    let worst = Number.POSITIVE_INFINITY;
    for (let r = 0; r < 256; r += 5) {
      for (let g = 0; g < 256; g += 5) {
        for (let b = 0; b < 256; b += 5) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
          const palette = brandPalette(hex);
          if (!palette) throw new Error(hex);
          worst = Math.min(worst, palette.inkContrast);
        }
      }
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
    expect(worst).toBeLessThan(4.7);
  });

  it.each([
    null,
    undefined,
    "",
    "red",
    "#fff",
    "#12345",
    "#1234567",
    "#gggggg",
    "rgb(0,0,0)",
    " #000000",
    "#00000080",
  ])("refuses %j", (value) => {
    expect(brandPalette(value)).toBeNull();
  });

  it("sets the accent and the ink as custom properties, the ink from the neutral scale", () => {
    expect(brandProperties({ accent: "#0000ff", ink: "light", inkContrast: 8.6 })).toEqual({
      "--pf-brand-accent": "#0000ff",
      "--pf-brand-ink": "var(--pf-neutral-0)",
    });
    expect(brandProperties({ accent: "#ffff00", ink: "dark", inkContrast: 19 })).toEqual({
      "--pf-brand-accent": "#ffff00",
      "--pf-brand-ink": "var(--pf-neutral-1000)",
    });
  });
});

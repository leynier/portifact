import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allHexColors, contrast, isNeutral, resolveColors, type Theme } from "./tokens.ts";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const themes: Theme[] = ["light", "dark"];

describe("design tokens", () => {
  it("only declares neutral colors, so the palette stays monochromatic", () => {
    const colors = allHexColors(css);
    expect(colors.length).toBeGreaterThan(10);
    expect(colors.filter((hex) => !isNeutral(hex))).toEqual([]);
  });

  it("defines the same semantic tokens in both themes", () => {
    const light = [...resolveColors(css, "light").keys()].sort();
    const dark = [...resolveColors(css, "dark").keys()].sort();
    expect(dark).toEqual(light);
    expect(light).toContain("text");
    expect(light).toContain("canvas");
  });

  it("keeps the dark theme in the media query identical to the forced dark theme", () => {
    const media = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    const mediaBody = media.slice(media.indexOf("{", media.indexOf(":root:not")) + 1);
    const mediaDecls = mediaBody.slice(0, mediaBody.indexOf("}")).replace(/\s+/g, " ").trim();
    const forced = css.slice(css.indexOf('[data-theme="dark"]'));
    const forcedDecls = forced
      .slice(forced.indexOf("{") + 1, forced.indexOf("}"))
      .replace(/\s+/g, " ")
      .trim();
    expect(mediaDecls).toBe(forcedDecls);
  });

  for (const theme of themes) {
    describe(`${theme} theme`, () => {
      const c = resolveColors(css, theme);
      const get = (name: string) => {
        const value = c.get(name);
        if (!value) throw new Error(`missing token ${name}`);
        return value;
      };

      it("meets WCAG AA for body and muted text on every surface", () => {
        for (const surface of ["canvas", "surface", "surface-raised"]) {
          expect(contrast(get("text"), get(surface))).toBeGreaterThanOrEqual(7);
          expect(contrast(get("text-muted"), get(surface))).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(get("text-inverse"), get("surface-inverse"))).toBeGreaterThanOrEqual(7);
      });

      it("keeps selected text readable", () => {
        expect(contrast(get("text"), get("selection"))).toBeGreaterThanOrEqual(4.5);
      });

      it("keeps terminal text readable and the terminal distinct from the canvas", () => {
        expect(contrast(get("terminal-text"), get("terminal"))).toBeGreaterThanOrEqual(7);
        expect(contrast(get("terminal-muted"), get("terminal"))).toBeGreaterThanOrEqual(4.5);
        expect(get("terminal")).not.toBe(get("canvas"));
      });

      it("gives focus rings and strong borders at least 3:1 against the canvas", () => {
        expect(contrast(get("focus"), get("canvas"))).toBeGreaterThanOrEqual(3);
        expect(contrast(get("border-strong"), get("canvas"))).toBeGreaterThanOrEqual(3);
      });
    });
  }
});

describe("token helpers", () => {
  it("computes known contrast ratios", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrast("#767676", "#ffffff")).toBeGreaterThan(4.5);
  });

  it("detects hue in colors", () => {
    expect(isNeutral("#3a3a3a")).toBe(true);
    expect(isNeutral("#fff")).toBe(true);
    expect(isNeutral("#0f1115")).toBe(false);
  });

  it("resolves literal hex values and ignores non-color tokens", () => {
    const css =
      ':root {\n  --pf-neutral-0: #ffffff;\n}\n:root,\n[data-theme="light"] {\n  color-scheme: light;\n  --pf-color-text: #000000;\n  --pf-color-canvas: var(--pf-neutral-0);\n}';
    expect(Object.fromEntries(resolveColors(css, "light"))).toEqual({
      text: "#000000",
      canvas: "#ffffff",
    });
  });

  it("rejects semantic tokens that do not resolve to a hex color", () => {
    const broken =
      ':root {\n  --pf-neutral-0: #ffffff;\n}\n:root,\n[data-theme="light"] {\n  --pf-color-text: var(--pf-missing);\n}\n[data-theme="dark"] {}';
    expect(() => resolveColors(broken, "light")).toThrow("does not resolve");
    expect(() => resolveColors("nothing here", "light")).toThrow("not found");
  });
});

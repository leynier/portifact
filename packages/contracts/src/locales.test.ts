import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, isLocale, LOCALE_CODES, LOCALES, localeInfo } from "./locales.ts";

describe("locales", () => {
  it("lists English first as the default, then the other languages, each by its own name", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(LOCALE_CODES).toEqual(["en", "es", "pt-BR", "fr", "de", "ru", "ja", "zh-CN"]);
    expect(LOCALES.map((locale) => locale.name)).toEqual([
      "English",
      "Español",
      "Português (Brasil)",
      "Français",
      "Deutsch",
      "Русский",
      "日本語",
      "简体中文",
    ]);
    expect(LOCALES.every((locale) => locale.dir === "ltr")).toBe(true);
  });

  it("knows only the listed codes, exactly", () => {
    expect(isLocale("es")).toBe(true);
    expect(isLocale("ES")).toBe(false);
    expect(isLocale("es-MX")).toBe(false);
    expect(isLocale("zh-CN")).toBe(true);
    expect(isLocale("zh-cn")).toBe(false);
    expect(isLocale("pt")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(1)).toBe(false);
  });

  it("gives each locale's direction and name", () => {
    expect(localeInfo("es")).toEqual({ code: "es", name: "Español", dir: "ltr" });
    expect(localeInfo("en").dir).toBe("ltr");
  });

  it("uses well-formed, unique BCP 47 tags", () => {
    expect(new Set(LOCALE_CODES).size).toBe(LOCALE_CODES.length);
    for (const code of LOCALE_CODES) {
      expect(Intl.getCanonicalLocales(code)).toEqual([code]);
    }
  });
});

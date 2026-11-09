import { describe, expect, it } from "vitest";
import { matchLocale, negotiateLocale, parseAcceptLanguage, resolveLocale } from "./locale.ts";

// A wider list than the shipped one, so the matching rules are checked for the languages that
// are planned next. The type only allows shipped codes, so the extra ones are cast.
const PLANNED = ["en", "es", "pt-BR", "zh-CN", "fr"] as unknown as readonly ("en" | "es")[];

describe("matchLocale", () => {
  it("matches a supported tag exactly, ignoring case and underscores", () => {
    expect(matchLocale("es")).toBe("es");
    expect(matchLocale("EN")).toBe("en");
    expect(matchLocale(" es ")).toBe("es");
    expect(matchLocale("pt_br", PLANNED)).toBe("pt-BR");
  });

  it("falls back to the first locale of the same language", () => {
    expect(matchLocale("es-MX")).toBe("es");
    expect(matchLocale("es-419")).toBe("es");
    expect(matchLocale("en-GB")).toBe("en");
    expect(matchLocale("pt", PLANNED)).toBe("pt-BR");
    expect(matchLocale("pt-PT", PLANNED)).toBe("pt-BR");
  });

  it("does not answer Traditional Chinese with a Simplified Chinese catalog", () => {
    expect(matchLocale("zh", PLANNED)).toBe("zh-CN");
    expect(matchLocale("zh-SG", PLANNED)).toBe("zh-CN");
    expect(matchLocale("zh-Hans-CN", PLANNED)).toBe("zh-CN");
    expect(matchLocale("zh-TW", PLANNED)).toBeUndefined();
    expect(matchLocale("zh-Hant", PLANNED)).toBeUndefined();
    expect(matchLocale("zh-HK", PLANNED)).toBeUndefined();
    expect(matchLocale("zh-MO", PLANNED)).toBeUndefined();
  });

  it("matches nothing for unsupported, empty or wildcard tags", () => {
    expect(matchLocale("de")).toBeUndefined();
    expect(matchLocale("")).toBeUndefined();
    expect(matchLocale("*")).toBeUndefined();
    // A language whose code only starts like a supported one is another language.
    expect(matchLocale("est")).toBeUndefined();
  });
});

describe("negotiateLocale", () => {
  it("takes the first supported language in the reader's order", () => {
    expect(negotiateLocale(["de-DE", "es-AR", "en"])).toBe("es");
    expect(negotiateLocale(["en-US", "es"])).toBe("en");
  });

  it("finds nothing when no language is supported", () => {
    expect(negotiateLocale(["de", "ja"])).toBeUndefined();
    expect(negotiateLocale([])).toBeUndefined();
  });
});

describe("parseAcceptLanguage", () => {
  it("orders tags by weight and keeps the order of equal weights", () => {
    expect(parseAcceptLanguage("de;q=0.5, es-MX, en;q=0.8, fr")).toEqual([
      "es-MX",
      "fr",
      "en",
      "de",
    ]);
  });

  it("drops refused, empty and malformed entries", () => {
    expect(parseAcceptLanguage("es;q=0, en;q=abc, , fr;q=0.1")).toEqual(["fr"]);
    expect(parseAcceptLanguage("es ; q=0.9 ;x=1")).toEqual(["es"]);
  });

  it("reads nothing from a missing header", () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
  });
});

describe("resolveLocale", () => {
  it("prefers the first explicit choice that is supported", () => {
    expect(resolveLocale({ chosen: ["es", "en"], browser: ["en"] })).toBe("es");
    expect(resolveLocale({ chosen: [null, undefined, "xx", "en"], browser: ["es"] })).toBe("en");
  });

  it("uses the browser's languages without a choice", () => {
    expect(resolveLocale({ chosen: [null], browser: ["es-CL", "en"] })).toBe("es");
  });

  it("falls back to English when nothing matches", () => {
    expect(resolveLocale({ chosen: [], browser: ["ja"] })).toBe("en");
    expect(resolveLocale({ chosen: [""], browser: [] })).toBe("en");
  });
});

import { describe, expect, it } from "vitest";
import { matchLocale, negotiateLocale, parseAcceptLanguage, resolveLocale } from "./locale.ts";

describe("matchLocale", () => {
  it("matches a supported tag exactly, ignoring case and underscores", () => {
    expect(matchLocale("es")).toBe("es");
    expect(matchLocale("EN")).toBe("en");
    expect(matchLocale(" es ")).toBe("es");
    expect(matchLocale("pt_br")).toBe("pt-BR");
  });

  it("falls back to the first locale of the same language", () => {
    expect(matchLocale("es-MX")).toBe("es");
    expect(matchLocale("es-419")).toBe("es");
    expect(matchLocale("en-GB")).toBe("en");
    expect(matchLocale("pt")).toBe("pt-BR");
    expect(matchLocale("pt-PT")).toBe("pt-BR");
  });

  it("does not answer Traditional Chinese with a Simplified Chinese catalog", () => {
    expect(matchLocale("zh")).toBe("zh-CN");
    expect(matchLocale("zh-SG")).toBe("zh-CN");
    expect(matchLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(matchLocale("zh-TW")).toBeUndefined();
    expect(matchLocale("zh-Hant")).toBeUndefined();
    expect(matchLocale("zh-HK")).toBeUndefined();
    expect(matchLocale("zh-MO")).toBeUndefined();
  });

  it("matches nothing for unsupported, empty or wildcard tags", () => {
    expect(matchLocale("it")).toBeUndefined();
    expect(matchLocale("ko")).toBeUndefined();
    expect(matchLocale("")).toBeUndefined();
    expect(matchLocale("*")).toBeUndefined();
    // A language whose code only starts like a supported one is another language.
    expect(matchLocale("est")).toBeUndefined();
  });
});

describe("negotiateLocale", () => {
  it("takes the first supported language in the reader's order", () => {
    expect(negotiateLocale(["it-IT", "es-AR", "en"])).toBe("es");
    expect(negotiateLocale(["zh-TW", "ja-JP", "en"])).toBe("ja");
    expect(negotiateLocale(["en-US", "es"])).toBe("en");
  });

  it("finds nothing when no language is supported", () => {
    expect(negotiateLocale(["it", "ko"])).toBeUndefined();
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
    expect(resolveLocale({ chosen: [], browser: ["ko"] })).toBe("en");
    expect(resolveLocale({ chosen: [""], browser: [] })).toBe("en");
  });
});
